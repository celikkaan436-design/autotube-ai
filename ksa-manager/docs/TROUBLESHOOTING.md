# Fehlerbehebung

| Symptom | Ursache | Lösung |
|---|---|---|
| Start bricht mit „Ungültige Konfiguration“ ab | `.env` fehlt oder Werte sind ungültig | `cp .env.example .env`, Token und Application-ID eintragen. Die Fehlermeldung nennt das Feld (der Token wird nie ausgegeben). |
| Log: `Used disallowed intents` bzw. Verbindung mit Code **4014** beendet | Ein privilegierter Intent ist im Developer Portal aus | Bot → Privileged Gateway Intents: **Server Members** an; **Message Content** an oder `ENABLE_MESSAGE_CONTENT=false` setzen |
| Log: `TokenInvalid` / „An invalid token was provided“ | Token falsch oder zurückgesetzt | Im Portal **Reset Token**, neuen Token lokal in `.env` eintragen |
| Log: „Der Bot ist nicht auf dem Zielserver“ | Bot nicht eingeladen oder falsche `DISCORD_GUILD_ID` | Einladungslink aus der Anleitung verwenden; die Server-ID ist `1530667075536814110` |
| Slash-Befehle fehlen | Registrierung fehlgeschlagen oder `applications.commands`-Scope fehlt | Mit dem Link aus der Anleitung neu einladen (Scope `bot applications.commands`); `npm run commands:deploy`; Discord-Client neu laden (Strg+R) |
| „Diese Aktion ist den Foundern vorbehalten“ | Nutzer-ID ist nicht in `OWNER_IDS` | Founder-Rechte gibt es nur über die drei IDs in `.env`. Rollen spielen dafür keine Rolle. |
| Setup-Vorschau zeigt „Blockiert: Fehlendes Bot-Recht“ | Pflichtrecht fehlt | Bot mit dem Link aus [ANLEITUNG.md](ANLEITUNG.md) neu autorisieren oder das Recht der Bot-Rolle geben |
| Setup-Fehler `Missing Permissions` (50013) bei Overwrites | Discord erlaubt Bots nur, Rechte zu setzen, die sie selbst haben | Alle Pflichtrechte vergeben (inkl. Threads und „Alle Rollen erwähnen“) und `/setup start` erneut ausführen; es setzt fort |
| Rollen können nicht vergeben werden | Bot-Rolle steht zu tief | Servereinstellungen → Rollen → **KSA Manager** ganz nach oben ziehen |
| „Der Server hat sich seit der Vorschau verändert“ | Zwischen Vorschau und Bestätigung wurde etwas geändert | `/setup start` erneut ausführen und die neue Vorschau prüfen |
| Doppelte Kanalnamen nach dem Setup | Es gab bereits gleichnamige, fremde Kanäle; diese werden bewusst nicht ungeprüft übernommen | Fremde Kanäle löschen bzw. umbenennen **oder** `/setup start fremde_uebernehmen:true` |
| Ticket-Erstellung: „Das Ticket konnte nicht erstellt werden“ | Kanal-Limit (500 pro Server), fehlende Rechte oder Discord-Störung | `/setup diagnose`; alte Ticketkanäle löschen bzw. `retention.archivedTicketDays` setzen. Bei mehr als 50 Kanälen legt der Bot selbst eine weitere Ticket-Kategorie an. |
| „Interaktion fehlgeschlagen“ direkt nach dem Klick | Bot war offline oder startete neu | Kurz warten und erneut klicken; `/health` prüfen |
| Proof: „Keine unterstützten Bilder gefunden“ | Datei ist kein PNG/JPEG/WebP, zu groß oder stammt nicht vom Discord-CDN | Screenshot als PNG/JPEG erneut im Ticket hochladen |
| Proof: „Dateityp passt nicht zur tatsächlichen Dateisignatur“ | Dateiendung oder Typ ist falsch (z. B. eine umbenannte Datei) | Bild korrekt exportieren und erneut hochladen |
| Proof: „…konnte nicht geladen werden (abgelaufen)“ | Discord-Anhang-URLs laufen ab | Erneut einreichen (Kontextmenü), damit eine frische URL verwendet wird |
| Proof wird nicht veröffentlicht | Eine Bedingung fehlt | `/proof pruefen id:<n>` zeigt „Noch offen: …“ (Abschluss, Kundenzustimmung, Team-Freigabe dieser Version) |
| `/proof einreichen` per Link liefert keine Anhänge | Message Content Intent deaktiviert | Kontextmenü **Apps → Als Proof einreichen** nutzen (funktioniert ohne den Intent) |
| Export ohne Nachrichtentext | Message Content Intent deaktiviert | Intent im Portal aktivieren und `ENABLE_MESSAGE_CONTENT=true` setzen |
| Keine Boost-Danksagung | Intent Server Members fehlt, Danksagung deaktiviert oder der Bot war offline | `/serverboost status`. Boosts aus Offline-Zeiten werden bewusst nicht nachträglich bedankt. |
| Zusätzlicher Boost derselben Person ohne Dank | Systemkanal fehlt oder Boost-Nachrichten sind aus | Servereinstellungen → Systemnachrichten: Kanal setzen und „Boost-Nachricht senden“ aktivieren |
| Zwei Rollen „Server Booster“ | Discord hat die verwaltete Rolle nachträglich angelegt | `/serverboost rollenmodus modus:verwaltet`, danach die eigene Rolle manuell löschen |
| AutoMod-Regeln fehlen | Recht „Server verwalten“ fehlt oder es gibt schon eine Spam-/Erwähnungsregel (Discord erlaubt je eine) | Recht vergeben bzw. vorhandene Regel behalten; `/setup start` |
| Docker: `unhealthy` | Kein Heartbeat seit 3 Minuten (Login fehlgeschlagen, Netzwerkproblem) | `docker compose logs --tail=100` |
| `SQLITE_BUSY` / „database is locked“ | Zweiter Bot-Prozess läuft auf derselben Datenbank | Nur **einen** Prozess pro Datenbank betreiben |
| npm-Warnung „install scripts not yet covered by allowScripts“ (npm 11) | better-sqlite3 bringt fertige N-API-Binärdateien mit; das Build-Skript wird nicht benötigt | Ignorieren. Test: `node -e "require('better-sqlite3')(':memory:')"` |

## Weitere Diagnose

- `/health`: Version, Laufzeit, Gateway-Ping, Datenbankintegrität, Intents, Zähler
- `/setup diagnose`: Rechte, gelöschte, verschobene oder umbenannte Ressourcen, Panels
- `LOG_LEVEL=debug` in `.env` für ausführlichere Logs (weiterhin ohne Secrets und Nachrichteninhalte)
