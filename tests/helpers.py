"""Gemeinsame Test-Hilfen. Alle Tests in diesem Ordner sind OFFLINE (externe Dienste gemockt),
außer test_live_integration.py, das nur mit RUN_LIVE=1 und echten Secrets läuft."""
from __future__ import annotations

import json
import tempfile
from pathlib import Path

from autotube.budget import Budget
from autotube.config import Config, Secrets
from autotube.github import GitHub
from autotube.pipeline import Context
from autotube.state import State


def good_story(**over) -> dict:
    scenes = [
        {"beat": "hook", "narration": "Jede Nacht um drei klopft es an meiner Tür, obwohl ich im zehnten Stock wohne.",
         "visual_prompt": "dark apartment door seen from inside, faint light under the door, night", "camera": "dolly_in"},
        {"beat": "setup", "narration": "Ich heiße Jonas und lebe allein in einem alten Hochhaus am Hafen. Der Flur draußen ist seit Jahren leer und still.",
         "visual_prompt": "old high-rise building by a harbor at night, fog, single lit window"},
        {"beat": "setup", "narration": "Der Hausmeister sagt, auf meiner Etage wohnt außer mir niemand mehr, schon seit dem Brand vor zwanzig Jahren.",
         "visual_prompt": "elderly caretaker in a dim stairwell holding a ring of keys, cinematic"},
        {"beat": "escalation", "narration": "In der ersten Woche ignoriere ich das Klopfen. In der zweiten Woche höre ich danach Schritte, die sich langsam entfernen.",
         "visual_prompt": "empty corridor with flickering ceiling lights, wet footprints on the floor"},
        {"beat": "escalation", "narration": "Gestern habe ich eine Kamera im Flur versteckt. Die Aufnahme zeigt um drei Uhr niemanden, doch das Klopfen ist trotzdem zu hören.",
         "visual_prompt": "small security camera hidden behind a plant in a dark hallway, red recording light"},
        {"beat": "escalation", "narration": "Heute Nacht schaue ich zum ersten Mal durch den Türspion, mit zitternden Händen und angehaltenem Atem.",
         "visual_prompt": "extreme close-up of an eye at a door peephole, cold light", "camera": "shake"},
        {"beat": "twist", "narration": "Draußen steht niemand. Aber das Klopfen kommt jetzt von innen, aus meinem Kleiderschrank, und es ruft leise meinen Namen.",
         "visual_prompt": "closed wardrobe in a dark bedroom, thin line of light between the doors", "transition": "flash",
         "audio_cue": "impact", "mood": "red"},
        {"beat": "ending", "narration": "Ich öffne nicht. Denn auf der Aufnahme von gestern sieht man, wie ich selbst um drei Uhr hineinsteige.",
         "visual_prompt": "silhouette of a man stepping into a wardrobe, grainy security camera view", "audio_cue": "sting"},
    ]
    data = {
        "title": "Das Klopfen im zehnten Stock",
        "genre": "Horror",
        "logline": "Ein Mann hört jede Nacht ein Klopfen, bis er erkennt, dass er selbst klopft.",
        "hook_style": "geheimnis",
        "setting": "Ein altes Hochhaus am Hafen",
        "visual_style": "cold teal night, sodium lights",
        "characters": [{"name": "Jonas", "visual": "man in his 30s, stubble, dark green hoodie"}],
        "scenes": scenes,
        "youtube": {"title": "Jede Nacht klopft es um drei Uhr", "description": "Niemand wohnt mehr auf seiner Etage. Wer klopft?",
                    "tags": ["Horror"], "thumbnail_text": "Wer klopft da?"},
    }
    data.update(over)
    return data


class TmpCtx:
    """Kontext mit temporärem Zustand und ohne echte Secrets."""

    def __init__(self, **secrets):
        self.dir = tempfile.TemporaryDirectory()
        root = Path(self.dir.name)
        self.state = State.load(root / "state.json")
        self.config = Config()
        self.secrets = Secrets(**secrets)
        self.ctx = Context(self.config, self.secrets, self.state, Budget(self.state, self.config.limits),
                           GitHub(self.secrets), work_root=root / "work")
        self.root = root

    def cleanup(self):
        self.dir.cleanup()


def dump(obj) -> str:
    return json.dumps(obj, ensure_ascii=False)
