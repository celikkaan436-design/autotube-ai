"""[GEMOCKT/OFFLINE] Konfiguration, Zeitzonen, Zustand, Budget."""
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from pydantic import ValidationError

from autotube.budget import Budget, BudgetExceeded, PaidProviderBlocked
from autotube.config import Config, LimitsConfig, load_config
from autotube.state import State
from autotube.timeutil import next_slot, to_rfc3339_utc


class ConfigTests(unittest.TestCase):
    def test_repo_config_valid(self):
        cfg = load_config()
        self.assertEqual((cfg.video.width, cfg.video.height), (1080, 1920))
        self.assertFalse(cfg.limits.allow_paid_providers)
        self.assertEqual(cfg.publish_time, "18:00")

    def test_rejects_wrong_timezone_and_format(self):
        with self.assertRaises(ValidationError):
            Config(timezone="UTC")
        with self.assertRaises(ValidationError):
            Config.model_validate({"video": {"width": 1920, "height": 1080}})
        with self.assertRaises(ValidationError):
            Config(publish_time="25:00")


class TimeTests(unittest.TestCase):
    def test_summer_time_slot(self):
        now = datetime(2026, 7, 1, 5, 17, tzinfo=timezone.utc)  # 07:17 MESZ
        slot = next_slot(now, "18:00", 45)
        self.assertEqual(to_rfc3339_utc(slot), "2026-07-01T16:00:00Z")

    def test_winter_time_slot(self):
        now = datetime(2026, 12, 1, 5, 17, tzinfo=timezone.utc)  # 06:17 MEZ
        self.assertEqual(to_rfc3339_utc(next_slot(now, "18:00", 45)), "2026-12-01T17:00:00Z")

    def test_dst_switch_days(self):
        self.assertEqual(to_rfc3339_utc(next_slot(datetime(2026, 3, 29, 6, tzinfo=timezone.utc))), "2026-03-29T16:00:00Z")
        self.assertEqual(to_rfc3339_utc(next_slot(datetime(2026, 10, 25, 6, tzinfo=timezone.utc))), "2026-10-25T17:00:00Z")

    def test_late_run_moves_to_next_day(self):
        now = datetime(2026, 7, 1, 15, 30, tzinfo=timezone.utc)  # 17:30 MESZ → zu knapp
        self.assertEqual(next_slot(now, "18:00", 45).date().isoformat(), "2026-07-02")


class StateTests(unittest.TestCase):
    def test_roundtrip_and_validation(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "state.json"
            s = State.load(p)
            s.set_day("2026-10-10", status="story_ready", title="X")
            s.add_video({"video_id": "abc", "title": "A"})
            s.add_video({"video_id": "abc", "privacy": "public"})
            s.save()
            s2 = State.load(p)
            self.assertEqual(s2.day("2026-10-10")["status"], "story_ready")
            self.assertEqual(len(s2.data["videos"]), 1)
            self.assertEqual(s2.find_video("abc")["privacy"], "public")
            self.assertEqual(s2.find_video("abc")["title"], "A")
            with self.assertRaises(ValueError):
                s2.set_day("2026-10-10", status="erfunden")


class BudgetTests(unittest.TestCase):
    def test_daily_limit_enforced(self):
        s = State({"usage": {}}, Path("/dev/null"))
        b = Budget(s, LimitsConfig(llm_calls_per_day=2))
        b.check("llm"); b.record("llm", "gemini")
        b.check("llm"); b.record("llm", "pollinations")
        with self.assertRaises(BudgetExceeded):
            b.check("llm")

    def test_paid_providers_blocked(self):
        s = State({"usage": {}}, Path("/dev/null"))
        with self.assertRaises(PaidProviderBlocked):
            Budget(s, LimitsConfig()).check("llm", paid=True)

    def test_youtube_units(self):
        s = State({"usage": {}}, Path("/dev/null"))
        b = Budget(s, LimitsConfig(youtube_units_per_day=2000))
        b.youtube("upload")
        with self.assertRaises(BudgetExceeded):
            b.youtube("upload")


if __name__ == "__main__":
    unittest.main()
