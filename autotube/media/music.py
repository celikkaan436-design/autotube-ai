"""Prozedural komponierte Filmmusik + Soundeffekte.

Alles wird zur Laufzeit synthetisiert (numpy/scipy) — 100 % eigene, lizenzfreie Audiospur,
keine Fremdmusik, kein Copyright-Risiko (Content ID).
"""
from __future__ import annotations

import wave
from pathlib import Path

import numpy as np
from scipy import signal

from .timeline import Timeline

SR = 48000

PROGRESSIONS = [
    [[0, 3, 7], [-4, 0, 3], [3, 7, 10], [-2, 2, 5]],     # i – VI – III – VII
    [[0, 3, 7], [5, 8, 12], [-4, 0, 3], [-5, -2, 2]],    # i – iv – VI – v
    [[0, 3, 7], [-4, 0, 3], [5, 8, 12], [-5, -1, 2]],    # i – VI – iv – V (harmonisch Moll)
]
TENSION_CHORD = [0, 1, 6, 7]   # dissonant für Twist/Ende


def _t(n: int) -> np.ndarray:
    return np.arange(n, dtype=np.float64) / SR


def _midi(m: float) -> float:
    return 440.0 * 2 ** ((m - 69) / 12)


def _saw(freq: float, n: int, phase: float, harmonics: int = 7) -> np.ndarray:
    t = _t(n)
    out = np.zeros(n)
    for k in range(1, harmonics + 1):
        if freq * k > SR / 2.5:
            break
        out += np.sin(2 * np.pi * freq * k * t + phase * k) / k
    return out


def _env(n: int, attack: float, release: float) -> np.ndarray:
    e = np.ones(n)
    a, r = min(n, int(attack * SR)), min(n, int(release * SR))
    if a:
        e[:a] = np.linspace(0, 1, a) ** 1.5
    if r:
        e[-r:] *= np.linspace(1, 0, r) ** 1.5
    return e


def _lowpass(x: np.ndarray, cutoff: float, order: int = 2) -> np.ndarray:
    sos = signal.butter(order, min(cutoff, SR / 2 - 100), "low", fs=SR, output="sos")
    return signal.sosfilt(sos, x, axis=0)


def _bandpass(x: np.ndarray, lo: float, hi: float) -> np.ndarray:
    sos = signal.butter(2, [lo, hi], "band", fs=SR, output="sos")
    return signal.sosfilt(sos, x, axis=0)


def _place(track: np.ndarray, clip: np.ndarray, at: float, gain: float = 1.0) -> None:
    i = int(at * SR)
    if i >= len(track) or i + len(clip) <= 0:
        return
    if i < 0:
        clip, i = clip[-i:], 0
    end = min(len(track), i + len(clip))
    track[i:end] += clip[: end - i] * gain


def _stereo(mono: np.ndarray, pan: float = 0.0) -> np.ndarray:
    l, r = np.cos((pan + 1) * np.pi / 4), np.sin((pan + 1) * np.pi / 4)
    return np.stack([mono * l * 1.414, mono * r * 1.414], axis=1)


def _reverb(x: np.ndarray, rng: np.random.Generator, seconds: float = 2.4, wet: float = 0.28) -> np.ndarray:
    n = int(seconds * SR)
    decay = np.exp(-np.linspace(0, 7, n))
    ir = np.stack([rng.standard_normal(n) * decay, rng.standard_normal(n) * decay], axis=1)
    ir = _lowpass(ir, 5000)
    ir /= np.sqrt((ir ** 2).sum(axis=0, keepdims=True)) + 1e-9
    wet_sig = np.stack([signal.fftconvolve(x[:, c], ir[:, c])[: len(x)] for c in range(2)], axis=1)
    return x * (1 - wet) + wet_sig * wet


# ------------------------------------------------------------------ Soundeffekte
def sfx_impact(rng: np.random.Generator, dur: float = 2.2) -> np.ndarray:
    n = int(dur * SR)
    t = _t(n)
    freq = 30 + 60 * np.exp(-t * 3.5)
    boom = np.sin(2 * np.pi * np.cumsum(freq) / SR) * np.exp(-t * 2.2)
    noise = _lowpass(rng.standard_normal(n), 900) * np.exp(-t * 9) * 0.6
    return _stereo(np.tanh((boom + noise) * 1.6))


