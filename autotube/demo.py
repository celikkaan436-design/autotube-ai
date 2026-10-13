"""Offline-Demo: rendert ein komplettes Video OHNE externe Dienste.

Nutzt ein festes Beispiel-Storyboard, prozedurale Bilder und eine synthetische Platzhalter-Stimme.
Dient zum Testen von Mix, Untertiteln, Rendering und QA (z. B. in CI). Das Ergebnis ist KEIN
veröffentlichungsfähiges Video — die echte Pipeline verwendet KI-Bilder und Neural-TTS.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from scipy import signal

from .media import music as mus
from .providers.images import procedural_image
from .providers.tts import TTSResult, estimate_word_timings, tokenize
from .story.schema import Storyboard

DEMO_STORY = {
    "title": "Der Anruf um drei Uhr siebzehn",
    "genre": "Horror",
    "logline": "Eine Frau wird jede Nacht von ihrer eigenen Nummer angerufen — bis sie merkt, dass sie selbst anruft.",
    "hook_style": "geheimnis",
    "setting": "Eine stille Altbauwohnung am Stadtrand, nachts",
    "visual_style": "cold blue moonlight, deep shadows, 1990s apartment interior, anamorphic lens",
    "characters": [{"name": "Mara", "visual": "woman in her 30s, shoulder-length dark hair, grey oversized sweater"}],
    "scenes": [
        {"beat": "hook", "narration": "Seit drei Wochen ruft mich jede Nacht meine eigene Nummer an.",
         "visual_prompt": "smartphone glowing on a dark nightstand showing an incoming call, dark bedroom",
         "camera": "dolly_in", "transition": "crossfade", "audio_cue": "drone", "mood": "cold", "characters": []},
        {"beat": "setup", "narration": "Ich wohne allein, im vierten Stock eines alten Hauses am Stadtrand. Das Telefon klingelt immer um drei Uhr siebzehn.",
         "visual_prompt": "old apartment building at night, one lit window on the fourth floor, fog",
         "camera": "pan_up", "transition": "crossfade", "audio_cue": "none", "mood": "dark", "characters": []},
        {"beat": "setup", "narration": "Wenn ich abhebe, höre ich nur Atmen. Und im Hintergrund das Ticken meiner Küchenuhr.",
         "visual_prompt": "woman holding a phone to her ear in a dark kitchen, wall clock behind her",
         "camera": "zoom_in", "transition": "fade_black", "audio_cue": "whoosh", "mood": "cold", "characters": ["Mara"]},
        {"beat": "escalation", "narration": "Gestern habe ich die Uhr abgehängt und in den Müll geworfen. Um drei Uhr siebzehn klingelte es wieder.",
         "visual_prompt": "old wall clock lying in a trash bin, harsh flashlight beam",
         "camera": "pan_left", "transition": "crossfade", "audio_cue": "heartbeat", "mood": "dark", "characters": []},
        {"beat": "escalation", "narration": "Diesmal flüsterte jemand: Du hast sie weggeworfen. Warum?",
         "visual_prompt": "extreme close-up of a woman's terrified eye reflecting a phone screen",
         "camera": "shake", "transition": "glitch", "audio_cue": "none", "mood": "red", "characters": ["Mara"]},
        {"beat": "escalation", "narration": "Ich schaltete alle Lichter ein und setzte mich mit dem Rücken zur Wand. Das Ticken kam jetzt aus dem Schlafzimmer.",
         "visual_prompt": "woman sitting on the floor against a wall in a bright hallway, bedroom door ajar and dark",
         "camera": "zoom_out", "transition": "crossfade", "audio_cue": "riser", "mood": "cold", "characters": ["Mara"]},
        {"beat": "twist", "narration": "Auf meinem Bett lag die Küchenuhr. Daneben mein Handy, das gerade eine Nummer wählte. Meine Nummer.",
         "visual_prompt": "wall clock lying on an unmade bed next to a glowing phone dialing, moonlight",
         "camera": "dolly_in", "transition": "flash", "audio_cue": "impact", "mood": "red", "characters": []},
        {"beat": "ending", "narration": "Seitdem weiß ich: Die Anrufe kommen nicht von außen. Ich rufe mich selbst an. Ich erinnere mich nur nie daran.",
         "visual_prompt": "silhouette of a woman standing at a window at night holding a phone, city lights far away",
         "camera": "zoom_out", "transition": "fade_black", "audio_cue": "sting", "mood": "dark", "characters": ["Mara"]},
    ],
    "youtube": {"title": "Jede Nacht ruft mich meine eigene Nummer an",
                "description": "Um drei Uhr siebzehn klingelt das Telefon. Am anderen Ende: nur Atmen.",
                "tags": ["Gruselgeschichte", "Horror"], "thumbnail_text": "Meine eigene Nummer"},
}


def demo_storyboard() -> Storyboard:
    sb = Storyboard.model_validate(DEMO_STORY)
    sb.id = "demo"
    return sb


def placeholder_voice(text: str, out_wav: Path, seed: int, rate_pct: int = 0) -> TTSResult:
    """Synthetische 'Sprach'-Hüllkurve (Formant-Summen) — nur für Offline-Tests."""
    rng = np.random.default_rng(seed)
    words = tokenize(text)
    sr = mus.SR
    pieces = []
    for w in words:
        dur = (0.12 + 0.045 * len(w)) / (1 + rate_pct / 100)
        n = int(dur * sr)
        t = np.arange(n) / sr
        f0 = 105 + 12 * np.sin(2 * np.pi * rng.uniform(0.5, 2) * t)
        pulse = signal.sawtooth(2 * np.pi * np.cumsum(f0) / sr)
        f1, f2 = rng.uniform(450, 800), rng.uniform(1100, 2200)
        y = signal.sosfilt(signal.butter(2, [f1 * 0.8, f1 * 1.2], "band", fs=sr, output="sos"), pulse)
        y += 0.6 * signal.sosfilt(signal.butter(2, [f2 * 0.85, f2 * 1.15], "band", fs=sr, output="sos"), pulse)
        y *= np.sin(np.linspace(0, np.pi, n)) ** 0.6
        gap = 0.05 + (0.25 if w[-1] in ".!?" else 0.12 if w[-1] in ",:" else 0)
        pieces += [y, np.zeros(int(gap * sr))]
    audio = np.concatenate(pieces)
    audio = audio / (np.max(np.abs(audio)) + 1e-9) * 0.5
    mus.write_wav(out_wav, audio)
    dur = len(audio) / sr
    return TTSResult(str(out_wav), dur, estimate_word_timings(words, dur, lead=0.0, tail=0.05), "placeholder", "demo", True)


def demo_assets(work: Path, sb: Storyboard) -> tuple[list[TTSResult], list[Path]]:
    work.mkdir(parents=True, exist_ok=True)
    results, images = [], []
    for i, scene in enumerate(sb.scenes):
        results.append(placeholder_voice(scene.narration, work / f"voice_{i:02d}.wav", i))
        p = work / f"scene_{i:02d}.jpg"
        procedural_image(864, 1536, 1000 + i, scene.mood).save(p, "JPEG", quality=92)
        images.append(p)
    (work / "story.json").write_text(json.dumps(sb.model_dump(), ensure_ascii=False, indent=2), encoding="utf-8")
    return results, images
