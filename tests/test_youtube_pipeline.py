"""[GEMOCKT/OFFLINE] YouTube-OAuth/Upload-Protokoll, Metadaten, Scheduler-Idempotenz, Duplikatschutz, Analytics-Lernen."""
import json
import random
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

from autotube import analysis, pipeline
from autotube.config import Config, Secrets
from autotube.http import HttpError
from autotube.story.schema import Storyboard
from autotube.youtube import client as ytc
from tests.helpers import TmpCtx, good_story

SECRETS = dict(google_client_id="cid", google_client_secret="GOCSPX-test", youtube_refresh_token="1//refreshtokenvalue123456789")


class Resp:
    def __init__(self, status=200, body=None, headers=None):
        self.status_code = status
        self._body = body if body is not None else {}
        self.headers = headers or {}
        self.text = json.dumps(self._body)
        self.content = self.text.encode()

    def json(self):
        return self._body


class OAuthUploadTests(unittest.TestCase):
    def test_token_refresh_and_revocation(self):
        t = TmpCtx(**SECRETS)
        yt = ytc.YouTube(t.secrets, t.ctx.budget)
        with mock.patch.object(ytc, "request", return_value=Resp(200, {"access_token": "ya29.abc", "expires_in": 3600,
                                                                        "scope": " ".join(ytc.SCOPES)})) as rq:
            self.assertEqual(yt.token(), "ya29.abc")
            yt.token()
            self.assertEqual(rq.call_count, 1)  # zwischengespeichert
        yt2 = ytc.YouTube(t.secrets, t.ctx.budget)
        with mock.patch.object(ytc, "request", side_effect=HttpError(400, '{"error":"invalid_grant"}', ytc.TOKEN_URL)):
            with self.assertRaises(ytc.AuthRevoked):
                yt2.token()

    def test_not_configured(self):
        t = TmpCtx()
        with self.assertRaises(ytc.NotConfigured):
            ytc.YouTube(t.secrets, t.ctx.budget)

    def test_quota_classification(self):
        e = ytc._classify(HttpError(403, json.dumps({"error": {"errors": [{"reason": "quotaExceeded"}]}}), "u"))
        self.assertIsInstance(e, ytc.QuotaExceeded)

    def test_resumable_upload_resumes_after_interruption(self):
        t = TmpCtx(**SECRETS)
        yt = ytc.YouTube(t.secrets, t.ctx.budget)
        yt._token, yt._token_exp = "ya29.x", 1e12
        with tempfile.TemporaryDirectory() as d:
            f = Path(d) / "v.mp4"
            f.write_bytes(b"0" * (ytc.CHUNK + 1000))
            seq = [
                Resp(200, {}, {"Location": "https://upload/session"}),             # Session
                Resp(308, {}, {"Range": f"bytes=0-{ytc.CHUNK - 1}"}),               # Chunk 1 ok
                Resp(503, {}),                                                      # Chunk 2 bricht ab
                Resp(308, {}, {"Range": f"bytes=0-{ytc.CHUNK - 1}"}),               # Statusabfrage
                Resp(201, {"id": "VID123", "status": {"privacyStatus": "private"}}),  # Chunk 2 erneut
            ]
            with mock.patch.object(ytc, "request", side_effect=seq) as rq, mock.patch.object(ytc.time, "sleep"):
                out = yt.upload(f, {"snippet": {}, "status": {}})
        self.assertEqual(out["id"], "VID123")
        ranges = [c.kwargs["headers"].get("Content-Range") for c in rq.call_args_list[1:]]
        self.assertEqual(ranges[0], f"bytes 0-{ytc.CHUNK - 1}/{ytc.CHUNK + 1000}")
        self.assertEqual(ranges[-1], f"bytes {ytc.CHUNK}-{ytc.CHUNK + 999}/{ytc.CHUNK + 1000}")

    def test_metadata(self):
        sb = Storyboard.model_validate(good_story())
        meta = ytc.build_metadata(sb, Config(), "2026-10-10T16:00:00Z", "2026-10-10")
        st = meta["status"]
        self.assertEqual(st["privacyStatus"], "private")
        self.assertEqual(st["publishAt"], "2026-10-10T16:00:00Z")
        self.assertTrue(st["containsSyntheticMedia"])
        self.assertFalse(st["selfDeclaredMadeForKids"])
        self.assertIn("#shorts", meta["snippet"]["title"])
        self.assertIn("AutoTube-ID: 2026-10-10", meta["snippet"]["description"])
        self.assertIn("KI erstellt", meta["snippet"]["description"])
        self.assertLessEqual(len(meta["snippet"]["title"]), 100)
        self.assertNotIn("publishAt", ytc.build_metadata(sb, Config(), None, "x")["status"])