def sfx_whoosh(rng: np.random.Generator, dur: float = 0.7, rising: bool = True) -> np.ndarray:
    n = int(dur * SR)
    noise = rng.standard_normal(n)
    env = np.sin(np.linspace(0, np.pi, n)) ** 2
    lo = _bandpass(noise, 300, 1800)
    hi = _bandpass(noise, 1800, 7000)
    mix = np.linspace(0, 1, n) if rising else np.linspace(1, 0, n)
    mono = (lo * (1 - mix) + hi * mix) * env
    pan = np.linspace(-0.7, 0.7, n)
    return np.stack([mono * np.cos((pan + 1) * np.pi / 4), mono * np.sin((pan + 1) * np.pi / 4)], axis=1) * 1.2


def sfx_riser(rng: np.random.Generator, dur: float = 2.6, root: float = 110.0) -> np.ndarray:
    n = int(dur * SR)
    t = _t(n)
    prog = t / dur
    freq = root * (1 + 6 * prog ** 2)
    tone = np.sin(2 * np.pi * np.cumsum(freq) / SR) * 0.35
    noise = _bandpass(rng.standard_normal(n), 400, 6000) * 0.5
    env = prog ** 2.2
    return _stereo((tone + noise) * env)


def sfx_heartbeat(count: int = 4, bpm: float = 80) -> np.ndarray:
    period = 60.0 / bpm
    n = int((count * period + 0.5) * SR)
    out = np.zeros(n)
    beat_n = int(0.18 * SR)
    t = _t(beat_n)
    thump = np.sin(2 * np.pi * 52 * t) * np.exp(-t * 28)
    for k in range(count):
        _place(out, thump, k * period, 1.0)
        _place(out, thump, k * period + 0.24, 0.6)
    return _stereo(np.tanh(out * 1.4))


def sfx_sting(rng: np.random.Generator, root: float, dur: float = 2.5) -> np.ndarray:
    n = int(dur * SR)
    t = _t(n)
    mono = np.zeros(n)
    for semis in (12, 13, 18, 24):
        f = root * 2 ** (semis / 12)
        mono += _saw(f, n, rng.uniform(0, 6)) * 0.25
    mono = _lowpass(mono, 3500) * np.exp(-t * 1.4)
    return _stereo(mono) + sfx_impact(rng, dur) * 0.6


