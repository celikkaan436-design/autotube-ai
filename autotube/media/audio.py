"""Audio-Mix: Stimme + Musik (mit Ducking) + Soundeffekte, danach EBU-R128-Lautheitsnormalisierung."""
from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path

import numpy as np

from ..config import MusicConfig
from ..providers.tts import TTSResult
from . import music as mus
from .timeline import Timeline

SR = mus.SR


def _rms(x: np.ndarray) -> float:
    return float(np.sqrt(np.mean(np.square(x)) + 1e-12))


def voice_track(timeline: Timeline, tts: list[TTSResult]) -> np.ndarray:
    n = int(timeline.duration * SR)
    out = np.zeros(n)
    for scene, res in zip(timeline.scenes, tts):
        data, sr = mus.read_wav(Path(res.wav_path))
        if sr != SR:
            raise ValueError(f"Unerwartete Abtastrate {sr}")
        mono = data.mean(axis=1)
        i = int(scene.voice_start * SR)
        end = min(n, i + len(mono))
        out[i:end] += mono[: end - i]
    return out


def duck_envelope(voice: np.ndarray, duck_db: float) -> np.ndarray:
    win = int(0.03 * SR)
    pad = np.pad(np.square(voice), (win, win))
    csum = np.cumsum(pad)
    rms = np.sqrt((csum[2 * win :] - csum[: -2 * win])[: len(voice)] / (2 * win))
    active = (rms > 0.01).astype(np.float64)
    # Attack 40 ms, Release 350 ms
    a, r = np.exp(-1 / (0.04 * SR / 64)), np.exp(-1 / (0.35 * SR / 64))
    dec = active[::64]
    sm = np.zeros_like(dec)
    v = 0.0
    for k, x in enumerate(dec):
        coef = a if x > v else r
        v = coef * v + (1 - coef) * x
        sm[k] = v
    env = np.repeat(sm, 64)[: len(voice)]
    if len(env) < len(voice):
        env = np.pad(env, (0, len(voice) - len(env)), mode="edge")
    return 10 ** (duck_db * env / 20)


def mix(timeline: Timeline, tts: list[TTSResult], cfg: MusicConfig, seed: int, out_wav: Path) -> dict:
    voice = voice_track(timeline, tts)
    v_active = voice[np.abs(voice) > 0.003]
    v_rms = _rms(v_active) if len(v_active) else 0.0
    if v_rms < 1e-3:
        raise ValueError("Stimme ist stumm — Mix abgebrochen")
    voice *= 0.1 / v_rms  # ≈ -20 dBFS RMS
    stereo = np.stack([voice, voice], axis=1)
    report = {"voice_rms_db": round(20 * np.log10(_rms(voice[np.abs(voice) > 0.0003]) + 1e-12), 1)}
    if cfg.enabled:
        bed = mus.compose(timeline, seed, mus.silence_spans(timeline))
        bed = bed[: len(voice)]
        if len(bed) < len(voice):
            bed = np.pad(bed, ((0, len(voice) - len(bed)), (0, 0)))
        bed *= (0.1 * 10 ** (cfg.music_db / 20)) / (_rms(bed) + 1e-9)
        bed *= duck_envelope(voice, cfg.duck_db)[:, None]
        fx = mus.sound_effects(timeline, seed)[: len(voice)]
        if len(fx) < len(voice):
            fx = np.pad(fx, ((0, len(voice) - len(fx)), (0, 0)))
        peak = np.max(np.abs(fx)) or 1.0
        fx *= (0.1 * 10 ** (cfg.sfx_db / 20) * 4) / peak
        stereo = stereo + bed + fx
        report["music"] = True
    stereo = np.tanh(stereo * 1.2) / np.tanh(1.2)  # weicher Limiter
    raw = out_wav.with_suffix(".raw.wav")
    mus.write_wav(raw, stereo)
    report.update(loudnorm(raw, out_wav, cfg.final_lufs, cfg.true_peak))
    raw.unlink(missing_ok=True)
    return report


def loudnorm(src: Path, dst: Path, target: float, tp: float) -> dict:
    """Zweistufige EBU-R128-Normalisierung (ffmpeg loudnorm)."""
    first = subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostats", "-i", str(src), "-af",
         f"loudnorm=I={target}:TP={tp}:LRA=11:print_format=json", "-f", "null", "-"],
        capture_output=True, text=True, check=True,
    ).stderr
    m = re.search(r"\{[^{}]*\"input_i\"[^{}]*\}", first, re.S)
    if not m:
        raise RuntimeError("loudnorm-Messung fehlgeschlagen")
    meas = json.loads(m.group(0))
    af = (f"loudnorm=I={target}:TP={tp}:LRA=11:measured_I={meas['input_i']}:measured_TP={meas['input_tp']}:"
          f"measured_LRA={meas['input_lra']}:measured_thresh={meas['input_thresh']}:offset={meas['target_offset']}:linear=true")
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", str(src), "-af", af + ",aresample=48000",
                    "-ac", "2", "-c:a", "pcm_s16le", str(dst)], check=True)
    return {"input_lufs": float(meas["input_i"]), "target_lufs": target}
