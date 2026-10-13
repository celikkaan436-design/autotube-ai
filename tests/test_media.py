"""[GEMOCKT/OFFLINE] TTS-Logik, Zeitachse, Untertitel, Musik, echtes FFmpeg-Rendering + QA."""
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import numpy as np

from autotube.config import Config, VideoConfig
from autotube.media import music, qa, render, subtitles
from autotube.media.timeline import build_timeline
from autotube.providers import tts
from autotube.providers.images import procedural_image
from autotube.story.schema import Storyboard
from tests.helpers import TmpCtx, good_story


class TTSTests(unittest.TestCase):
    def test_estimated_timings_monotonic(self):
        words = tts.tokenize("Ich öffne nicht. Denn auf der Aufnahme sieht man mich, wie ich hineinsteige.")
        ws = tts.estimate_word_timings(words, 5.0)
        self.assertEqual(len(ws), len(words))
        self.assertTrue(all(a.end <= b.start + 1e-6 for a, b in zip(ws, ws[1:])))
        self.assertLessEqual(ws[-1].end, 5.0)

    def test_pronunciation_only_whole_words(self):
        self.assertEqual(tts.apply_pronunciations("KI und KIRCHE", {"KI": "K.I."}), "K.I. und KIRCHE")

    def test_voice_fallback_and_display_words(self):
        t = TmpCtx()
        calls = []

        def fake_edge(text, voice, rate, pitch, out_dir, stem):
            calls.append(voice)
            if voice == t.config.voice.voice:
                raise tts.TTSError("403")
            return tts.TTSResult("x.wav", 2.0, [tts.Word("K.I.", 0, .5), tts.Word("ist", .5, 1)], "edge", voice)

        with tempfile.TemporaryDirectory() as d, mock.patch.object(tts, "edge_synthesize", fake_edge):
            res = tts.synthesize_scene("KI ist", "hook", t.config.voice, t.ctx.budget, Path(d), "s", Path(d))
        self.assertEqual(calls[:2], [t.config.voice.voice, t.config.voice.fallback_voices[0]])
        self.assertEqual([w.text for w in res.words], ["KI", "ist"])  # Originalschreibweise in Untertiteln


def _fake_tts(sb, d: Path):
    out = []
    for i, s in enumerate(sb.scenes):
        n = len(tts.tokenize(s.narration))
        dur = 0.4 * n
        wav = d / f"v{i}.wav"
        t = np.arange(int(dur * music.SR)) / music.SR
        music.write_wav(wav, 0.3 * np.sin(2 * np.pi * 180 * t) * (0.5 + 0.5 * np.sin(2 * np.pi * 3 * t)))
        out.append(tts.TTSResult(str(wav), dur, tts.estimate_word_timings(tts.tokenize(s.narration), dur), "fake", "fake", True))
    return out


class TimelineSubtitleTests(unittest.TestCase):
    def test_timeline_and_ass(self):
        sb = Storyboard.model_validate(good_story())
        with tempfile.TemporaryDirectory() as d:
            res = _fake_tts(sb, Path(d))
            tl = build_timeline(sb, res, 0.2, 0.6)
            self.assertEqual(tl.scenes[0].start, 0.0)
            self.assertAlmostEqual(tl.scenes[-1].end, tl.duration)
            for a, b in zip(tl.scenes, tl.scenes[1:]):
                self.assertAlmostEqual(a.end, b.start)
            twist = next(s for s in tl.scenes if s.beat == "twist")
            prev = tl.scenes[twist.index - 1]
            self.assertAlmostEqual(twist.voice_start - prev.voice_end, 0.6, places=3)
            content, rep = subtitles.build_ass(tl.words, tl.duration, title=sb.title)
            self.assertIn("Style: Caption,Outfit", content)
            self.assertIn(subtitles.ACCENT, content)
            self.assertEqual(rep["overflow"], [])

    def test_overflow_is_fixed(self):
        w = [tts.Word("Überwachungskameraaufzeichnungsarchivverwaltung", 0, 1), tts.Word("und", 1, 1.2), tts.Word("mehr", 1.2, 1.5)]
        chunks = subtitles.make_chunks(w)
        for c in chunks:
            self.assertLessEqual(subtitles._chunk_width(c), subtitles.MAX_TEXT_WIDTH)
        self.assertLess(chunks[0].size, subtitles.BASE_SIZE)

    def test_chunks_max_three_words(self):
        ws = tts.estimate_word_timings("eins zwei drei vier fünf sechs sieben".split(), 4)
        self.assertTrue(all(len(c.words) <= 3 for c in subtitles.make_chunks(ws)))