# ------------------------------------------------------------------ Musik
def compose(timeline: Timeline, seed: int, extra_silence: list[tuple[float, float]] | None = None) -> np.ndarray:
    """Erzeugt den Musik-Bed (Stereo float, nicht normalisiert)."""
    rng = np.random.default_rng(seed)
    total = timeline.duration
    n = int(total * SR) + SR
    root_midi = int(rng.choice([45, 46, 47, 48, 50, 52]))  # A2 … E3
    root = _midi(root_midi)
    prog = PROGRESSIONS[int(rng.integers(len(PROGRESSIONS)))]
    twist = timeline.twist_time or total * 0.75
    chord_len = 4.0
    pad = np.zeros(n)
    t0 = 0.0
    k = 0
    while t0 < total:
        seg = int(min(chord_len + 1.0, total + 1 - t0) * SR)
        if seg <= 0:
            break
        notes = TENSION_CHORD if t0 >= twist - 0.5 else prog[k % len(prog)]
        voice = np.zeros(seg)
        for semi in notes:
            f = root * 2 ** (semi / 12)
            for det in (-0.08, 0.0, 0.08):
                voice += _saw(f * 2 ** (det / 12), seg, rng.uniform(0, 6), 6) * 0.12
        voice *= _env(seg, 1.2, 1.2)
        _place(pad, voice, t0)
        t0 += chord_len
        k += 1
    # Filter öffnet sich langsam bis zum Twist (Spannung)
    cutoff_lo = _lowpass(pad, 650)
    cutoff_hi = _lowpass(pad, 2200)
    tt = _t(n)
    open_amt = np.clip(tt / max(twist, 1.0), 0, 1) ** 1.5
    pad = cutoff_lo * (1 - open_amt) + cutoff_hi * open_amt
    # Drone
    lfo = 0.75 + 0.25 * np.sin(2 * np.pi * 0.11 * tt)
    drone = (np.sin(2 * np.pi * root / 2 * tt) * 0.5 + np.sin(2 * np.pi * root * tt) * 0.15) * lfo
    drone += _lowpass(rng.standard_normal(n), 180) * 0.25
    # hoher, kalter Schimmer
    shimmer = np.sin(2 * np.pi * root * 8 * tt) * (0.5 + 0.5 * np.sin(2 * np.pi * 0.37 * tt)) * 0.025
    music = _stereo(pad * 0.9 + drone * 0.55) + _stereo(shimmer, 0.4)
    # Herzschlag während der Eskalation, immer schneller
    esc = [s for s in timeline.scenes if s.beat == "escalation"]
    if esc:
        a, b = esc[0].start, min(twist, esc[-1].end)
        t = a
        while t < b - 0.3:
            prog_e = (t - a) / max(b - a, 0.1)
            bpm = 68 + 50 * prog_e
            _place(music, sfx_heartbeat(1, bpm)[: int(0.6 * SR)], t, 0.55 + 0.35 * prog_e)
            t += 60.0 / bpm
    # Riser → Stille → Impact am Twist
    _place(music, sfx_riser(rng, 2.6, root), twist - 2.75, 0.8)
    gate = np.ones(n)
    gaps = [(twist - 0.32, twist)] + (extra_silence or [])
    for ga, gb in gaps:
        i, j = int(max(0, ga) * SR), int(max(0, gb) * SR)
        if j > i:
            ramp = min(int(0.05 * SR), j - i)
            gate[i:j] = 0.04
            gate[i : i + ramp] = np.linspace(1, 0.04, ramp)
    music *= gate[:, None]
    _place(music, sfx_impact(rng), twist, 1.3)
    # Ende: Sting + Fade-out
    _place(music, sfx_sting(rng, root), max(0.0, total - 2.4), 0.9)
    fade = int(1.4 * SR)
    end_i = int(total * SR)
    music[end_i - fade : end_i] *= np.linspace(1, 0, fade)[:, None] ** 1.3
    music[end_i:] = 0
    music = _reverb(music, rng)
    return music[: int(total * SR)]


def sound_effects(timeline: Timeline, seed: int) -> np.ndarray:
    rng = np.random.default_rng(seed + 1)
    n = int(timeline.duration * SR)
    fx = np.zeros((n, 2))
    root = 110.0
    for s in timeline.scenes[:-1]:
        if s.transition in ("crossfade", "fade_black", "glitch", "flash"):
            gain = 0.7 if s.transition in ("flash", "glitch") else 0.4
            _place(fx, sfx_whoosh(rng, 0.7), s.end - 0.45, gain)
    for s in timeline.scenes:
        cue = s.audio_cue
        if cue == "impact" and s.beat != "twist":
            _place(fx, sfx_impact(rng, 1.8), s.start, 0.7)
        elif cue == "whoosh":
            _place(fx, sfx_whoosh(rng, 0.6, rising=False), s.start, 0.6)
        elif cue == "heartbeat":
            _place(fx, sfx_heartbeat(4, 84), s.start + 0.1, 0.8)
        elif cue == "riser" and s.beat != "twist":
            _place(fx, sfx_riser(rng, 2.0, root), s.start - 2.0, 0.6)
        elif cue == "sting" and s.index != len(timeline.scenes) - 1:
            _place(fx, sfx_sting(rng, root, 1.6), s.start, 0.5)
    return fx


def silence_spans(timeline: Timeline) -> list[tuple[float, float]]:
    return [(s.start, s.start + 0.6) for s in timeline.scenes if s.audio_cue == "silence"]


def write_wav(path: Path, audio: np.ndarray, sr: int = SR) -> None:
    audio = np.asarray(audio)
    if audio.ndim == 1:
        audio = audio[:, None]
    pcm = (np.clip(audio, -1, 1) * 32767).astype("<i2")
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(pcm.shape[1])
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(pcm.tobytes())


def read_wav(path: Path) -> tuple[np.ndarray, int]:
    with wave.open(str(path), "rb") as wf:
        sr = wf.getframerate()
        ch = wf.getnchannels()
        data = np.frombuffer(wf.readframes(wf.getnframes()), dtype="<i2").astype(np.float64) / 32768.0
    return data.reshape(-1, ch), sr
