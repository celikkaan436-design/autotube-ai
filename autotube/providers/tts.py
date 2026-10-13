"""Deutsche Sprachausgabe — kostenlos.

1. Microsoft Edge Neural Voices (edge-tts, kein Konto nötig) inkl. exakter Wort-Zeitstempel.
2. Fallback: Piper (Open Source, läuft offline auf dem Runner, Stimme „Thorsten“).
   Wort-Zeiten werden dann aus der Audiodauer geschätzt.
"""
from __future__ import annotations

import asyncio
import json
import re
import subprocess
import wave
from dataclasses import asdict, dataclass, field
from pathlib import Path

from ..budget import Budget
from ..config import VoiceConfig
from ..http import request
from ..log import get_logger

log = get_logger("tts")

# Prosodie je Story-Abschnitt: (Tempo-Offset in %, Tonhöhen-Offset in Hz)
BEAT_PROSODY = {
    "hook": (-4, -3),
    "setup": (0, 0),
    "escalation": (6, 0),
    "twist": (-8, -6),
    "ending": (-10, -5),
}

WORD_RE = re.compile(r"[\wÄÖÜäöüß’'\-]+[^\s]*", re.UNICODE)


class TTSError(Exception):
    pass


@dataclass
class Word:
    text: str
    start: float
    end: float


@dataclass
class TTSResult:
    wav_path: str
    duration: float
    words: list[Word] = field(default_factory=list)
    provider: str = ""
    voice: str = ""
    estimated_timing: bool = False

    def to_json(self) -> dict:
        d = asdict(self)
        return d

    @classmethod
    def from_json(cls, d: dict) -> "TTSResult":
        return cls(**{**d, "words": [Word(**w) for w in d["words"]]})


def tokenize(text: str) -> list[str]:
    return [t for t in text.split() if re.search(r"[\wÄÖÜäöüß]", t)]


def apply_pronunciations(text: str, mapping: dict[str, str]) -> str:
    for src, dst in mapping.items():
        text = re.sub(rf"(?<![\wÄÖÜäöüß]){re.escape(src)}(?![\wÄÖÜäöüß])", dst, text)
    return text


def estimate_word_timings(words: list[str], duration: float, lead: float = 0.05, tail: float = 0.1) -> list[Word]:
    """Verteilt die Dauer gewichtet nach Wortlänge + Satzzeichen-Pausen."""
    if not words:
        return []
    weights = []
    for w in words:
        wt = max(2, len(re.sub(r"[^\wÄÖÜäöüß]", "", w))) + 1.5
        if w[-1] in ".!?…":
            wt += 4
        elif w[-1] in ",;:–":
            wt += 2
        weights.append(wt)
    usable = max(0.1, duration - lead - tail)
    total = sum(weights)
    t = lead
    out = []
    for w, wt in zip(words, weights):
        d = usable * wt / total
        out.append(Word(w, round(t, 3), round(t + d * 0.92, 3)))
        t += d
    return out


def _ffprobe_duration(path: Path) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(path)],
        capture_output=True, text=True, check=True,
    ).stdout.strip()
    return float(out)


def _to_wav(src: Path, dst: Path, trim_tail: bool = True) -> float:
    af = "aresample=48000"
    if trim_tail:
        af = "areverse,silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.08,areverse," + af
    subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-i", str(src), "-af", af, "-ac", "1", "-c:a", "pcm_s16le", str(dst)],
        check=True,
    )
    return _ffprobe_duration(dst)


# ---------------------------------------------------------------- Edge TTS
async def _edge_stream(text: str, voice: str, rate: str, pitch: str, mp3_path: Path) -> list[tuple[float, float, str, str]]:
    import edge_tts  # noqa: PLC0415 — nur auf dem Runner installiert

    try:
        comm = edge_tts.Communicate(text, voice, rate=rate, pitch=pitch, boundary="WordBoundary")
    except TypeError:  # ältere edge-tts-Version ohne boundary-Parameter
        comm = edge_tts.Communicate(text, voice, rate=rate, pitch=pitch)
    marks: list[tuple[float, float, str, str]] = []
    with open(mp3_path, "wb") as fh:
        async for chunk in comm.stream():
            if chunk["type"] == "audio":
                fh.write(chunk["data"])
            elif chunk["type"] in ("WordBoundary", "SentenceBoundary"):
                marks.append((chunk["offset"] / 1e7, chunk["duration"] / 1e7, chunk["text"], chunk["type"]))
    return marks


