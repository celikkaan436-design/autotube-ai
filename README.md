# AutoTube AI — Story Edition

Vollautomatisches YouTube-Shorts-Studio für **deutsche KI-Gruselgeschichten** (Mystery, Suspense, Horror, Plot-Twist).
Jeden Tag entsteht eine neue, originelle Story als 45–60-Sekunden-Short (1080×1920). YouTube veröffentlicht sie
**um 18:00 Uhr (Europe/Berlin)**. Das Ganze läuft auf **GitHub Actions**, also auch dann, wenn dein PC aus ist.

**Kosten: 0 €.** Alle Dienste werden über ihre Gratis-Kontingente genutzt. Kostenpflichtige Anbieter sind im Code gesperrt
(`limits.allow_paid_providers = false`).

---

## Was jeden Tag automatisch passiert

| Zeit (Berlin) | Schritt |
|---|---|
| ~07:17 | Story schreiben (Gemini) → Regelprüfung → Duplikat-Check → KI-Lektorat (Bewertung ≥ 7/10) |
| | Deutsche Sprachausgabe pro Szene mit Wort-Zeitstempeln (Microsoft Edge Neural Voice) |
| | 6–10 KI-Szenenbilder im gleichen Stil (FLUX.2 über Cloudflare Workers AI) |
| | Eigene Filmmusik + Soundeffekte (prozedural erzeugt, Content-ID-sicher) |
| | Rendering: Kamerafahrten (Ken Burns), Übergänge, Color Grading, Filmkorn, wortgenaue animierte Untertitel |
| | Qualitätsprüfung (Auflösung, Codecs, Dauer, Schwarz-/Standbilder, Stille, Lautheit, Untertitel-Überlauf, Duplikate) |
| | Upload als *privat* mit Veröffentlichungstermin 18:00 + MP4-Download als GitHub-Release |
| ~10:47 / 13:47 / 16:07 | automatische Wiederholung, falls etwas schiefging (Checkpoints, kein Doppel-Upload) |
| **18:00** | YouTube veröffentlicht das Video selbst |
| ~19:23 | Veröffentlichung verifizieren, Analytics abrufen, daraus für die nächsten Storys lernen |

Im Winter laufen die Morgen-Jobs eine Stunde früher (GitHub rechnet in UTC). Die Veröffentlichung um 18:00 bleibt trotzdem exakt,
weil YouTube den Termin selbst ausführt.

---

## Einrichtung (einmalig, ca. 20 Minuten, alles kostenlos)

### 1. GitHub vorbereiten
1. Das Repo muss **öffentlich** bleiben, denn nur dann sind GitHub Actions unbegrenzt kostenlos. Deine Schlüssel liegen als *Secrets* und sind trotzdem unsichtbar.
2. **Settings → Pages → Source: „GitHub Actions“** einstellen. Danach läuft das Dashboard unter `https://<dein-name>.github.io/<repo>/`.

### 2. Gemini-Schlüssel (Text-KI, kostenlos)
1. Öffne https://aistudio.google.com/apikey und klicke auf **„Create API key“**.
2. Speichere ihn im Repo unter **Settings → Secrets and variables → Actions → New repository secret** als Secret `GEMINI_API_KEY`.

> Ohne Gemini-Schlüssel nutzt das System automatisch Pollinations (ebenfalls gratis, ohne Konto). Mit Gemini werden die Storys aber besser.

### 3. Bild-KI: Cloudflare Workers AI (kostenlos, ca. 75 Bilder pro Tag)
Pollinations erlaubt anonyme Bild-Anfragen inzwischen kaum noch. Deshalb nutzt AutoTube als Haupt-Bildgenerator **FLUX.2 über Cloudflare Workers AI**. Das kostenlose Kontingent liegt bei 10.000 „Neurons“ pro Tag und reicht für etwa 75 Bilder.
1. Leg auf https://dash.cloudflare.com/sign-up ein kostenloses Konto an (ohne Kreditkarte).
2. Kopier die **Account ID**: Im Dashboard links unten auf **Account-Startseite** → bei deinem Konto auf **⋯ → Account-ID kopieren** klicken. Speicher sie als Secret `CLOUDFLARE_ACCOUNT_ID`.
3. Gehe zu **My Profile → API Tokens → Create Token** und wähle die Vorlage **„Workers AI“** → **Continue to summary** → **Create Token**. Speicher den Token als Secret `CLOUDFLARE_API_TOKEN`.

