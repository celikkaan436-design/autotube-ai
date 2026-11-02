# Berechtigungen und Rollenhierarchie

## 1. Discord-Rechte des Bots (ohne Administrator)

| Recht | Pflicht? | Wofür |
|---|---|---|
| Kanäle ansehen | Pflicht | Kanäle lesen, Panels posten |
| Kanäle verwalten | Pflicht | Kategorien, Kanäle und Ticketkanäle anlegen und verschieben |
| Rollen verwalten | Pflicht | Rollen anlegen und vergeben, Kanalrechte (Overwrites) setzen |
| Nachrichten senden | Pflicht | Panels, Tickets, Proofs, Danksagungen |
| Nachrichten in Threads senden | Pflicht | Discord erlaubt Bots nur, Rechte zu entziehen, die sie selbst haben (schreibgeschützte Kanäle) |
| Öffentliche Threads erstellen | Pflicht | wie oben |
| Private Threads erstellen | Pflicht | wie oben |
| Links einbetten | Pflicht | Embeds |
| Dateien anhängen | Pflicht | Proof-Bilder erneut hochladen, Exporte |
| Nachrichtenverlauf lesen | Pflicht | Panels aktualisieren, Exporte, Proof-Wiederaufnahme |
| @everyone, @here und alle Rollen erwähnen | Pflicht | gezielter Ping von **@KSA Support** in neuen Tickets; die Rollen bleiben dabei „nicht erwähnbar“, und @everyone/@here sind im Code über `allowedMentions` technisch gesperrt |
| Server verwalten | optional | AutoMod-Regeln anlegen, AFK-Kanal setzen |
| Mitglieder im Timeout | optional | Flood-Schutz: kurzer Timeout |
| Nachrichten verwalten | optional | Flood-Schutz: Spam-Nachrichten löschen |

- Bitfeld der Pflichtrechte: `378225806352`. Mit den optionalen Rechten: `1477737442352`.
- Fehlt ein optionales Recht, überspringt der Bot die zugehörige Funktion und meldet das in der Setup-Vorschau.
- Hat der Bot „Administrator“, weist die Vorschau darauf hin, dass das nicht nötig ist.

## 2. Rollenhierarchie (von oben nach unten)

```
Serverbesitzer (Discord – sieht immer alles)
└─ KSA Manager            ← Bot-Rolle, ganz oben platzieren
   ├─ KSA Founder
   ├─ KSA Admin
   ├─ KSA Support
   ├─ KSA Operator
   ├─ Server Booster      ← eigene kosmetische Rolle ODER die von Discord verwaltete Booster-Rolle
   ├─ Kunde
   ├─ Community
   ├─ Warzone
   └─ Multiplayer
```

- Alle vom Bot angelegten Rollen haben **keine Server-Rechte** (Rechte-Bitfeld 0). Zugriff regeln ausschließlich Kanal-Overwrites. Niemand bekommt automatisch Administrator.
- Wenn ihr den Gründern oder Admins Moderationsrechte geben wollt (Kicken, Bannen, Timeout), vergibt der Serverbesitzer diese **bewusst manuell**.
- **Founder im Bot** sind ausschließlich die drei Nutzer-IDs aus `OWNER_IDS`. Die Discord-Rolle „KSA Founder“ allein verleiht im Bot nur Admin-Rechte; damit ist sie für Kanalzugriff und Anzeige gedacht.

## 3. Berechtigungsmatrix im Bot

Legende: ✅ erlaubt · ❌ verweigert · 🎯 nur für eigene bzw. zugewiesene Vorgänge

| Aktion | Founder | Admin | Support | Operator | Kunde | Mitglied |
|---|---|---|---|---|---|---|
| `/setup start`, `/config setzen`, Boost-Rollenmodus | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| `/setup diagnose`, `/config anzeigen`, `/panel`, `/serverboost status/sync` | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Zahlungsstatus setzen | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Proof zurücknehmen (Admin-Rücknahme) | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| `/health`, Tickets übernehmen/zuweisen/wiedereröffnen, interner Export | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| Angebot erstellen/zurückziehen | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| Proof-Team-Freigabe, Bewertungstext aus-/einblenden | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| Auftrag stornieren | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| Status ändern (außer Storno), Fortschritt, interne Notiz | ✅ | ✅ | ✅ | 🎯 | ❌ | ❌ |
| Proof einreichen und bearbeiten | ✅ | ✅ | ✅ | 🎯 | ❌ | ❌ |
| Ticket, Angebot, Auftrag oder Proof ansehen | ✅ | ✅ | ✅ | 🎯 | 🎯 | ❌ |
| Ticket schließen | ✅ | ✅ | ✅ | ❌ | 🎯 (nur ohne aktiven Auftrag) | ❌ |
| Kundenexport | ✅ | ✅ | ✅ | ❌ | 🎯 | ❌ |
| **Angebot annehmen**, Proof-Zustimmung/-Widerruf, Bewertung abgeben/zurückziehen | ❌ | ❌ | ❌ | ❌ | 🎯 | ❌ |

Kundenaktionen kann ausschließlich der Kunde des jeweiligen Vorgangs ausführen, auch kein Founder stellvertretend. Jede Interaktion wird serverseitig neu geprüft: Server, Kanal, Ticket-Zugehörigkeit, Rolle, Version und Hash. Manipulierte Custom-IDs, IDs aus fremden Tickets und veraltete Buttons werden abgelehnt.

## 4. Kanalsichtbarkeit

| Bereich | @everyone | Community | Team (Founder/Admin/Support) | Operator | Kunde |
|---|---|---|---|---|---|
| START (willkommen, regeln, ankündigungen, rollen, faq) | lesen | lesen | Founder/Admin schreiben | lesen | lesen |
| RANKED-SERVICE, SUPPORT, DISCORD-BOOSTS (Infokanäle) | – ¹ | lesen | lesen, Founder/Admin schreiben | lesen | lesen |
| COMMUNITY, SPRACHKANÄLE | – ¹ | lesen und schreiben | ja | ja | ja |
| TEAM INTERN: auftragsübersicht (nur Bot schreibt), teamchat, Team Voice | – | – | ja | ja | – |
| TEAM INTERN: team-log, bot-status (nur Bot schreibt), proof-prüfung | – | – | ja | – | – |
| OFFENE / ARCHIVIERTE TICKETS (Kategorie) | – | – | ja | – | – |
| Einzelnes offenes Ticket | – | – | ja | nur zugewiesener Operator | nur eigener Kunde |
| Einzelnes archiviertes Ticket | – | – | ja | – | – |

¹ Mit `community.requireRulesAcceptance = ja` (Standard) erst nach **Regeln akzeptieren** sichtbar. Ohne Regelbestätigung sind diese Bereiche für alle sichtbar; die Infokanäle bleiben schreibgeschützt.

- Ticketkanäle bekommen ihre Rechte **ausdrücklich gesetzt**. Beim Verschieben ins Archiv werden sie **nicht** mit der Kategorie synchronisiert (`lockPermissions: false`).
- **Grenze:** Der Serverbesitzer und Mitglieder mit der Discord-Berechtigung „Administrator“ sehen technisch alle Kanäle. Das lässt sich von keinem Bot verhindern.