def edge_synthesize(text: str, voice: str, rate_pct: int, pitch_hz: int, out_dir: Path, stem: str) -> TTSResult:
    mp3 = out_dir / f"{stem}.mp3"
    wav = out_dir / f"{stem}.wav"
    rate = f"{rate_pct:+d}%"
    pitch = f"{pitch_hz:+d}Hz"
    marks = asyncio.run(_edge_stream(text, voice, rate, pitch, mp3))
    if not mp3.exists() or mp3.stat().st_size < 2000:
        raise TTSError("Edge TTS lieferte kein Audio")
    duration = _to_wav(mp3, wav)
    word_marks = [m for m in marks if m[3] == "WordBoundary"]
    if word_marks:
        words = [Word(t, round(o, 3), round(o + d, 3)) for o, d, t, _ in word_marks]
        estimated = False
    else:
        words = estimate_word_timings(tokenize(text), duration)
        estimated = True
    return TTSResult(str(wav), duration, words, "edge", voice, estimated)


# ---------------------------------------------------------------- Piper (offline)
PIPER_BASE = "https://huggingface.co/rhasspy/piper-voices/resolve/main/de/de_DE/{speaker}/{quality}/{name}"


def _piper_model(name: str, cache: Path) -> Path:
    cache.mkdir(parents=True, exist_ok=True)
    onnx = cache / f"{name}.onnx"
    if onnx.exists() and (cache / f"{name}.onnx.json").exists():
        return onnx
    _lang, speaker, quality = name.split("-")
    for suffix in (".onnx", ".onnx.json"):
        url = PIPER_BASE.format(speaker=speaker, quality=quality, name=name + suffix)
        r = request("GET", url, timeout=(20, 300), retries=2)
        (cache / f"{name}{suffix}").write_bytes(r.content)
    return onnx


def piper_synthesize(text: str, model_name: str, rate_pct: int, out_dir: Path, stem: str, cache: Path) -> TTSResult:
    try:
        from piper import PiperVoice  # noqa: PLC0415
    except ImportError as exc:
        raise TTSError("piper-tts nicht installiert") from exc
    onnx = _piper_model(model_name, cache)
    voice = PiperVoice.load(str(onnx))
    raw = out_dir / f"{stem}.raw.wav"
    wav = out_dir / f"{stem}.wav"
    length_scale = max(0.7, min(1.4, 1.0 - rate_pct / 100.0))
    with wave.open(str(raw), "wb") as wf:
        try:
            from piper import SynthesisConfig  # noqa: PLC0415  (piper-tts >= 1.3)
            voice.synthesize_wav(text, wf, syn_config=SynthesisConfig(length_scale=length_scale))
        except ImportError:
            voice.synthesize(text, wf, length_scale=length_scale)
    duration = _to_wav(raw, wav)
    return TTSResult(str(wav), duration, estimate_word_timings(tokenize(text), duration), "piper", model_name, True)


# ---------------------------------------------------------------- Gemini TTS (Gratis-Kontingent mit GEMINI_API_KEY)
GEMINI_TTS_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
BEAT_STYLE = {
    "hook": "in a low, tense, mysterious storyteller voice, slowly, as if sharing a dark secret",
    "setup": "in a calm, atmospheric storyteller voice",
    "escalation": "in an increasingly tense, slightly faster, suspenseful voice",
    "twist": "in a shocked, intense, almost whispering voice, with dramatic pauses",
    "ending": "in a slow, quiet, chilling voice",
}


