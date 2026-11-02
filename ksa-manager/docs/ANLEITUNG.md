# Anleitung für Einsteiger

Diese Anleitung führt dich vom leeren Discord-Server bis zum ersten Test. Zeitbedarf: etwa 20–30 Minuten.

> **Sicherheitsregel Nummer 1:** Der Bot-Token ist wie ein Passwort. Trage ihn nur lokal in die Datei `.env` oder in die Secrets deines Hosters ein. Schicke ihn niemals in einen Chat, ein Ticket, eine E-Mail oder in Git. Falls er doch einmal öffentlich wurde: im Developer Portal sofort **Reset Token** klicken.

---

## 1. Bot im Discord Developer Portal erstellen

1. Öffne https://discord.com/developers/applications und melde dich an.
2. Klicke **New Application**, gib als Namen **KSA Manager** ein, akzeptiere die Bedingungen und klicke **Create**.
3. Optional: Lade unter **General Information** ein App-Icon hoch.

## 2. Application-ID übernehmen

1. Kopiere unter **General Information** die **Application ID**.
2. Sie gehört später in `.env` als `DISCORD_CLIENT_ID`. Die ID ist kein Geheimnis.

## 3. Token ausschließlich lokal eintragen

1. Öffne den Reiter **Bot** und klicke **Reset Token**. Bestätige gegebenenfalls mit deiner 2FA.
2. Kopiere den Token **direkt** in deine lokale `.env`:
   ```bash
   cp .env.example .env
   # .env im Editor öffnen und eintragen:
   # DISCORD_TOKEN=<hier einfügen>
   # DISCORD_CLIENT_ID=<Application ID>
   ```
   Server-ID und die drei Founder-IDs sind in `.env.example` bereits eingetragen.
3. Damit niemand sonst den Bot hinzufügen kann: Stelle unter **Installation** den **Install Link** auf **None** und schalte danach unter **Bot** die Option **Public Bot** aus. Zusätzlich verlässt der Bot automatisch jeden fremden Server.

## 4. Benötigte Intents aktivieren

Im Reiter **Bot** unter **Privileged Gateway Intents**:

| Intent | Einstellung | Wofür |
|---|---|---|
| Presence Intent | **aus** | wird nicht benötigt |
| Server Members Intent | **an** (Pflicht) | Boost-Status (`premium_since`), Begrüßung, Austritte, Rollenabgleich |
| Message Content Intent | **an** (empfohlen) | Ticket-Exporte mit Nachrichtentext, `/proof einreichen` per Link, Proof-Button mit Nachrichtenauswahl |

Wenn du den Message Content Intent nicht aktivieren willst, setze in `.env` `ENABLE_MESSAGE_CONTENT=false`. Das Kontextmenü **Als Proof einreichen** funktioniert trotzdem; Exporte enthalten dann aber keinen Nachrichtentext.

Laut Discord-Doku können Apps mit weniger als 10.000 Nutzern privilegierte Intents einfach im Portal einschalten. Ist ein Intent im Code angefordert, aber im Portal aus, beendet Discord die Verbindung mit Code 4014.

## 5. Bot mit minimal notwendigen Rechten einladen

Ersetze `DEINE_APPLICATION_ID` und öffne den Link im Browser. Wähle den Server **KSA Boosting** aus:

```
https://discord.com/oauth2/authorize?client_id=DEINE_APPLICATION_ID&scope=bot%20applications.commands&permissions=1477737442352
```

Der Link enthält **kein Administrator-Recht**. Welche Rechte er enthält und warum, steht in [BERECHTIGUNGEN.md](BERECHTIGUNGEN.md). Ohne die drei optionalen Rechte (AutoMod/AFK, Timeout, Nachrichten verwalten) nimmst du `permissions=378225806352`.

## 6. Bot-Rolle richtig positionieren

1. Öffne **Servereinstellungen → Rollen**.
2. Ziehe die Rolle **KSA Manager** (sie entsteht beim Einladen automatisch) **ganz nach oben**, mindestens über alle Rollen, die der Bot vergeben soll.
3. Discord erlaubt einem Bot nur, Rollen unterhalb seiner höchsten Rolle zu verwalten. Das Setup ordnet seine neuen Rollen danach automatisch direkt unter der Bot-Rolle an: Founder, Admin, Support, Operator, Server Booster, Kunde, Community, Warzone, Multiplayer.

## 7. Starten

### Variante A: lokal (Node.js 24 LTS)

