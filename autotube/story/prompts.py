"""Prompts für Story-Generierung und KI-Review (Deutsch)."""
from __future__ import annotations

import json

SYSTEM_STORY = """Du bist ein preisgekrönter deutscher Autor für virale Kurz-Gruselgeschichten (YouTube Shorts, 45–60 Sekunden).
Du schreibst ORIGINELLE, frei erfundene Geschichten: keine bekannten Creepypastas, keine realen Personen, Marken,
Orte von realen Verbrechen oder urheberrechtlich geschützte Figuren. Du schreibst in natürlichem, gesprochenem Deutsch,
mit kurzen Sätzen, die sich laut vorgelesen gut anhören. Keine expliziten Gewaltdetails, kein Gore, nichts Sexuelles,
keine Gewalt gegen Kinder, keine Selbstverletzung — Spannung entsteht durch Andeutung, Atmosphäre und den Twist.
Antworte ausschließlich mit einem einzigen gültigen JSON-Objekt."""

SCHEMA_EXAMPLE = {
    "title": "Kurzer deutscher Story-Titel",
    "genre": "Mystery | Suspense | Horror | Plot-Twist",
    "logline": "Ein Satz, der die Prämisse und den Twist zusammenfasst",
    "hook_style": "frage | schock | geheimnis | warnung | zeitdruck | gestaendnis",
    "setting": "Kurze Beschreibung des Schauplatzes (Deutsch)",
    "visual_style": "English: one consistent visual style for ALL images (lighting, palette, era, lens)",
    "characters": [{"name": "Lena", "visual": "English: woman in her 30s, short black hair, grey wool coat, silver locket"}],
    "scenes": [
        {
            "beat": "hook",
            "narration": "Deutscher Erzähltext dieser Szene (1–2 kurze Sätze).",
            "visual_prompt": "English: detailed cinematic image description of this exact moment, subject, environment, lighting",
            "characters": ["Lena"],
            "camera": "zoom_in | zoom_out | pan_left | pan_right | pan_up | pan_down | shake | dolly_in",
            "transition": "crossfade | fade_black | flash | glitch | cut",
            "audio_cue": "none | whoosh | heartbeat | riser | impact | sting | silence | drone",
            "mood": "dark | cold | warm | red",
        }
    ],
    "youtube": {
        "title": "Neugierig machender YouTube-Titel auf Deutsch (max. 70 Zeichen, ohne Clickbait-Lügen)",
        "description": "2–3 Sätze auf Deutsch, die neugierig machen, ohne den Twist zu verraten",
        "tags": ["Gruselgeschichte", "Mystery"],
        "thumbnail_text": "Max. 4 Wörter",
    },
}


def story_user_prompt(
    *, genre: str, hook_style: str, hook_desc: str, scenes_min: int, scenes_max: int,
    insights: str, avoid: list[str], feedback: list[str] | None, prefer_shorter: bool | None,
) -> str:
    length = "115–130" if prefer_shorter else "120–140"
    avoid_txt = "\n".join(f"- {a}" for a in avoid[-40:]) or "- (noch keine)"
    fb = ""
    if feedback:
        fb = "\n\nDEIN LETZTER ENTWURF WURDE ABGELEHNT. Behebe unbedingt:\n" + "\n".join(f"- {f}" for f in feedback)
    return f"""Schreibe eine neue, originelle Kurzgeschichte als Storyboard.

Genre: {genre}
Hook-Stil: {hook_style} — {hook_desc}

Pflicht-Dramaturgie (Abschnitte in genau dieser Reihenfolge, insgesamt {scenes_min}–{scenes_max} Szenen):
1. hook (genau 1 Szene, max. 14 Wörter): Der erste Satz muss in 3 Sekunden fesseln.
2. setup (1–2 Szenen): Wer, wo, was ist seltsam? Klare Figur, markanter Schauplatz.
3. escalation (2–3 Szenen): Die Spannung steigt spürbar von Szene zu Szene.
4. twist (1 Szene, im letzten Drittel): Eine überraschende, aber im Nachhinein logische Wendung.
5. ending (genau 1 Szene): Ein letzter Satz, der nachhallt und Gänsehaut macht.

Länge: Der gesamte Erzähltext (alle narration-Felder zusammen) hat {length} Wörter. Jede Szene 1–3 kurze Sätze.
Schreibe für das Ohr: Präsens oder Präteritum konsequent, keine Klammern, keine Emojis, keine Regieanweisungen im Text.
Zahlen ausschreiben. Keine Abkürzungen.

Bildprompts (visual_prompt) auf Englisch: filmisch, konkret, ein klares Motiv pro Bild, gleiche Figurenbeschreibung
in jeder Szene, in der die Figur vorkommt, keine Schrift im Bild, kein Blut, kein Gore.
camera/transition/audio_cue passend zur Dramaturgie wählen (twist z. B. mit "impact" oder "riser", Übergang "flash").

{insights}

Diese Prämissen gab es schon — NICHT wiederholen oder variieren:
{avoid_txt}{fb}

Antworte nur mit JSON in exakt dieser Struktur:
{json.dumps(SCHEMA_EXAMPLE, ensure_ascii=False, indent=1)}"""


SYSTEM_REVIEW = """Du bist ein strenger Lektor und Shorts-Stratege. Du bewertest deutsche Kurz-Gruselgeschichten
ehrlich und kritisch. Antworte ausschließlich mit einem JSON-Objekt."""


def review_user_prompt(storyboard_json: str) -> str:
    return f"""Bewerte dieses Storyboard für einen 45–60-Sekunden-YouTube-Short (Skala 1–10, 10 = herausragend):

- hook: Fesselt der erste Satz sofort?
- suspense: Steigt die Spannung spürbar?
- twist: Ist die Wendung überraschend UND logisch?
- originality: Ist die Idee frisch, nicht abgedroschen?
- language: Natürliches, fehlerfreies gesprochenes Deutsch?
- visuals: Sind die Bildprompts konkret, filmisch und konsistent?

Antworte als JSON:
{{"scores": {{"hook": 0, "suspense": 0, "twist": 0, "originality": 0, "language": 0, "visuals": 0}},
  "verdict": "accept | reject", "feedback": ["konkrete Verbesserung 1", "konkrete Verbesserung 2"]}}

Storyboard:
{storyboard_json}"""