def gemini_synthesize(text: str, beat: str, models: list[str], voice: str, out_dir: Path, stem: str) -> TTSResult:
    import base64
    import os

    key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not key:
        raise TTSError("GEMINI_API_KEY fehlt")
    prompt = f"Read the following German text aloud {BEAT_STYLE.get(beat, BEAT_STYLE['setup'])}:\n\n{text}"
    body = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {
            "responseModalities": ["AUDIO"],
            "speechConfig": {"voiceConfig": {"prebuiltVoiceConfig": {"voiceName": voice}}},
        },
    }
    last: Exception | None = None
    for model in models:
        try:
            r = request("POST", GEMINI_TTS_URL.format(model=model), json=body, timeout=180, retries=2, backoff=8.0,
                        headers={"x-goog-api-key": key, "Content-Type": "application/json"})
            parts = r.json()["candidates"][0]["content"]["parts"]
            inline = next(p["inlineData"] for p in parts if "inlineData" in p)
            pcm = base64.b64decode(inline["data"])
            rate = 24000
            mime = inline.get("mimeType", "")
            if "rate=" in mime:
                rate = int(mime.split("rate=")[1].split(";")[0])
            raw = out_dir / f"{stem}.raw.wav"
            if pcm[:4] == b"RIFF":
                raw.write_bytes(pcm)
            else:
                with wave.open(str(raw), "wb") as wf:
                    wf.setnchannels(1)
                    wf.setsampwidth(2)
                    wf.setframerate(rate)
                    wf.writeframes(pcm)
            wav = out_dir / f"{stem}.wav"
            duration = _to_wav(raw, wav)
            return TTSResult(str(wav), duration, estimate_word_timings(tokenize(text), duration), "gemini", f"{model}/{voice}", True)
        except Exception as exc:  # noqa: BLE001
            log.warning("Gemini-TTS-Modell fehlgeschlagen", data={"model": model, "error": str(exc)[:200]})
            last = exc
    raise TTSError(f"Gemini TTS nicht verfügbar: {last}")


# ---------------------------------------------------------------- Wortgenaue Zeiten per Whisper (offline)
_WHISPER = None


def _norm_word(w: str) -> str:
    return re.sub(r"[^\wäöüß]", "", w.lower())


