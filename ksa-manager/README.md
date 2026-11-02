# KSA Manager – Discord-Bot für KSA Boosting

Der Bot richtet den Server **KSA Boosting** ein und organisiert Anfragen, Angebote, Aufträge, Proofs und Bewertungen für **Call of Duty: Warzone Ranked** und **Call of Duty: Multiplayer Ranked**. Außerdem bedankt er sich für Discord-Serverboosts.

Was der Bot ausdrücklich **nicht** tut:
- Er spielt nicht und greift nicht auf Spielaccounts zu.
- Er erfasst keine Passwörter, Session-Tokens, 2FA-Codes oder Zahlungsdaten.
- Er bietet keine Funktionen für Cheats, Matchmanipulation oder Anti-Cheat-Umgehung.
- Er wickelt keine Zahlungen ab. Der Zahlungsstatus wird nur manuell vom Team gesetzt.
- Er macht keine Versprechen wie „100 % sicher“ oder „bannfrei“.

> **Wichtig:** Discord-Serverboosts (💎・server-boosten) und bezahlte Ranked-Aufträge sind getrennte Bereiche. Ein Boost ist keine Zahlung und bringt keinen automatischen Rabatt.

---

## Inhalt

| Dokument | Wofür |
|---|---|
| [docs/ANLEITUNG.md](docs/ANLEITUNG.md) | Schritt für Schritt: Developer Portal, Einladung, Start, `/setup`, erste Tests |
| [docs/BERECHTIGUNGEN.md](docs/BERECHTIGUNGEN.md) | Bot-Rechte, Rollenhierarchie, Berechtigungsmatrix, Kanalsichtbarkeit |
| [docs/BETRIEB.md](docs/BETRIEB.md) | Backup und Wiederherstellung (inkl. WAL), Updates, Aufbewahrung, Logs, Hosting |
| [docs/SERVERBOOSTS.md](docs/SERVERBOOSTS.md) | Wie Boosts erkannt werden, Deduplizierung, Grenzen |
| [docs/PROOFS.md](docs/PROOFS.md) | Proof-Ablauf von der Ticketnachricht bis zum öffentlichen Beitrag |
| [docs/TESTCHECKLISTE.md](docs/TESTCHECKLISTE.md) | Manuelle Tests auf Discord für alle Rollen |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Fehlerbehebung |
| [docs/ARCHITEKTUR.md](docs/ARCHITEKTUR.md) | Aufbau, Datenmodell, Sicherheitskonzept |
| [docs/PANELS.md](docs/PANELS.md) | Die Panel-Texte so, wie das Setup sie postet (automatisch aus dem Code erzeugt) |

---

## Quickstart (Kurzfassung)

Voraussetzung ist Node.js 24 LTS (getestet mit 24.22.1; unterstützt ab 22.12) oder Docker. Die ausführliche Anleitung steht in [docs/ANLEITUNG.md](docs/ANLEITUNG.md).

```bash
# 1. Konfiguration anlegen und Token LOKAL eintragen (niemals im Chat teilen)
cp .env.example .env
#    -> DISCORD_TOKEN und DISCORD_CLIENT_ID eintragen

# 2a. Lokal starten
npm ci
npm run build
npm start

# 2b. Oder mit Docker
docker compose up -d --build
docker compose logs -f
```

Danach auf Discord als Founder `/setup start` ausführen, die Vorschau prüfen und bestätigen.

Einladungslink (ersetze `DEINE_APPLICATION_ID`). Er enthält die empfohlenen Rechte, **ohne Administrator**:

```
https://discord.com/oauth2/authorize?client_id=DEINE_APPLICATION_ID&scope=bot%20applications.commands&permissions=1477737442352
```

Nur die Pflichtrechte (ohne AutoMod/AFK/Flood-Timeout): `permissions=378225806352`. Details stehen in [docs/BERECHTIGUNGEN.md](docs/BERECHTIGUNGEN.md).

---

## Funktionen

**Servereinrichtung (`/setup start`, nur Founder)**
- Prüft den Zielserver, die Bot-Rechte und die Rollenhierarchie.
- Zeigt eine Vorschau aller Änderungen. Die Bestätigung gilt nur für dich, nur für diesen Server und nur für genau diese Vorschau; sie läuft nach 10 Minuten ab.
- Legt 9 Rollen, 9 Kategorien, 30 Kanäle, 13 Panels, 3 AutoMod-Regeln und den AFK-Kanal an.
- Ist idempotent: Ressourcen werden über gespeicherte IDs wiederverwendet. Nach einem Abbruch lässt sich das Setup fortsetzen, ohne Duplikate zu erzeugen. Bestehende Inhalte werden nie gelöscht, und gleichnamige fremde Kanäle oder Rollen werden nur mit `fremde_uebernehmen:true` übernommen.
- `/setup diagnose` zeigt fehlende Rechte sowie gelöschte, verschobene oder umbenannte Ressourcen und Rechteabweichungen. `/setup start korrigieren:true` repariert sie.

