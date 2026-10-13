"""[GEMOCKT/OFFLINE] Story-Engine: Schema, Regeln, Ähnlichkeit, Anbieter-Fallback, Review-Schleife."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from autotube.providers import llm
from autotube.story import engine, rules
from autotube.story.schema import Storyboard
from autotube.story.similarity import max_similarity, story_text
from tests.helpers import TmpCtx, good_story


class FakeProvider(llm.Provider):
    def __init__(self, name, replies):
        self.name = name
        self.replies = list(replies)
        self.calls = 0

    def complete(self, system, user, temperature):
        self.calls += 1
        r = self.replies.pop(0)
        if isinstance(r, Exception):
            raise r
        return r


class SchemaTests(unittest.TestCase):
    def test_aliases_are_normalized(self):
        d = good_story()
        d["scenes"][0]["camera"] = "Push-In"
        d["scenes"][1]["transition"] = "dissolve"
        d["scenes"][6]["beat"] = "Plot_Twist"
        d["scenes"][2]["audio_cue"] = "boom"
        sb = Storyboard.model_validate(d)
        self.assertEqual(sb.scenes[0].camera, "dolly_in")
        self.assertEqual(sb.scenes[1].transition, "crossfade")
        self.assertEqual(sb.scenes[6].beat, "twist")
        self.assertEqual(sb.scenes[2].audio_cue, "impact")

    def test_scene_prompt_carries_character(self):
        d = good_story()
        d["scenes"][1]["characters"] = ["Jonas"]
        sb = Storyboard.model_validate(d)
        self.assertIn("dark green hoodie", sb.scene_prompt(1, "cinematic"))


class RuleTests(unittest.TestCase):
    def setUp(self):
        self.cfg = TmpCtx().config

    def test_good_story_passes(self):
        sb = Storyboard.model_validate(good_story())
        self.assertEqual(rules.check(sb, self.cfg), [], sb.word_count)

    def test_missing_twist_and_wrong_order(self):
        d = good_story()
        d["scenes"][6]["beat"] = "escalation"
        issues = rules.check(Storyboard.model_validate(d), self.cfg)
        self.assertTrue(any("Twist" in i for i in issues))
        d = good_story()
        d["scenes"][1]["beat"] = "twist"
        issues = rules.check(Storyboard.model_validate(d), self.cfg)
        self.assertTrue(any("früh" in i or "Reihenfolge" in i for i in issues))

    def test_too_short(self):
        d = good_story()
        for s in d["scenes"]:
            s["narration"] = "Kurz und knapp."
        self.assertTrue(any("zu kurz" in i for i in rules.check(Storyboard.model_validate(d), self.cfg)))


class SimilarityTests(unittest.TestCase):
    def test_duplicate_detected_and_new_story_ok(self):
        a = Storyboard.model_validate(good_story())
        same = story_text(a.title, a.logline, a.script)
        other = story_text("Der Leuchtturm", "Ein Leuchtturmwärter findet Briefe aus der Zukunft im Sand.",
                           "Die Briefe sind in meiner Handschrift geschrieben. Morgen ist das Datum auf dem letzten Brief.")
        sim, _ = max_similarity(same, [other, same])
        self.assertGreater(sim, 0.95)
        sim2, _ = max_similarity(other, [same])
        self.assertLess(sim2, 0.3)


class LLMTests(unittest.TestCase):
    def test_extract_json_variants(self):
        self.assertEqual(llm.extract_json('```json\n{"a": 1,}\n```'), {"a": 1})
        self.assertEqual(llm.extract_json('Hier: {"b": [1,2,]} danke'), {"b": [1, 2]})
        with self.assertRaises(llm.LLMError):
            llm.extract_json("kein json")

    def test_falls_back_to_next_provider(self):
        t = TmpCtx()
        p1 = FakeProvider("gemini", [llm.LLMError("429 quota")])
        p2 = FakeProvider("pollinations", ['{"ok": true}'])
        res, name = llm.generate_json([p1, p2], t.ctx.budget, "s", "u")
        self.assertEqual((res, name), ({"ok": True}, "pollinations"))
        self.assertEqual(t.ctx.budget.total("llm:"), 2)

    def test_validation_error_tries_next(self):
        t = TmpCtx()
        p1 = FakeProvider("gemini", ['{"title": 1}'])
        p2 = FakeProvider("pollinations", [json.dumps(good_story())])
        sb, name = llm.generate_json([p1, p2], t.ctx.budget, "s", "u", validate=Storyboard.model_validate)
        self.assertEqual(name, "pollinations")
        self.assertIsInstance(sb, Storyboard)


class EngineTests(unittest.TestCase):
    def test_rejects_weak_then_accepts(self):
        t = TmpCtx()
        bad = good_story()
        bad["scenes"] = bad["scenes"][:3]  # zu wenige Szenen
        review_low = {"scores": {k: 5 for k in engine.REVIEW_KEYS}, "verdict": "reject", "feedback": ["Twist schwach"]}
        review_hi = {"scores": {k: 8.5 for k in engine.REVIEW_KEYS}, "verdict": "accept", "feedback": []}
        second = good_story(title="Das Klopfen im zehnten Stock II")
        p = FakeProvider("gemini", [json.dumps(bad), json.dumps(good_story()), json.dumps(review_low),
                                    json.dumps(second), json.dumps(review_hi)])
        with tempfile.TemporaryDirectory() as d, mock.patch("autotube.paths.STORIES_DIR", Path(d)):
            sb = engine.create_story(t.config, t.state, t.ctx.budget, [p], "2026-10-10", seed=1)
        self.assertEqual(sb.title, "Das Klopfen im zehnten Stock II")
        self.assertEqual(sb.review["average"], 8.5)
        self.assertTrue(sb.id.startswith("2026-10-10-"))
        self.assertEqual(p.calls, 5)

    def test_duplicate_of_history_rejected(self):
        t = TmpCtx()
        with tempfile.TemporaryDirectory() as d, mock.patch("autotube.paths.STORIES_DIR", Path(d)):
            old = Storyboard.model_validate(good_story())
            old.id = "2026-10-01-aaaaaa"
            engine.save_story(old)
            engine.register_story(t.state, old, "2026-10-01")
            review = {"scores": {k: 9 for k in engine.REVIEW_KEYS}, "verdict": "accept"}
            p = FakeProvider("gemini", [json.dumps(good_story())] * 4 + [json.dumps(review)])
            t.config.llm.max_story_attempts = 4
            with self.assertRaises(engine.StoryError):
                engine.create_story(t.config, t.state, t.ctx.budget, [p], "2026-10-10", seed=1)


if __name__ == "__main__":
    unittest.main()