def align_words(tokens: list[str], recognized: list[tuple[str, float, float]], duration: float) -> list[Word]:
    """Ordnet erkannte Whisper-Wörter (mit Zeiten) den Original-Wörtern zu; Lücken werden interpoliert."""
    import difflib

    a = [_norm_word(t) for t in tokens]
    b = [_norm_word(r[0]) for r in recognized]
    times: list[tuple[float, float] | None] = [None] * len(tokens)
    for blk in difflib.SequenceMatcher(None, a, b, autojunk=False).get_matching_blocks():
        for k in range(blk.size):
            _, s, e = recognized[blk.b + k]
            times[blk.a + k] = (s, e)
    if sum(t is not None for t in times) < max(2, len(tokens) // 2):
        raise ValueError("Zu wenige Wörter erkannt")
    out: list[Word] = []
    i = 0
    while i < len(tokens):
        if times[i] is not None:
            s, e = times[i]
            out.append(Word(tokens[i], round(s, 3), round(max(e, s + 0.05), 3)))
            i += 1
            continue
        j = i
        while j < len(tokens) and times[j] is None:
            j += 1
        start = out[-1].end if out else 0.0
        end = times[j][0] if j < len(tokens) else duration
        span = tokens[i:j]
        est = estimate_word_timings(span, max(0.05 * len(span), end - start), lead=0.0, tail=0.0)
        out += [Word(w.text, round(start + w.start, 3), round(start + w.end, 3)) for w in est]
        i = j
    return out


def whisper_align(res: TTSResult, text: str, cache: Path) -> TTSResult:
    """Ersetzt geschätzte Wortzeiten durch echte (faster-whisper, läuft lokal auf dem Runner)."""
    global _WHISPER
    try:
        from faster_whisper import WhisperModel  # noqa: PLC0415
    except ImportError:
        return res
    try:
        if _WHISPER is None:
            _WHISPER = WhisperModel("base", device="cpu", compute_type="int8", download_root=str(cache / "whisper"))
        # Audio selbst laden (16 kHz float32) statt Dateipfad → umgeht PyAV-Versionskonflikte
        import numpy as np  # noqa: PLC0415
        from scipy.signal import resample_poly  # noqa: PLC0415

        with wave.open(res.wav_path, "rb") as wf:
            sr, ch = wf.getframerate(), wf.getnchannels()
            pcm = np.frombuffer(wf.readframes(wf.getnframes()), dtype="<i2").astype(np.float32) / 32768.0
        audio = pcm.reshape(-1, ch).mean(axis=1)
        if sr != 16000:
            from math import gcd  # noqa: PLC0415

            g = gcd(sr, 16000)
            audio = resample_poly(audio, 16000 // g, sr // g).astype(np.float32)
        segments, _ = _WHISPER.transcribe(audio, language="de", word_timestamps=True, initial_prompt=text,
                                          beam_size=5, vad_filter=False)
        recognized = [(w.word, float(w.start), float(w.end)) for s in segments for w in (s.words or [])]
        res.words = align_words(tokenize(text), recognized, res.duration)
        res.estimated_timing = False
        res.provider += "+whisper"
    except Exception as exc:  # noqa: BLE001
        log.warning("Whisper-Ausrichtung fehlgeschlagen — geschätzte Wortzeiten", data={"error": str(exc)[:200]})
    return res


# ---------------------------------------------------------------- Öffentliche API
def synthesize_scene(
    text: str,
    beat: str,
    cfg: VoiceConfig,
    budget: Budget,
    out_dir: Path,
    stem: str,
    cache_dir: Path,
) -> TTSResult:
    out_dir.mkdir(parents=True, exist_ok=True)
    spoken = apply_pronunciations(text, cfg.pronunciations)
    d_rate, d_pitch = BEAT_PROSODY.get(beat, (0, 0))
    rate = cfg.base_rate + d_rate
    pitch = cfg.base_pitch + d_pitch
    errors: list[str] = []
    for provider in cfg.provider_chain:
        if provider == "edge":
            voices = [cfg.voice, *cfg.fallback_voices]
        elif provider == "gemini":
            voices = [cfg.gemini_voice]
        else:
            voices = [cfg.piper_voice]
        for voice in voices:
            try:
                budget.check("tts")
                budget.record("tts", provider)
                if provider == "edge":
                    res = edge_synthesize(spoken, voice, rate, pitch, out_dir, stem)
                elif provider == "gemini":
                    res = gemini_synthesize(spoken, beat, cfg.gemini_tts_models, voice, out_dir, stem)
                else:
                    res = piper_synthesize(spoken, voice, rate, out_dir, stem, cache_dir)
                if res.duration < 0.5:
                    raise TTSError("Audio zu kurz")
                if res.estimated_timing:
                    res = whisper_align(res, spoken, cache_dir.parent)
                _restore_display_words(res, text)
                return res
            except Exception as exc:  # noqa: BLE001
                if exc.__class__.__name__ == "BudgetExceeded":
                    raise
                errors.append(f"{provider}/{voice}: {str(exc)[:160]}")
                log.warning("TTS fehlgeschlagen", data={"provider": provider, "voice": voice, "error": str(exc)[:200]})
                if provider == "edge" and ("403" in str(exc) or "401" in str(exc)):
                    break  # Sperre gilt für alle Edge-Stimmen — direkt zum nächsten Anbieter
    raise TTSError("Keine Sprachausgabe möglich: " + " | ".join(errors))


def _restore_display_words(res: TTSResult, original_text: str) -> None:
    """Untertitel zeigen den Originaltext (nicht die Aussprache-Ersetzungen), wenn die Wortzahl passt."""
    orig = tokenize(original_text)
    if len(orig) == len(res.words):
        for w, o in zip(res.words, orig):
            w.text = o
    else:
        # Satzzeichen aus dem Original ergänzen, so gut es geht
        for w in res.words:
            w.text = w.text.strip()


def save_result(res: TTSResult, path: Path) -> None:
    path.write_text(json.dumps(res.to_json(), ensure_ascii=False, indent=1), encoding="utf-8")


def load_result(path: Path) -> TTSResult:
    return TTSResult.from_json(json.loads(path.read_text(encoding="utf-8")))


def list_german_voices() -> list[str]:
    import edge_tts  # noqa: PLC0415

    voices = asyncio.run(edge_tts.list_voices())
    return sorted(v["ShortName"] for v in voices if v.get("Locale", "").startswith("de-"))