class FakeYT:
    instances = []

    def __init__(self, secrets, budget, existing=None, publish_ok=True):
        self.uploads = []
        self.existing = existing
        self.publish_ok = publish_ok
        FakeYT.instances.append(self)

    def channel(self):
        return {"id": "UC1", "title": "Kanal", "uploads_playlist": "UU1", "subscribers": 10}

    def find_by_marker(self, pl, marker):
        return self.existing

    def upload(self, path, meta):
        self.uploads.append(meta)
        return {"id": f"VID{len(self.uploads)}"}

    def set_thumbnail(self, vid, img):
        return True

    def video_status(self, vid):
        meta = self.uploads[-1] if self.uploads else {"status": {}}
        return {"video_id": vid, "privacy": "private", "publish_at": meta["status"].get("publishAt") if self.publish_ok else None,
                "upload_status": "uploaded"}


def fake_production(ctx, key, record_day=True):
    sb = Storyboard.model_validate(good_story())
    sb.id = f"{key}-abc"
    d = Path(ctx.work_root) / key
    d.mkdir(parents=True, exist_ok=True)
    (d / "final.mp4").write_bytes(b"x")
    (d / "thumb.jpg").write_bytes(b"x")
    if record_day:
        ctx.state.set_day(key, status="qa_passed", story_id=sb.id)
    return pipeline.Production(key, sb, d / "final.mp4", d / "thumb.jpg",
                               {"duration": 52.0, "sha256": "h", "lufs": -14, "checks": {}, "passed": True}, None, [])


MORNING = datetime(2026, 10, 10, 5, 17, tzinfo=timezone.utc)