**Tickets**
- Panel mit „Warzone Ranked“, „Multiplayer Ranked“ und „Allgemeiner Support“.
- Ranked-Formular mit aktuellem Rang (optional SR), Zielrang, Plattform, Zeitraum und Zusatzangaben.
- Private Kanäle mit ausdrücklich gesetzten Rechten, die nie mit der Kategorie synchronisiert werden. Zugriff haben der Kunde, Support, Admin, Founder und der zugewiesene Operator.
- Buttons: Übernehmen, Zuweisen, Status ändern, Angebot erstellen, Proof einreichen, Schließen.
- Limit offener Tickets je Kunde, persistenter Cooldown, Doppelklickschutz, sichere Abläufe bei gleichzeitigen Aktionen, Wiederöffnen, private Exporte.
- Sauberes Verhalten, wenn Kanäle gelöscht werden oder Mitglieder den Server verlassen.

**Angebote und Aufträge**
- Ein Auftrag entsteht erst, wenn der Kunde ein konkretes, versioniertes Angebot annimmt (mit Rückfrage und Hash-Bindung).
- Jede Änderung braucht eine neue Angebotsversion und eine neue Zustimmung. Ältere Versionen werden ungültig.
- Statusmaschine: Anfrage → Angebot gesendet → Angebot angenommen → Wartet → In Bearbeitung ⇄ Pausiert → Abgeschlossen / Storniert.
- Der Zahlungsstatus ist davon getrennt (Offen, manuell bezahlt, teilweise erstattet, erstattet) und nur für Admins und Founder änderbar.
- Interne Notizen und ein vollständiger Änderungsverlauf. Notizen erscheinen nie in Kundenansichten, Proofs oder Kundenexporten.

**Proofs** (siehe [docs/PROOFS.md](docs/PROOFS.md))
- Auswahl über das Kontextmenü **Apps → Als Proof einreichen**, über `/proof einreichen` mit Nachrichtenlink oder über den Ticket-Button.
- Geprüft werden Ticket-Zugehörigkeit, Auftrag, Berechtigung, Team-Autor, Dateityp anhand der echten Signatur, Größe, Anzahl und Duplikate.
- Metadaten werden ohne Neukompression entfernt (EXIF, XMP, Kommentare, PNG-Textchunks).
- Der Kunde stimmt genau dieser Version zu, das Team gibt sie frei. Veröffentlicht wird automatisch erst nach Abschluss des Auftrags, standardmäßig anonym.
- Keine Doppel-Posts, auch nicht bei Abstürzen (Sperre, Statusübergang, Discord-`enforce_nonce`, Wiederaufnahme).
- Rücknahme durch Admins und Widerruf durch den Kunden, jeweils mit Audit-Eintrag.

**Bewertungen**
- Eine je abgeschlossenem Auftrag, 1–5 Sterne, optional mit Text. Veröffentlicht wird nur mit ausdrücklicher Zustimmung, anonym oder mit Anzeigenamen.
- Die Moderation kann Texte ausblenden, aber nie die Sterne ändern. Jede Aktion wird protokolliert.

**Discord-Serverboosts** (siehe [docs/SERVERBOOSTS.md](docs/SERVERBOOSTS.md))
- Danksagung bei zuverlässig erkannten neuen Boosts. Die Deduplizierung über Systemnachrichten und Member-Updates ist persistent; nach Neustarts gibt es keine falschen Danksagungen.
- Bevorzugt wird die von Discord verwaltete Booster-Rolle. Alternativ wird eine eigene kosmetische Rolle synchronisiert und nur bei bestätigtem Boost-Ende entfernt.

**Community**
- Begrüßung, Regelbestätigung (schaltet die Bereiche frei), Interessenrollen per Button.
- AutoMod-Regeln (Erwähnungs-Spam, Spam, Einladungslinks) und ein einfacher Flood-Schutz, der keine Inhalte speichert.

---

## Befehle