### 4. YouTube verbinden
**a) Google-Cloud-Projekt**
1. Öffne https://console.cloud.google.com und lege ein neues Projekt an, z. B. „AutoTube“.
2. Gehe zu **APIs & Dienste → Bibliothek** und aktiviere **YouTube Data API v3** und **YouTube Analytics API**.
3. Gehe zu **Google Auth Platform / OAuth-Zustimmungsbildschirm**: Wähle Typ **Extern**, gib einen App-Namen und deine E-Mail ein und speichere.
4. Füge unter **Zielgruppe → Testnutzer** dein Google-Konto hinzu.
5. **Ganz wichtig:** Stell die App danach auf **„In Produktion“** (*App veröffentlichen*). Im Testmodus laufen die Tokens nach 7 Tagen ab, dann würde der Autopilot stehen bleiben. Eine Google-Prüfung ist für die eigene Nutzung nicht nötig.
6. Gehe zu **Clients / Anmeldedaten → OAuth-Client-ID erstellen** und wähle Typ **Webanwendung**.
   Als **Autorisierte Weiterleitungs-URI** trägst du `https://developers.google.com/oauthplayground` ein.
   Notiere dir **Client-ID** und **Clientschlüssel**.

**b) Refresh Token holen** (dauerhafter Zugang, ganz ohne eigenen Code)
1. Öffne https://developers.google.com/oauthplayground.
2. Klicke oben rechts auf das Zahnrad, setze den Haken bei **„Use your own OAuth credentials“** und trage Client-ID und Clientschlüssel ein.
3. Füge links unten bei *„Input your own scopes“* diese drei Zeilen ein (mit Leerzeichen getrennt):
   ```
   https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/yt-analytics.readonly
   ```
4. Klicke auf **Authorize APIs** und melde dich mit dem Konto deines YouTube-Kanals an (bei mehreren Kanälen den richtigen wählen).
   Die Warnung „Google hat diese App nicht überprüft“ ist bei eigenen Apps normal: Klicke auf **Erweitert → Weiter zu AutoTube**.
5. Klicke auf **„Exchange authorization code for tokens“** und kopiere den **Refresh token**.