class SchedulerTests(unittest.TestCase):
    def _run(self, t, yt_kwargs=None):
        yt_kwargs = yt_kwargs or {}
        with mock.patch.object(pipeline, "YouTube", lambda s, b: FakeYT(s, b, **yt_kwargs)), \
             mock.patch.object(pipeline, "produce", side_effect=fake_production) as prod, \
             mock.patch.object(pipeline, "_release", return_value=None), \
             mock.patch.object(pipeline, "now_utc", return_value=MORNING):
            res = pipeline.run_daily(t.ctx)
        return res, prod, FakeYT.instances[-1] if FakeYT.instances else None

    def test_inactive_autopilot_does_nothing(self):
        t = TmpCtx(**SECRETS)
        with mock.patch.object(pipeline, "produce") as prod:
            self.assertEqual(pipeline.run_daily(t.ctx), "inactive")
            prod.assert_not_called()

    def test_scheduled_publish_and_idempotency(self):
        t = TmpCtx(**SECRETS)
        t.state.data["autopilot"]["enabled"] = True
        t.state.data["first_private_upload"] = {"video_id": "OLD"}
        res, prod, yt = self._run(t)
        self.assertEqual(res, "scheduled")
        self.assertEqual(len(yt.uploads), 1)
        self.assertEqual(yt.uploads[0]["status"]["publishAt"], "2026-10-10T16:00:00Z")  # 18:00 MESZ
        day = t.state.day("2026-10-10")
        self.assertEqual(day["status"], "scheduled")
        self.assertEqual(day["video_id"], "VID1")
        # zweiter Lauf am selben Tag: kein zweites Video
        res2, prod2, _ = self._run(t)
        self.assertEqual(res2, "already_done")
        prod2.assert_not_called()

    def test_remote_duplicate_prevented(self):
        t = TmpCtx(**SECRETS)
        t.state.data["autopilot"]["enabled"] = True
        res, prod, yt = self._run(t, {"existing": {"video_id": "EXIST", "description": "AutoTube-ID: 2026-10-10"}})
        self.assertEqual(res, "already_uploaded")
        prod.assert_not_called()
        self.assertEqual(yt.uploads, [])

    def test_first_upload_is_private_without_schedule(self):
        t = TmpCtx(**SECRETS)
        t.state.data["autopilot"]["enabled"] = True
        res, _, yt = self._run(t)
        self.assertEqual(res, "uploaded_private_first")
        self.assertNotIn("publishAt", yt.uploads[0]["status"])
        self.assertEqual(t.state.data["first_private_upload"]["video_id"], "VID1")

    def test_locked_private_reported_honestly(self):
        t = TmpCtx(**SECRETS)
        t.state.data["autopilot"]["enabled"] = True
        t.state.data["first_private_upload"] = {"video_id": "OLD"}
        res, _, _ = self._run(t, {"publish_ok": False})
        self.assertEqual(res, "uploaded_private_locked")
        self.assertIn("Audit", t.state.day("2026-10-10")["note"])

    def test_failure_retries_then_notifies_on_last_attempt(self):
        t = TmpCtx(**SECRETS)
        t.state.data["autopilot"]["enabled"] = True
        late = datetime(2026, 10, 10, 14, 7, tzinfo=timezone.utc)  # 16:07 MESZ = letzter Versuch
        with mock.patch.object(pipeline, "YouTube", lambda s, b: FakeYT(s, b)), \
             mock.patch.object(pipeline, "produce", side_effect=pipeline.ProductionError("Bild-KI down")), \
             mock.patch.object(pipeline, "now_utc", return_value=late), \
             mock.patch.object(t.ctx.gh, "notify") as notify:
            with self.assertRaises(pipeline.ProductionError):
                pipeline.run_daily(t.ctx)
        self.assertEqual(t.state.day("2026-10-10")["status"], "failed")
        notify.assert_called_once()

    def test_verify_confirms_only_real_public_status(self):
        t = TmpCtx(**SECRETS)
        t.state.set_day("2026-10-10", status="scheduled", video_id="V1", title="T", genre="Horror")
        t.state.set_day("2026-10-09", status="uploaded", video_id="V0", title="Alt", genre="Mystery")

        class VerifyYT(FakeYT):
            def video_status(self, vid):
                return {"video_id": vid, "privacy": "public" if vid == "V1" else "private", "upload_status": "processed",
                        "publish_at": None, "title": "T"}

            def videos(self, ids):
                return [{"id": i, "statistics": {"viewCount": "42"}} for i in ids]

            def video_analytics(self, vid, published):
                return {"views": 42, "averageViewPercentage": 77.0}

            def channel_daily(self, days):
                return [{"day": "2026-10-10", "views": 42}]

        evening = datetime(2026, 10, 10, 17, 23, tzinfo=timezone.utc)
        with mock.patch.object(pipeline, "YouTube", lambda s, b: VerifyYT(s, b)), \
             mock.patch.object(pipeline, "now_utc", return_value=evening), \
             mock.patch.object(t.ctx.gh, "notify") as notify:
            out = pipeline.run_verify(t.ctx)
        self.assertEqual(out["confirmed"], ["V1"])
        self.assertEqual(t.state.day("2026-10-10")["status"], "published")
        self.assertEqual(t.state.day("2026-10-09")["status"], "not_public")  # ehrlich gemeldet, nicht als öffentlich
        notify.assert_called_once()
        self.assertEqual(t.state.data["analytics"]["videos"]["V1"]["analytics"]["views"], 42)
        self.assertEqual(t.state.find_video("V1")["date"], "2026-10-10")

    def test_activation_requires_preflight(self):
        t = TmpCtx(**SECRETS)
        with mock.patch.object(pipeline, "preflight", return_value={"passed": False, "checks": {"youtube": {"ok": False, "required": True}}}):
            self.assertFalse(pipeline.activate(t.ctx))
        self.assertFalse(t.state.autopilot_enabled)
        with mock.patch.object(pipeline, "preflight", return_value={"passed": True, "checks": {}}):
            self.assertTrue(pipeline.activate(t.ctx))
        self.assertTrue(t.state.autopilot_enabled)


class AnalysisTests(unittest.TestCase):
    def test_learns_from_real_numbers(self):
        t = TmpCtx()
        an = t.state.data["analytics"]["videos"]
        for i, (genre, avp, views) in enumerate([("Horror", 85, 5000), ("Horror", 80, 3000), ("Mystery", 30, 100), ("Mystery", 25, 80)]):
            vid = f"v{i}"
            t.state.add_video({"video_id": vid, "genre": genre, "hook_style": "frage", "title": f"T{i}", "duration": 50})
            an[vid] = {"analytics": {"averageViewPercentage": avp, "views": views}}
        ins = analysis.build_insights(t.state)
        self.assertTrue(ins["enough_data"])
        self.assertGreater(ins["genres"]["Horror"]["score"], ins["genres"]["Mystery"]["score"])
        rng = random.Random(0)
        picks = [analysis.choose(["Horror", "Mystery"], ins["genres"], rng) for _ in range(400)]
        self.assertGreater(picks.count("Horror"), picks.count("Mystery"))
        self.assertIn("Gut gelaufen", analysis.prompt_insights(t.state))

    def test_no_data_explores(self):
        t = TmpCtx()
        self.assertFalse(analysis.build_insights(t.state)["enough_data"])


if __name__ == "__main__":
    unittest.main()
