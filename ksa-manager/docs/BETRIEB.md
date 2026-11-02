# Betrieb: Backup, Wiederherstellung, Updates, Aufbewahrung

## Daten und Speicherorte

| Was | Wo | Hinweis |
|---|---|---|
| Datenbank | `data/ksa.sqlite` (+ `ksa.sqlite-wal`, `ksa.sqlite-shm`) | SQLite im WAL-Modus. Alle drei Dateien gehören zusammen. |
| Proof-Bilder bis zur Veröffentlichung | `data/proofs/<id>/` | bereinigt (ohne Metadaten), werden nach Veröffentlichung, Verwerfen oder Fristablauf gelöscht |
| Backups | `backups/` (lokal) bzw. `/app/data/backups` (Docker) | nicht öffentlich, Dateirechte 0600 |
| Logs | Standardausgabe (JSON) | ohne Tokens, Nachrichteninhalte und signierte Anhang-URLs |

Alle Dateien legt der Bot mit `umask 077` an, sie sind also nur für den Bot-Nutzer lesbar. `.env`, Datenbanken, Exporte, Backups und ZIPs sind über `.gitignore` von Git ausgeschlossen. Ticket-Exporte werden **nie** gespeichert, sondern nur ephemer an die anfragende Person gesendet.

## Backup (konsistent, inklusive WAL)

**Kopiere die `.sqlite`-Datei nicht einfach während des Betriebs.** Ohne die WAL-Datei kann die Kopie unvollständig sein. Nutze stattdessen das Backup-Skript. Es verwendet die Online-Backup-API von SQLite, berücksichtigt den WAL-Inhalt, schreibt eine eigenständige Einzeldatei und prüft sie mit `PRAGMA integrity_check`.

```bash
# lokal (Bot darf weiterlaufen)
npm run backup                 # → ./backups/ksa-<Zeitstempel>.sqlite
npm run backup -- /pfad/zum/ziel

# Docker
docker compose exec ksa-manager node dist/scripts/backup.js /app/data/backups
docker compose cp ksa-manager:/app/data/backups ./backups
```

Empfehlung: täglich per Cron bzw. Aufgabenplanung sichern und Backups verschlüsselt außerhalb des Servers aufbewahren. Beispiel-Crontab (lokal):

```
17 4 * * * cd /opt/ksa-manager && /usr/bin/npm run backup >> backups/backup.log 2>&1
```

Ältere Backups löscht ihr selbst gemäß eurer Aufbewahrungsregeln.

## Wiederherstellung

1. Bot stoppen: `Strg+C` bzw. `docker compose down`. Der Bot fährt sauber herunter (laufende Interaktionen werden abgeschlossen, Heartbeat wird gespeichert).
2. Aktuelle Daten sicherheitshalber wegsichern:
   ```bash
   mkdir -p data/alt && mv data/ksa.sqlite* data/alt/
   ```
3. Backup als neue Datenbank einsetzen. Es dürfen **keine** alten `-wal`/`-shm`-Dateien daneben liegen:
   ```bash
   cp backups/ksa-2026-11-02T04-17-00-000Z.sqlite data/ksa.sqlite
   chmod 600 data/ksa.sqlite
   ```
   Docker:
   ```bash
   docker compose run --rm --no-deps -v "$PWD/backups:/restore:ro" --entrypoint sh ksa-manager \
     -c 'rm -f /app/data/ksa.sqlite-wal /app/data/ksa.sqlite-shm && cp /restore/<DATEI>.sqlite /app/data/ksa.sqlite'
   ```
4. Bot starten. Migrationen laufen bei Bedarf automatisch. Danach `/setup diagnose` und `/health` ausführen.

Hinweis: Discord-seitige Änderungen seit dem Backup (neue Kanäle, gelöschte Nachrichten) sind nicht im Backup enthalten. `/setup diagnose` zeigt Abweichungen an.

## Updates

```bash
git pull                        # bzw. neue Projektdateien einspielen
npm ci && npm run build && npm start
# Docker:
docker compose up -d --build
```

Vor jedem Update ein Backup erstellen. Neue Migrationen werden beim Start automatisch und transaktional ausgeführt. Geänderte Slash-Befehle werden beim Start erkannt und neu registriert. Falls Panel-Texte geändert wurden: `/panel aktualisieren panel:alle` oder `/setup start`.

## Aufbewahrung (konfigurierbar)

Es werden **keine gesetzlichen Fristen vorgegeben**. Welche Fristen für euch gelten, müsst ihr selbst klären, zum Beispiel mit einer Steuer- oder Rechtsberatung. Standardmäßig löscht der Bot nichts automatisch, mit Ausnahme nicht veröffentlichter Proof-Bilder nach 30 Tagen.

| Einstellung (`/config setzen`) | Standard | Wirkung |
|---|---|---|
| `retention.archivedTicketDays` | 0 (aus) | löscht archivierte Ticketkanäle X Tage nach dem Schließen (Auftragsdaten bleiben) |
| `retention.proofStagingDays` | 30 | verwirft unveröffentlichte Proofs und löscht deren Bilddateien |
| `retention.closedOrderDays` | 0 (aus) | anonymisiert Aufträge X Tage nach Abschluss: interne Notizen und Freitexte werden gelöscht, Kunden-ID wird entfernt |
| `retention.auditDays` | 0 (aus) | löscht Audit-Einträge älter als X Tage |

Der Aufbewahrungslauf startet etwa eine Minute nach dem Start und danach alle 6 Stunden. Veröffentlichte Proof-Bilder liegen danach nur noch bei Discord. Lokale Kopien löscht der Bot direkt nach dem Upload.

## Logs

- Format: JSON (pino) auf stdout, Level über `LOG_LEVEL` (`info` empfohlen, `debug` zur Fehlersuche).
- Geschwärzt werden: Tokens, Nachrichteninhalte, Modal-Texte und signierte Anhang-URLs.
- Docker begrenzt die Logs auf 3 × 10 MB (siehe `docker-compose.yml`).

## Sauberes Herunterfahren

Bei `SIGINT`/`SIGTERM` nimmt der Bot keine neuen Interaktionen mehr an, wartet bis zu 10 Sekunden auf laufende Aktionen, stoppt die Hintergrundjobs, aktualisiert die Auftragsübersicht und speichert den letzten Heartbeat. Danach trennt er die Verbindung und schließt die Datenbank. Docker gibt dafür 30 Sekunden Zeit (`stop_grace_period`).

## Hosting

Der Bot braucht einen dauerhaft laufenden Rechner mit Internetzugang (ausgehend zu `discord.com` und `gateway.discord.gg`) und etwa 100–200 MB RAM. Eingehende Ports braucht er nicht. Möglich sind ein eigener PC, ein Raspberry Pi (arm64 wird von better-sqlite3 per Prebuild unterstützt) oder ein VPS. Wir empfehlen bewusst keinen bestimmten Anbieter. Prüft Preise und Bedingungen selbst und tragt den Token nur in die Secret-Verwaltung des Hosters ein.

Der Docker-Healthcheck meldet „unhealthy“, wenn seit 3 Minuten kein Heartbeat geschrieben wurde.
