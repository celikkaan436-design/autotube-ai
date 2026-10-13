"""Zeitachse: setzt Szenen, Sprachausgabe, Wörter und Übergänge zu einem exakten Ablauf zusammen."""
from __future__ import annotations

from dataclasses import asdict, dataclass, field

from ..providers.tts import TTSResult, Word

LEAD_IN = 0.12   # Hook startet praktisch sofort
TAIL = 1.7       # Ausklang nach dem letzten Satz (Sting + Fade)


@dataclass
class SceneTiming:
    index: int
    beat: str
    start: float          # Bild sichtbar ab
    end: float            # Bild sichtbar bis
    voice_start: float
    voice_end: float
    camera: str
    transition: str       # Übergang in die nächste Szene
    audio_cue: str
    mood: str

    @property
    def duration(self) -> float:
        return self.end - self.start


@dataclass
class Timeline:
    duration: float
    scenes: list[SceneTiming] = field(default_factory=list)
    words: list[Word] = field(default_factory=list)
    twist_time: float | None = None

    def to_json(self) -> dict:
        return {
            "duration": round(self.duration, 3),
            "twist_time": self.twist_time,
            "scenes": [asdict(s) for s in self.scenes],
            "words": [asdict(w) for w in self.words],
        }


def build_timeline(storyboard, tts: list[TTSResult], pause: float, pause_before_twist: float) -> Timeline:
    scenes = storyboard.scenes
    assert len(scenes) == len(tts), "Jede Szene braucht genau eine Sprachaufnahme"
    t = LEAD_IN
    voice_spans: list[tuple[float, float]] = []
    words: list[Word] = []
    for i, (scene, res) in enumerate(zip(scenes, tts)):
        if i > 0:
            t += pause_before_twist if scene.beat == "twist" else pause
        vs, ve = t, t + res.duration
        voice_spans.append((vs, ve))
        for w in res.words:
            words.append(Word(w.text, round(vs + w.start, 3), round(vs + min(w.end, res.duration), 3)))
        t = ve
    total = t + TAIL
    timings: list[SceneTiming] = []
    for i, scene in enumerate(scenes):
        vs, ve = voice_spans[i]
        start = 0.0 if i == 0 else (voice_spans[i - 1][1] + vs) / 2
        end = total if i == len(scenes) - 1 else (ve + voice_spans[i + 1][0]) / 2
        timings.append(SceneTiming(i, scene.beat, round(start, 3), round(end, 3), round(vs, 3), round(ve, 3),
                                   scene.camera, scene.transition, scene.audio_cue, scene.mood))
    twist = next((s.start for s in timings if s.beat == "twist"), None)
    return Timeline(round(total, 3), timings, words, twist)
