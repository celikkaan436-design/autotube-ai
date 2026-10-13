"""[GEMOCKT/OFFLINE, LANGSAM] Kompletter produce()-Durchlauf: Story-Engine → Stimme → Bilder → Mix → Rendering → QA.

Externe KI-Dienste sind durch lokale Fakes ersetzt (Platzhalter-Stimme, prozedurale Bilder).
Rendering, Audio-Mix, Untertitel und Qualitätsprüfung laufen ECHT mit FFmpeg.
Aktiv mit RUN_SLOW=1 (in CI gesetzt).
"""
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from autotube import pipeline
from autotube.demo import placeholder_voice
from autotube.providers import images as imgs
from autotube.providers import llm, tts
from autotube.story import engine
from tests.helpers import TmpCtx, good_story
from tests.test_story import FakeProvider


class FakeImage:
    name = "fake-ai"
    paid = False

    def generate(self, prompt, w, h, seed):
        return imgs.procedural_image(w, h, seed + len(prompt), "dark")


def fake_tts(text, beat, cfg, budget, out_dir, stem, cache_dir):
    budget.record("tts", "fake")
    out_dir.mkdir(parents=True, exist_ok=True)
    rate = cfg.base_rate + tts.BEAT_PROSODY.get(beat, (0, 0))[0]
    return placeholder_voice(text, out_dir / f"{stem}.wav", len(text), rate)


@unittest.skipUnless(os.environ.get("RUN_SLOW") == "1", "langsamer End-to-End-Test nur mit RUN_SLOW=1")
class ProduceE2ETests(unittest.TestCase):
    def test_full_production_offline(self):
        t = TmpCtx()
        t.config.images.request_spacing_seconds = 0
        t.config.video.preset = "veryfast"
        review = {"scores": {k: 8.5 for k in engine.REVIEW_KEYS}, "verdict": "accept", "feedback": []}
        prov = FakeProvider("gemini", [json.dumps(good_story()), json.dumps(review)])
        with tempfile.TemporaryDirectory() as d, \
             mock.patch("autotube.paths.STORIES_DIR", Path(d)), \
             mock.patch.object(llm, "build_chain", return_value=[prov]), \
             mock.patch.object(imgs, "build_chain", return_value=[FakeImage()]), \
             mock.patch.object(tts, "synthesize_scene", side_effect=fake_tts):
            prod = pipeline.produce(t.ctx, "2026-10-10")
            saved = json.loads((Path(d) / f"{prod.storyboard.id}.json").read_text())
        self.assertTrue(prod.qa["passed"], {k: c for k, c in prod.qa["checks"].items() if not c["ok"]})
        self.assertTrue(prod.video.exists() and prod.thumbnail.exists())
        self.assertLess(prod.thumbnail.stat().st_size, 2_000_000)
        day = t.state.day("2026-10-10")
        self.assertEqual(day["status"], "qa_passed")
        self.assertEqual(day["fallback_images"], 0)
        self.assertIn("timeline", saved)
        self.assertEqual(len(saved["timeline"]["scenes"]), len(saved["scenes"]))
        self.assertEqual(len(t.state.data["stories"]), 1)
        # Checkpoints vorhanden → ein erneuter Lauf startet nicht von vorn
        work = t.ctx.work_root / "2026-10-10"
        for f in ("story.json", "voice/scene_00.json", "images/meta.json", "final.mp4"):
            self.assertTrue((work / f).exists(), f)
        self.assertEqual(prov.calls, 2)


if __name__ == "__main__":
    unittest.main()
