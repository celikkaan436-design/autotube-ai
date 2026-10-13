"""[ECHTE INTEGRATIONSTESTS] — rufen die echten Dienste auf.

Laufen NUR mit RUN_LIVE=1 und gesetzten Secrets, sonst werden sie übersprungen.
In GitHub Actions übernimmt der Workflow „AutoTube · Steuerung → check“ diese Prüfung live.
"""
import os
import tempfile
import unittest
from pathlib import Path

from autotube.budget import Budget
from autotube.config import load_config, load_secrets
from autotube.state import State

LIVE = os.environ.get("RUN_LIVE") == "1"


@unittest.skipUnless(LIVE, "Live-Tests nur mit RUN_LIVE=1")
class LiveTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.cfg = load_config()
        self.sec = load_secrets()
        self.state = State.load(Path(self.tmp.name) / "s.json")
        self.budget = Budget(self.state, self.cfg.limits)

    def tearDown(self):
        self.tmp.cleanup()

    def test_text_ai(self):
        from autotube.providers import llm

        res, name = llm.generate_json(llm.build_chain(self.cfg, self.sec), self.budget, "Nur JSON.", 'Gib {"ok": true} zurück.')
        self.assertTrue(res.get("ok"), name)

    def test_image_ai(self):
        from autotube.providers import images

        meta = images.generate_scene_image(images.build_chain(self.cfg, self.sec), self.budget, "foggy lighthouse at night",
                                           Path(self.tmp.name) / "i.jpg", 512, 896, 1, spacing=0, allow_fallback=False)
        self.assertFalse(meta["fallback"])

    def test_edge_tts_word_timings(self):
        from autotube.providers import tts

        res = tts.synthesize_scene("Um drei Uhr klingelt das Telefon.", "hook", self.cfg.voice, self.budget,
                                   Path(self.tmp.name), "t", Path(self.tmp.name))
        self.assertGreater(res.duration, 1.0)
        self.assertGreaterEqual(len(res.words), 5)

    @unittest.skipUnless(os.environ.get("YOUTUBE_REFRESH_TOKEN"), "YouTube-Secrets fehlen")
    def test_youtube_channel(self):
        from autotube.youtube.client import YouTube

        ch = YouTube(self.sec, self.budget).channel()
        self.assertTrue(ch["id"].startswith("UC"))


if __name__ == "__main__":
    unittest.main()