class MusicTests(unittest.TestCase):
    def test_compose_length_and_finite(self):
        sb = Storyboard.model_validate(good_story())
        with tempfile.TemporaryDirectory() as d:
            tl = build_timeline(sb, _fake_tts(sb, Path(d)), 0.2, 0.6)
        m = music.compose(tl, 3)
        fx = music.sound_effects(tl, 3)
        self.assertEqual(len(m), int(tl.duration * music.SR))
        self.assertEqual(m.shape[1], 2)
        self.assertTrue(np.isfinite(m).all() and np.isfinite(fx).all())
        self.assertGreater(np.abs(m).max(), 0.01)


class RenderQATests(unittest.TestCase):
    def test_short_real_render(self):
        """Echtes FFmpeg-Rendering eines kurzen Clips (2 Szenen) → H.264/AAC 1080x1920."""
        sb = Storyboard.model_validate(good_story())
        sb.scenes = sb.scenes[:2]
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            res = _fake_tts(sb, d)
            tl = build_timeline(sb, res, 0.2, 0.6)
            imgs = []
            for i in range(2):
                p = d / f"i{i}.jpg"
                procedural_image(432, 768, i, "dark").save(p)
                imgs.append(p)
            from autotube.media import audio

            rep = audio.mix(tl, res, Config().music, 1, d / "mix.wav")
            subtitles.write_ass(d / "s.ass", tl.words, tl.duration, title=sb.title)
            cfg = VideoConfig(preset="ultrafast")
            render.encode(tl, imgs, d / "mix.wav", d / "s.ass", d / "o.mp4", cfg, 1)
            info = qa.ffprobe(d / "o.mp4")
            v = next(s for s in info["streams"] if s["codec_type"] == "video")
            a = next(s for s in info["streams"] if s["codec_type"] == "audio")
            self.assertEqual((v["width"], v["height"], v["codec_name"]), (1080, 1920, "h264"))
            self.assertEqual(a["codec_name"], "aac")
            self.assertAlmostEqual(float(info["format"]["duration"]), tl.duration, delta=0.15)
            self.assertAlmostEqual(rep["target_lufs"], -14.0)

    def test_qa_rejects_invalid_video(self):
        with tempfile.TemporaryDirectory() as d:
            bad = Path(d) / "bad.mp4"
            subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=640x480:rate=25:duration=6",
                            "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono", "-t", "6", "-c:v", "libx264", "-c:a", "aac",
                            "-b:v", "3M", str(bad)], check=True)
            rep = qa.check_video(bad, VideoConfig(), scene_images=[], expected_scenes=8,
                                 subtitle_report={"chunks": 0, "overflow": []}, narration_rms_db=-90, known_hashes=set())
            self.assertFalse(rep["passed"])
            for k in ("aufloesung", "dauer", "szenen", "erzaehlstimme", "untertitel", "framerate"):
                self.assertFalse(rep["checks"][k]["ok"], k)
            rep2 = qa.check_video(bad, VideoConfig(), scene_images=[], expected_scenes=0,
                                  subtitle_report={"chunks": 9, "overflow": []}, narration_rms_db=-20,
                                  known_hashes={rep["sha256"]})
            self.assertFalse(rep2["checks"]["duplikat"]["ok"])


if __name__ == "__main__":
    unittest.main()