**c) Drei Secrets anlegen:** `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `YOUTUBE_REFRESH_TOKEN`

### 5. Testen und aktivieren
Gehe auf **Actions → „AutoTube · Steuerung“ → Run workflow** und führe die Aktionen der Reihe nach aus:

1. **check**: Prüft live Text-KI, Bild-KI, Stimme, YouTube-Kanal und Berechtigungen. Das Ergebnis steht in der Zusammenfassung des Laufs.
2. **test-render**: Erstellt ein echtes Video ohne Upload. Du findest es unter **Releases** zum Ansehen.
3. **test-upload**: Lädt ein Video **privat** hoch und prüft das Ergebnis über die API. Dieser Schritt ist vor der Aktivierung Pflicht.
4. **activate**: Schaltet den Autopilot ein. Vorher wird alles noch einmal geprüft, und nur wenn alles grün ist, wird aktiviert.

Pausieren kannst du jederzeit mit **deactivate**.

### 6. Damit die Videos automatisch öffentlich werden: YouTube-API-Audit (kostenlos)
YouTube setzt Uploads aus **neuen, nicht geprüften** Google-Cloud-Projekten automatisch auf **privat**, auch wenn ein Termin gesetzt ist.
Das ist eine Regel von YouTube und lässt sich nicht umgehen. Beantrage deshalb einmalig das kostenlose Audit:
https://support.google.com/youtube/contact/yt_api_form
Gib dort an, dass es ein privates Tool für den eigenen Kanal ist. Die Prüfung dauert meist einige Wochen.

**Bis dahin** läuft alles normal weiter: Jeden Tag entsteht ein fertiges Video und liegt privat in YouTube Studio.
Dort veröffentlichst du es mit einem Klick, und als MP4 gibt es das Video zusätzlich unter Releases. Das Dashboard zeigt ehrlich an,
ob ein Video wirklich öffentlich ist. Bestätigt wird das erst, wenn die API „public“ meldet.

---

## Optionale Gratis-Extras (Secrets)
| Secret | Wofür | Wo |
|---|---|---|
| `POLLINATIONS_TOKEN` | Reserve-Bildgenerator, falls Cloudflare ausfällt | https://enter.pollinations.ai |
| `OPENROUTER_API_KEY` | Reserve-Text-KI (nur `:free`-Modelle) | https://openrouter.ai/keys |

## Einstellungen
Alles steht in [`config/autotube.json`](config/autotube.json): Stimme, Sprechtempo, Genres, Bildstil, Musikpegel, Tageslimits.
Ungültige Werte werden beim Start abgelehnt (Pydantic-Validierung).
Ein paar Werte sind fest vorgegeben: 1080×1920, Europe/Berlin und Deutsch.

## Benachrichtigungen
Bei einem Problem (Produktion endgültig fehlgeschlagen, YouTube-Zugang widerrufen, Kontingent erschöpft, Video nach 18:00 nicht öffentlich)
legt das System ein **GitHub-Issue** an, und GitHub schickt dir dazu eine E-Mail. Ist der YouTube-Zugang widerrufen, pausiert sich der Autopilot selbst.

---

## Technik

```
autotube/
  story/        Story-Engine: Prompts, Pydantic-Schema, Regeln, TF-IDF-Duplikatprüfung, KI-Review
  providers/    llm.py (Gemini → Pollinations → OpenRouter), images.py (Pollinations → Cloudflare → prozedural),
                tts.py (Edge Neural TTS mit Wortzeiten → Piper offline)
  media/        timeline.py, music.py (Komposition + SFX), audio.py (Ducking, EBU R128), subtitles.py (ASS-Karaoke),
                render.py (OpenCV-Kamerafahrten → FFmpeg H.264/AAC), qa.py, thumbnail.py
  youtube/      OAuth (Refresh Token), Resumable Upload, publishAt, Thumbnails, Status, Analytics
  pipeline.py   Orchestrierung mit Checkpoints, Idempotenz, Duplikatschutz, Preflight, Aktivierung
  analysis.py   lernt aus echten Analytics-Zahlen (Genre/Hook/Länge), epsilon-greedy
data/state.json Zustand (Tage, Videos, Analytics, Verbrauch, Logs) — wird von den Workflows committet
dashboard/      statisches Dashboard (GitHub Pages)
.github/        Workflows: Produktion, Verifizierung, Steuerung, Tests, Pages
```

**Absicherung gegen doppelte Uploads:** Pro Tag gibt es genau einen Slot. Folgende Mechanismen greifen zusammen:
1. Die `concurrency`-Sperre von GitHub sorgt dafür, dass nie zwei Läufe gleichzeitig arbeiten.
2. Der Tagesstatus wird nach dem Upload sofort ins Repo committet.
3. Vor jedem Upload sucht das System zusätzlich auf YouTube nach der Markierung `AutoTube-ID: JJJJ-MM-TT` in der Beschreibung.
4. Der allererste Upload ist immer privat und hat keinen Termin.

**Tests:** `python -m unittest discover -s tests -t .` führt die Unit-Tests aus. Externe Dienste sind dabei **gemockt**, das ist jeweils im Dateikopf markiert.
`RUN_LIVE=1` startet zusätzlich echte Integrationstests gegen die Dienste.
`python -m autotube demo` rendert ein komplettes Video offline, mit Platzhalter-Stimme und Ersatzbildern, als Test für das Rendering.

**Alternativer Betrieb mit Docker** (eigener Server statt GitHub Actions): `.env` aus `.env.example` anlegen und `docker compose up -d` starten.
Der eingebaute Scheduler arbeitet dann mit denselben Berliner Zeiten, das Dashboard läuft auf Port 8080.

## Lizenzen
Schriften: Outfit und Gloock (SIL Open Font License, siehe `assets/fonts`). Musik und Soundeffekte werden zur Laufzeit synthetisiert und sind eigenes Material.
Jedes Video wird bei YouTube als KI-generiert gekennzeichnet (`containsSyntheticMedia`) und in der Beschreibung offengelegt.
