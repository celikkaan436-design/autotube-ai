# Manuelle Testcheckliste auf Discord

Diese Tests müsst **ihr** auf dem echten Server durchführen. Die automatisierten Tests (`npm test`) laufen nur gegen einen In-Memory-Mock und ersetzen keinen Live-Test.

## Vorbereitung

Ihr braucht fünf Discord-Konten (Zweitkonten sind möglich):

| Kürzel | Konto | Rollen |
|---|---|---|
| **F** | ein Founder (xKyro, xSyro oder Atex) | automatisch KSA Founder |
| **S** | Support-Testkonto | KSA Support |
| **O** | zugewiesener Operator | KSA Operator |
| **X** | fremder Operator | KSA Operator |
| **M** | normales Mitglied / Kunde | keine (erhält Community nach Regelbestätigung) |

Vergebt die Rollen S, O und X manuell über die Servereinstellungen.

## A. Setup (F)

- [ ] `/setup start` als **M** → Meldung „den Foundern vorbehalten“, keine Vorschau
- [ ] `/setup start` als **F** → Vorschau mit Rollen, Kategorien, Kanälen, Panels und Hinweisen (nur für F sichtbar)
- [ ] Ein anderer Founder klickt *Bestätigen* in F's Vorschau? Nicht möglich, die Vorschau ist ephemer. (Serverseitig ist die Bestätigung zusätzlich an F gebunden.)
- [ ] F bestätigt → Ergebnis ohne Fehler. Alle Kanäle und Panels sind vorhanden, ⚙️・bot-status zeigt „Setup ausgeführt“.
- [ ] `/setup start` erneut → „Alles ist eingerichtet“, keine doppelten Kanäle oder Panels
- [ ] Einen Kanal (z. B. ❓・faq) löschen → `/setup diagnose` meldet „wurde gelöscht“ → `/setup start` legt ihn neu an
- [ ] Einen Kanal in eine andere Kategorie ziehen → Diagnose meldet „verschoben“ → `/setup start korrigieren:true` verschiebt ihn zurück
- [ ] Rollenreihenfolge prüfen: KSA Manager > KSA Founder > KSA Admin > KSA Support > KSA Operator > Server Booster > Kunde > Community > Warzone > Multiplayer
- [ ] Keine KSA-Rolle hat Server-Rechte (Servereinstellungen → Rollen → Berechtigungen)

## B. Normales Mitglied (M)

- [ ] Vor *Regeln akzeptieren* sieht M nur START
- [ ] *Regeln akzeptieren* → M erhält Community und sieht RANKED-SERVICE, SUPPORT, DISCORD-BOOSTS, COMMUNITY und SPRACHKANÄLE
- [ ] In Infokanälen (📸・proofs, ⭐・bewertungen, 🎉・boost-danke, …) kann M nicht schreiben, keine Threads erstellen
- [ ] In 💬・allgemein kann M schreiben
- [ ] TEAM INTERN, OFFENE TICKETS und ARCHIVIERTE TICKETS sind für M unsichtbar
- [ ] 🎭・rollen: *Warzone* klicken → Rolle hinzugefügt; erneut klicken → entfernt
- [ ] `/ticket info nummer:<fremdes Ticket>` → „nicht beteiligt“
- [ ] `/ticket export nummer:<fremdes Ticket>` → verweigert
- [ ] `/auftrag zahlung …` → „Admins und Foundern vorbehalten“
- [ ] `/proof freigeben id:<n>` → „dem Support-Team vorbehalten“
- [ ] `/auftrag status …` bei fremdem Auftrag → verweigert

## C. Ticket und Angebot (M als Kunde, S)

- [ ] M: 🎫・ticket-erstellen → *Warzone Ranked* → Formular (Rang optional mit SR, Zielrang, Plattform, Zeitraum, Angaben) → privates Ticket entsteht
- [ ] Im Ticket: Zusammenfassung, Ablauf-Hinweis und gezielter Ping von @KSA Support (nicht @everyone)
- [ ] X (fremder Operator) sieht das Ticket **nicht**
- [ ] M klickt *Übernehmen* → verweigert
- [ ] Zweites und drittes Ticket direkt hintereinander → Cooldown-Meldung bzw. Limit-Meldung (Standard: max. 2 offen)
- [ ] S und ein zweiter Support klicken gleichzeitig *Übernehmen* → genau einer gewinnt
- [ ] S: *Zuweisen* → O wählen → O sieht das Ticket jetzt, X weiterhin nicht
- [ ] S: *Angebot erstellen* → Formular → *Zeitraum & Abbruchbedingungen* → *An Kunden senden*
- [ ] S oder F klickt *Angebot annehmen* → „ausschließlich der Kunde“
- [ ] M: *Angebot annehmen* → Rückfrage → bestätigen → „Auftrag #… angelegt“; M erhält die Rolle Kunde
- [ ] Doppelklick auf *Ja, verbindlich annehmen* → nur ein Auftrag
- [ ] S sendet eine neue Angebotsversion → der alte Annahme-Button funktioniert nicht mehr; nach Annahme gilt Version 2