```bash
node --version        # v24.x (mindestens v22.12)
npm ci                # installiert exakt die Versionen aus package-lock.json
npm run build
npm start
```

Beim ersten Start legt der Bot `./data/ksa.sqlite` an, führt die Migrationen aus und registriert die Slash-Befehle auf dem Server. Diese sind sofort verfügbar. In ⚙️・bot-status erscheint nach dem Setup bei jedem Start eine Statusmeldung.

### Variante B: Docker

```bash
docker compose up -d --build
docker compose logs -f
```

Die Daten liegen im Volume `ksa-data` (`/app/data` im Container) und bleiben bei Updates und Neustarts erhalten.

> Für einen dauerhaften Betrieb muss ein Rechner oder Server durchgehend laufen, zum Beispiel ein eigener PC, ein Raspberry Pi oder ein VPS. Kostenpflichtige APIs braucht der Bot nicht. Wir buchen keine Dienste für euch. Vergleicht Anbieter und deren aktuelle Konditionen selbst.

## 8. `/setup` ausführen und Vorschau bestätigen

1. Schreibe auf dem Server als einer der drei Founder (xKyro, xSyro oder Atex) `/setup start`.
2. Der Bot prüft Server, Rechte und Rollenhierarchie und zeigt eine **Vorschau** (nur für dich sichtbar):
   - welche Rollen, Kategorien, Kanäle, Panels, AutoMod-Regeln angelegt werden,
   - Hinweise (zum Beispiel fehlende optionale Rechte) und Blocker (zum Beispiel fehlende Pflichtrechte).
3. Prüfe die Vorschau und klicke **Bestätigen und ausführen**. Die Bestätigung gilt 10 Minuten, nur für dich und nur für genau diese Vorschau.
4. Danach siehst du das Ergebnis: Erledigt, Fehler, Übersprungen. Bei Fehlern behebst du die Ursache und führst `/setup start` erneut aus. Bereits erstellte Ressourcen werden wiederverwendet, es entsteht nichts doppelt.
5. Optional in den **Servereinstellungen** unter Übersicht bzw. Engagement → **Systemnachrichten**: Systemkanal setzen (zum Beispiel 🎉・boost-danke) und „Nachricht senden, wenn jemand den Server boostet“ aktivieren. Ohne diese Einstellung erkennt der Bot nur den *Beginn* eines Boost-Status, keine zusätzlichen Boosts derselben Person.
6. `/setup diagnose` zeigt jederzeit, ob noch etwas fehlt.

Nützliche Einstellungen mit `/config setzen` (nur Founder):
- `games.warzone.ranks` / `games.multiplayer.ranks`: Ränge kommagetrennt (nur Anzeige), standardmäßig leer
- `games.season`: zum Beispiel „Season 1“, standardmäßig leer
- `tickets.maxOpenPerUser`, `tickets.createCooldownSeconds`
- `boost.extraPerks`: nur tatsächlich eingerichtete Zusatzvorteile eintragen
- Danach: `/panel aktualisieren panel:alle`

## 9. Tickets, Proofs und Serverboosts testen

Die vollständige Liste steht in [TESTCHECKLISTE.md](TESTCHECKLISTE.md). Kurzfassung:

1. **Rollen vergeben:** Gib Testkonten die Rollen *KSA Support* und *KSA Operator* (Servereinstellungen → Rollen oder Rechtsklick auf das Mitglied).
2. **Ticket:** Mit einem normalen Konto in 📜・regeln auf *Regeln akzeptieren* klicken, dann in 🎫・ticket-erstellen auf *Warzone Ranked* klicken und das Formular absenden.
3. **Support:** Im Ticket *Übernehmen* → *Zuweisen* (Operator wählen) → *Angebot erstellen* → Zeitraum und Abbruchbedingungen ergänzen → *An Kunden senden*.
4. **Kunde:** *Angebot annehmen* → bestätigen. Jetzt existiert der Auftrag.
5. **Operator:** *Status ändern* → In Bearbeitung → Abgeschlossen. Ein Ergebnisbild ins Ticket posten, dann Rechtsklick auf die Nachricht → **Apps → Als Proof einreichen**.
6. **Freigaben:** Der Kunde klickt in der Vorschau *Veröffentlichung zustimmen*, Support klickt *Team-Freigabe* und bestätigt die Prüfung. Der Proof erscheint in 📸・proofs, der Link steht im Ticket.
7. **Serverboost:** Wenn jemand boostet, erscheint die Danksagung in 🎉・boost-danke. `/serverboost status` zeigt Erkennung, Rollenmodus und Grenzen.
