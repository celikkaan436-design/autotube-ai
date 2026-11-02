# Architektur

## Überblick

```
Discord Gateway/REST
        │  discord.js 14.27 (Intents: Guilds, GuildMembers, GuildMessages, optional MessageContent)
        ▼
src/discord/bot.ts ── Events ──► Services (Boosts, Tickets, Community)
        │
        ▼
InteractionRouter (Custom-ID → Handler, Zielserver-Prüfung, Doppelklickschutz, Fehlerbehandlung)
        │
        ▼
Handler (dünn: Eingaben lesen, defer/reply) ──► Services (Fachlogik)
                                                 │      │
                                     zentrale Autorisierung (domain/permissions.ts)
                                                 │      │
                                    SQLite (Repo, Transaktionen)   DiscordPort (Seiteneffekte)
```

- **Ein Prozess**, keine Microservices, kein externes Dashboard.
- **DiscordPort** (`src/discord/port.ts`): Alle Seiteneffekte gegenüber Discord laufen über dieses Interface. In Produktion steckt `DjsPort` (discord.js) dahinter, in Tests `FakePort` (In-Memory, mit Fehlerinjektion und „verlorenen Antworten“).
- **Services** sind über einen `AppContext` injiziert (DB, Port, Uhr, Einstellungen, Registry, Sperren, Audit). Dadurch sind sie vollständig testbar.

## Dauerhafte Interaktionen

- Alle Buttons, Menüs und Modals tragen typisierte Custom-IDs (`ksa:<ns>:<aktion>:<args>`, max. 100 Zeichen). Es gibt **keine Collector**; nach einem Neustart funktioniert jeder Button weiter.
- Zwischenstände mehrstufiger Abläufe stehen in der Custom-ID (Bewertung: Sterne und Veröffentlichung) oder in der Datenbank (Angebotsentwurf, Proof-Auswahl-Token, Setup-Plan).
- Custom-IDs gelten als **nicht vertrauenswürdig**. Jeder Handler prüft Zielserver, Kanal-Zugehörigkeit (Ticket-ID ↔ Kanal), Berechtigung, Version und Inhalts-Hash erneut.

## Nebenläufigkeit

| Mechanismus | Einsatz |
|---|---|
| `KeyedMutex` (prozessintern) | Ticket-Erstellung je Nutzer, Aktionen je Ticket, Auftrag, Proof und Bewertung, Boost-Verarbeitung |
| Bedingte Updates (`… WHERE status = ?`) | Übernahme, Statuswechsel, Angebotsannahme, Proof-Veröffentlichung, Setup-Bestätigung |
| Eindeutige Constraints | eine Bewertung je Auftrag, ein aktiver Proof je Auftrag, eine Freigabe je Version, Boost-Ereignisschlüssel, Ticketnummern |
| Reservierung vor Discord-Aufrufen | Ticket wird als `creating` angelegt (Limitprüfung in derselben Transaktion), danach der Kanal |
| Discord-`nonce` + `enforce_nonce` | Proof-Posts werden bei Wiederholung nicht doppelt erstellt |
| Doppelklickschutz | gleiche Komponente vom gleichen Nutzer innerhalb von 1,5 s |

## Datenmodell (SQLite, Migration 1)

| Tabelle | Inhalt |
|---|---|
| `settings` | Laufzeit-Einstellungen (`/config`) |
| `setup_resources` | Schlüssel → Discord-ID für Rollen, Kategorien, Kanäle, Panels, AutoMod (inkl. Status `in_progress`/`failed` für die Wiederaufnahme) |
| `setup_plans` | Setup-Vorschauen (Nutzer, Hash, Ablauf, Ergebnis) |
| `tickets` | Anfragen inkl. Phase (Anfrage / Angebot gesendet / angenommen) |
| `offers` | Angebotsversionen mit Inhalts-Hash |
| `orders`, `order_events`, `order_notes` | Aufträge, Änderungsverlauf, interne Notizen |
| `proofs`, `proof_images`, `proof_decisions`, `proof_candidates` | Proofs, Bilder (SHA-256), Zustimmungen/Freigaben je Version, Auswahl-Token |
| `reviews` | Bewertungen (UNIQUE je Auftrag) |
| `boost_member_state`, `boost_events` | Boost-Status je Mitglied, deduplizierte Ereignisse |
| `cooldowns`, `audit_log`, `bot_state`, `counters` | Cooldowns, Audit, Heartbeat/Befehls-Hash, Ticketnummern |