## D. Zugewiesener Operator (O) und fremder Operator (X)

- [ ] O: *Status ändern* → In Bearbeitung → Kunde sieht die Statusmeldung im Ticket
- [ ] O: `/auftrag fortschritt prozent:50 text:Halbzeit` → Meldung im Ticket
- [ ] O: `/auftrag notiz text:Test` → bestätigt; M sieht die Notiz nirgends (`/auftrag ansehen` als M)
- [ ] O: Storno versuchen → verweigert
- [ ] O: `/auftrag zahlung` → verweigert
- [ ] X: `/auftrag status id:<Auftrag> …` → verweigert
- [ ] X: Proof einreichen in einem fremden Ticket → nicht möglich (kein Zugriff, serverseitig verweigert)

## E. Zahlungsstatus (F oder Admin)

- [ ] F: `/auftrag zahlung status:Manuell als bezahlt bestätigt` → Hinweis im Ticket und Eintrag im 🧾・team-log
- [ ] S: derselbe Befehl → verweigert

## F. Proof (O, M, S)

- [ ] O postet ein Ergebnisbild ins Ticket → Rechtsklick → Apps → *Als Proof einreichen*
- [ ] Bei mehreren Bildern: Auswahl erscheint; nur die gewählten Bilder sind in der Vorschau
- [ ] Ein Bild von M (Kundennachricht) einreichen → „nur aus Nachrichten des Teams“
- [ ] Vorschau im Ticket zeigt die Bilder, Spiel, Start → Ziel und den Prüfhinweis
- [ ] S: *Text bearbeiten* → neue Version; die alte Vorschau ist deaktiviert
- [ ] M stimmt zu, S gibt frei, Auftrag noch nicht abgeschlossen → **kein** Post
- [ ] O setzt den Auftrag auf *Abgeschlossen* → Proof erscheint automatisch in 📸・proofs, anonym, ohne Ping, ohne Preis und Ticket-Link; Link steht im Ticket; Eintrag im Team-Log
- [ ] Nach Zustimmung ein Bild entfernen → erneute Zustimmung nötig
- [ ] Bot während der Veröffentlichung neu starten → kein doppelter Beitrag
- [ ] Admin: `/proof zuruecknehmen id:<n> grund:Test` → Beitrag weg, Audit und Team-Log
- [ ] M: `/proof widerrufen id:<n>` → Beitrag weg, Hinweis auf Kopien Dritter

## G. Bewertung (M, S)

- [ ] Nach Abschluss erscheint *Bewertung abgeben* im Ticket
- [ ] S klickt den Button → verweigert
- [ ] M: Sterne → Veröffentlichung „anonym“ → Text → Post in ⭐・bewertungen als „Verifizierter Kunde“
- [ ] M versucht eine zweite Bewertung → „bereits abgegeben“
- [ ] S: `/bewertung ausblenden id:<n> grund:Test` → Text ausgeblendet, Sterne unverändert

## H. Ticket schließen, Export, Wiederöffnen

- [ ] M: `/ticket export` → private Datei (ephemer) ohne interne Notizen
- [ ] S: `/ticket export art:Intern` → mit Notizen und Verlauf
- [ ] S: *Schließen* → Kanal wandert nach ARCHIVIERTE TICKETS, M verliert den Zugriff
- [ ] S: `/ticket wiedereroeffnen nummer:<n>` → Kanal zurück, M hat wieder Zugriff
- [ ] Ticketkanal manuell löschen → Team-Log-Hinweis; `/ticket info` zeigt den Status `channel_deleted`
- [ ] Kunde verlässt den Server → Hinweis im Ticket; der Operator verlässt den Server → Zuweisung wird aufgehoben, Support wird informiert

## I. Serverboost

- [ ] `/serverboost status` als Admin → Intents, Systemkanal, Rollenmodus, Grenzen
- [ ] Jemand boostet → **eine** Danksagung in 🎉・boost-danke, nur der Booster wird erwähnt
- [ ] Bot neu starten → keine erneute Danksagung für bestehende Boosts
- [ ] Modus `custom`: Booster erhält die Rolle „Server Booster“; nach Boost-Ende wird sie still entfernt
- [ ] Sobald Discord die verwaltete Booster-Rolle anlegt: Hinweis in ⚙️・bot-status → `/serverboost rollenmodus modus:verwaltet`

## J. Allgemein

- [ ] Bot zu einem fremden Server einladen → er verlässt ihn sofort
- [ ] `/health` als S → Status grün, Integrität „ok“
- [ ] Flood-Test in 💬・allgemein (mehr als 6 Nachrichten in 8 s) → Nachricht gelöscht, kurzer Timeout, Team-Log-Eintrag (mit optionalen Rechten)
- [ ] Einladungslink in 💬・allgemein posten → von AutoMod blockiert (mit „Server verwalten“)