| Befehl | Unterbefehle | Wer |
|---|---|---|
| `/setup` | `start [korrigieren] [fremde_uebernehmen]`, `diagnose` | start: Founder · diagnose: Admin+ |
| `/health` | – | Support+ |
| `/help` | – | alle (zeigt nur erlaubte Befehle) |
| `/panel` | `aktualisieren panel:<…|alle>` | Admin+ |
| `/config` | `anzeigen`, `setzen`, `zuruecksetzen` | anzeigen: Admin+ · ändern: Founder |
| `/ticket` | `info`, `uebernehmen`, `zuweisen`, `schliessen`, `wiedereroeffnen`, `export`, `liste` | je nach Rolle |
| `/angebot` | `erstellen`, `ansehen`, `zurueckziehen` | erstellen/zurückziehen: Support+ |
| `/auftrag` | `ansehen`, `status`, `fortschritt`, `zahlung`, `notiz`, `liste` | zahlung: Admin+ · status/fortschritt/notiz: Support+ oder zugewiesener Operator |
| `/proof` | `einreichen`, `pruefen`, `freigeben`, `veroeffentlichen`, `zuruecknehmen`, `widerrufen` | siehe [BERECHTIGUNGEN](docs/BERECHTIGUNGEN.md) |
| `/bewertung` | `abgeben`, `ausblenden`, `einblenden`, `zurueckziehen` | abgeben/zurückziehen: Kunde · aus-/einblenden: Support+ |
| `/serverboost` | `status`, `sync`, `rollenmodus` | status/sync: Admin+ · rollenmodus: Founder |
| Kontextmenü | **Als Proof einreichen** | Support+ oder zugewiesener Operator |

Alle Befehle sind nur auf dem Zielserver registriert. Jede Aktion wird serverseitig geprüft; sichtbare oder versteckte Buttons sind keine Berechtigung.

---

## Projektstruktur

```
src/
  config/      Umgebungsvariablen (zod) und Laufzeit-Einstellungen (/config)
  logging/     Strukturierte JSON-Logs (pino), Schwärzung von Secrets
  db/          SQLite (better-sqlite3), WAL, versionierte Migrationen
  domain/      Rollenmodell, zentrale Autorisierung, Statusmaschine, Custom-IDs
  content/     Fertige deutsche Panel-Texte und Ansichten
  setup/       Bauplan, Planer (Vorschau), Ausführung, Diagnose
  services/    Tickets, Angebote, Aufträge, Proofs, Bilder, Bewertungen, Boosts,
               Exporte, Aufbewahrung, Audit, Community
  discord/     Client, Port (discord.js), Befehle, Router, Handler
scripts/       Befehle registrieren, Backup, Healthcheck, Panel-Vorschau
tests/         Automatisierte Tests (Vitest) mit In-Memory-Discord (Mock)
```

## Entwicklung und Prüfungen

```bash
npm run typecheck   # TypeScript strikt
npm test            # 89 automatisierte Tests (Mocks, kein Live-Discord)
npm run build       # Kompilieren nach dist/
npm run check       # alles zusammen
npm run panels:render  # docs/PANELS.md aus dem Panel-Code erzeugen
```

## Getestete Versionen (Lockfile `package-lock.json`)

| Komponente | Version |
|---|---|
| Node.js | 24.22.1 (LTS „Krypton“, Wartung bis 30.04.2028) |
| discord.js | 14.27.0 (Discord API v10) |
| better-sqlite3 | 13.0.3 (SQLite 3.53.4, N-API-Prebuilds) |
| zod | 4.6.7 |
| pino | 10.4.0 |
| TypeScript | 6.0.3 |
| Vitest | 5.0.5 |

Alle Abhängigkeiten wurden mit `npm install --before=2026-10-19` aufgelöst. So werden nur Versionen verwendet, die zum Installationszeitpunkt mindestens zwei Wochen öffentlich waren.

## Bekannte Grenzen (ehrlich)

- **Sichtbarkeit:** Der Serverbesitzer und Mitglieder mit der Discord-Berechtigung „Administrator“ sehen technisch bedingt alle Kanäle, auch Tickets. Der Bot kann das nicht verhindern.
- **Offline-Zeiten:** Ereignisse, während der Bot offline ist (Boosts, Klicks), gehen verloren. Boosts aus dieser Zeit werden beim Start nur intern in ⚙️・bot-status gemeldet und nicht automatisch bedankt.
- **Zusätzliche Boosts** derselben Person erkennt der Bot nur über Discord-Systemnachrichten. Dafür muss in den Servereinstellungen ein Systemkanal gesetzt sein und „Boost-Nachrichten“ müssen aktiv sein.
- **Bildprüfung:** Der Bot entfernt technische Metadaten, erkennt aber keine sichtbaren persönlichen Daten im Bild. Die Prüfung durch das Team bleibt Pflicht.
- **Kopien:** Gelöschte Proofs oder Bewertungen können bereits von Dritten gespeichert worden sein.
- **Spielregeln:** Laut unserem Kenntnisstand führt die Call-of-Duty-Sicherheitsrichtlinie von Activision Boosting als Verstoß auf, und der Accountinhaber haftet unabhängig davon, wer gespielt hat. Die Originalseite (https://support.activision.com/codpolicy) konnte in der Build-Umgebung nicht abgerufen werden. Bitte lest sie selbst und passt die FAQ in `src/content/panels.ts` bei Bedarf an. Das ist keine Rechtsberatung.
- Der Bot wurde **nicht live auf Discord getestet** (kein Token und kein Netzzugang zu discord.com in der Build-Umgebung). Alle automatisierten Tests nutzen einen In-Memory-Mock.