Alle Discord-IDs sind `TEXT`, Zeitstempel sind Unix-Millisekunden, Abfragen sind parametrisiert, Fremdschlüssel aktiv, WAL-Modus und `secure_delete` an.

## Sicherheit

- Founder ausschließlich über `OWNER_IDS` (Nutzer-IDs). Andere Stufen über die gespeicherten Rollen-IDs, nie über Namen.
- Zentrale Policy (`authorize()`), für jede Aktion serverseitig geprüft.
- Mentions sind standardmäßig aus (`allowedMentions: { parse: [] }`). Gepingt wird nur ausdrücklich: Support-Rolle im neuen Ticket, Kunde, Booster.
- Nutzereingaben werden entschärft (Steuerzeichen, Massen-Erwähnungen, Markdown-Links) und auf Discord-Limits gekürzt.
- Logs enthalten keine Tokens, Nachrichteninhalte oder signierten Anhang-URLs.
- Proof-Downloads nur vom Discord-CDN, mit Größenlimit, ohne Redirects, mit Signaturprüfung und Metadaten-Entfernung.
- Der Bot verlässt fremde Server und beantwortet Interaktionen nur auf dem Zielserver.

## Tests

Automatisiert (Vitest, 89 Tests, alle gegen Mocks bzw. reine Logik):

| Datei | Abdeckung |
|---|---|
| `authorization.test.ts` | Rollenauflösung über IDs, Matrix aller Rollen, Statusmaschine, manipulierte Custom-IDs |
| `setup.test.ts` | Autorisierung, Bestätigungsbindung, Ablauf, Doppelklick, veraltete Vorschau, Blocker, Idempotenz, Teilausfall, verlorene Antwort (Übernahme statt Duplikat), fremde gleichnamige Ressourcen, gelöschte/verschobene Kanäle, verwaltete Booster-Rolle, Sichtbarkeit |
| `tickets-orders.test.ts` | private Overwrites, Limit bei Parallelität, Cooldown, Rollback, konkurrierende Übernahme, fremde Rollen, manipulierte Ticket-ID, Operatorwechsel, Schließen/Wiederöffnen, gelöschte Kanäle/Austritte, Angebotsversionen und Annahme, Statuswechsel, Zahlungsrechte, Trennung intern/öffentlich, Exporte |
| `proofs.test.ts` | nur zugehöriges Ticket und Team-Nachrichten, Typ/Signatur/Herkunft, Auswahl, keine Veröffentlichung ohne Zustimmung/Freigabe/Abschluss, neue Version bei Änderungen, öffentlicher Inhalt, keine Doppel-Posts bei Parallelität und verlorener Antwort, Duplikatbilder, Rücknahme, Widerruf, Wiederaufnahme nach Neustart |
| `images.test.ts` | Signaturen, Metadaten-Entfernung PNG/JPEG/WebP, Ausrichtung |
| `reviews-boosts.test.ts` | Bewertung nur nach Abschluss/nur Kunde, eine je Auftrag (parallel), Zustimmung, Moderation, Boost-Deduplizierung (beide Reihenfolgen, Replay), Zusatzboost, Neustart ohne falschen Dank, veraltete Ereignisse, Rollenabgleich, verwaltete Rolle unangetastet |
| `persistence-config.test.ts` | Persistenz nach Neustart (Datei-DB), Boost-Dedup über Neustart, Migrationen, Env-Validierung, `/config`-Parsing, Preise/SR, Log-Schwärzung, Befehle, Panel-Limits und -Inhalte |
