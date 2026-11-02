# Proof-System: Screenshot im Ticket → öffentlicher Proof

Der Bot veröffentlicht **nie automatisch** jede Ticketnachricht oder jeden Anhang. Nur ausdrücklich ausgewählte Bilder werden nach Kunden- und Team-Freigabe veröffentlicht.

## Ablauf

```
Team postet Ergebnisbilder im Ticket
        │
        ▼
Einreichen (Operator/Support/Admin/Founder)
  • Kontextmenü: Rechtsklick auf die Nachricht → Apps → „Als Proof einreichen“   (bevorzugt)
  • /proof einreichen nachricht:<Link oder ID>
  • Ticket-Button „Proof einreichen“ → Auswahl der letzten Team-Nachrichten mit Bildern
        │  Prüfungen: gleiches Ticket und Server · Ticket offen · Auftrag vorhanden ·
        │  Berechtigung · Autor gehört zum Team · PNG/JPEG/WebP · Größe · Anzahl ·
        │  nur Discord-CDN · Dateisignatur passt zum Typ · kein bereits veröffentlichtes Bild
        ▼
Bildauswahl (Mehrfachauswahl, wenn die Nachricht mehrere Bilder hat)
        │  Download → Signaturprüfung → Metadaten entfernen → SHA-256 → Ablage in data/proofs/<id>
        ▼
Private Vorschau im Ticket (Version n)
  • exakt die bereinigten Bilder, Spiel, Ausgangs- → Zielrang, Abschlussdatum,
    optional Bearbeiter, vorgeschlagener öffentlicher Text, Prüfhinweis
  • Kunde: [Veröffentlichung zustimmen] [Ablehnen] [Mit meinem Namen / Anonym]
  • Team:  [Team-Freigabe] [Text bearbeiten] [Bearbeiter zeigen] [Bild entfernen] [Verwerfen]
  • Hinweis in 🔍・proof-prüfung mit Link zur Vorschau
        │  Jede Änderung an Bildern, Text, Bearbeiter- oder Kundenanzeige, und jede
        │  Änderung des Ziels durch eine neue Angebotsversion, erzeugt Version n+1.
        │  Alle bisherigen Freigaben verfallen.
        ▼
Veröffentlichung, sobald ALLE Bedingungen erfüllt sind:
  Auftrag abgeschlossen · Kunde stimmt Version n zu · Team gibt Version n frei
        │  Bilder werden erneut hochgeladen (keine Links auf Ticket-Anhänge)
        ▼
Beitrag in 📸・proofs · Link im Ticket · Eintrag im 🧾・team-log · lokale Dateien gelöscht
```

## Zustimmung

- Zustimmen darf **nur der Kunde des Auftrags**, auch kein Founder stellvertretend. Die Zustimmung wird **nicht** aus der Ticketöffnung abgeleitet.
- Jede Zustimmung und Freigabe ist an Version und Inhalts-Hash gebunden (Custom-ID und Datenbank). Ein Klick auf eine veraltete Vorschau wird abgelehnt.
- Gespeichert werden: Entscheidung, Version, Hash, Person und Zeitpunkt (`proof_decisions`).
- Standard: **anonym, ohne Ping, ohne Account-ID**. Den eigenen Anzeigenamen kann nur der Kunde einblenden, und das erzeugt eine neue Version mit erneuter Zustimmung.

## Prüfhinweis (in Vorschau und Team-Freigabe)

> Die Bilder dürfen keine E-Mail-Adressen, Zugangsdaten, Account-IDs, privaten Chats oder sonstigen unerwünschten personenbezogenen Daten zeigen. Sind solche Daten sichtbar, zuerst eine geschwärzte Version ins Ticket hochladen und diese einreichen. Der Bot entfernt technische Metadaten, erkennt aber keine sichtbaren Daten im Bild.

Die Team-Freigabe verlangt eine ausdrückliche Bestätigung: „Ich habe alle Bilder geprüft – freigeben“.

## Öffentlicher Beitrag

- Titel „Auftrag abgeschlossen“, Spiel, Ausgangsrang → Zielrang, Datum, die freigegebenen Bilder, Fußzeile „KSA Boosting · Proof #id“
- **Nie enthalten:** Preise, Ticket-Links, interne Notizen, Kunden-Erwähnungen, nicht freigegebene Kundendaten
- Mentions sind technisch deaktiviert (`allowedMentions` leer)

## Technik

| Thema | Umsetzung |
|---|---|
| Formate | PNG, JPEG, WebP. Die echte Dateisignatur muss zum angegebenen Typ passen. |
| Limits | max. 10 Bilder (Discord-Limit je Nachricht), max. 8 MB je Bild (einstellbar bis 20 MB; Discord-Standardlimit seit 03.09.2026: 20 MiB je Datei), max. 24 MB gesamt (Discord-Anfrage max. 25 MiB) |
| Herkunft | nur `https://cdn.discordapp.com` und `https://media.discordapp.net`, keine Weiterleitungen, Streaming-Download mit Größenabbruch und 20 s Timeout |
| Metadaten | verlustfrei, ohne Neukompression: PNG ohne tEXt/zTXt/iTXt/eXIf/tIME, unbekannte Chunks und Daten nach IEND · JPEG ohne APP1 (EXIF/XMP), APP3–13, APP15, COM, MPF und Trailer; ICC-Profil bleibt; die Ausrichtung bleibt in einem minimalen EXIF-Segment erhalten · WebP ohne EXIF/XMP-Chunks, Flags bereinigt |
| Temporäre Dateien | nur bereinigte Bilder in `data/proofs/<id>` (0600). Gelöscht nach Veröffentlichung, Verwerfen, Storno oder Fristablauf. |
| Parallelität | Sperren je Auftrag/Proof, atomarer Statusübergang `pending → publishing → published` |
| Keine Doppel-Posts | gleicher Discord-`nonce` mit `enforce_nonce` bei Wiederholungen; nach längeren Ausfällen sucht der Bot vor einem neuen Versuch nach der Fußzeile „Proof #id“ und übernimmt einen bereits geposteten Beitrag |
| Neustart | `resumePending()` setzt ausstehende und unterbrochene Veröffentlichungen beim Start fort |

## Rücknahme und Widerruf

- **Admin/Founder:** `/proof zuruecknehmen id:<n> grund:<Text>` löscht den Beitrag. Status `withdrawn`, Audit-Eintrag, Team-Log und Hinweis im Ticket.
- **Kunde:** `/proof widerrufen id:<n>`. Vor der Veröffentlichung wird die Zustimmung entzogen, und es wird nichts veröffentlicht. Nach der Veröffentlichung entfernt der Bot den Beitrag sofort.
- In beiden Fällen weist der Bot darauf hin: **Bereits von Dritten gespeicherte Kopien lassen sich nicht löschen.**
