"""Video-Rendering: Ken-Burns-Kamerafahrten, Übergänge, Color Grading → FFmpeg (H.264/AAC, 1080x1920)."""
from __future__ import annotations

import math
import subprocess
import tempfile
from pathlib import Path

import cv2
import numpy as np

from .. import paths
from ..config import VideoConfig
from ..log import get_logger
from .timeline import SceneTiming, Timeline

log = get_logger("render")

W, H = 1080, 1920
OVERSCAN = 1.28  # Reserve für Zoom/Pan


def _smooth(p: float) -> float:
    p = min(1.0, max(0.0, p))
    return p * p * (3 - 2 * p)


GRADES = {
    # (Schatten-Tönung BGR, Lichter-Tönung BGR, Sättigung, Kontrast)
    "dark": ((18, 8, 0), (0, 6, 14), 0.78, 1.12),
    "cold": ((28, 10, 0), (12, 6, 0), 0.70, 1.10),
    "warm": ((0, 4, 10), (0, 14, 30), 0.85, 1.08),
    "red": ((0, 0, 18), (4, 6, 28), 0.82, 1.15),
}


def prepare_source(image_path: Path, mood: str) -> np.ndarray:
    """Lädt das Bild, skaliert es auf Overscan-Größe (cover) und wendet das Color Grading an."""
    img = cv2.imread(str(image_path), cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError(f"Bild nicht lesbar: {image_path}")
    sw, sh = int(W * OVERSCAN), int(H * OVERSCAN)
    h, w = img.shape[:2]
    scale = max(sw / w, sh / h)
    img = cv2.resize(img, (math.ceil(w * scale), math.ceil(h * scale)), interpolation=cv2.INTER_LANCZOS4)
    y0 = (img.shape[0] - sh) // 2
    x0 = (img.shape[1] - sw) // 2
    img = img[y0 : y0 + sh, x0 : x0 + sw]
    # leichte Schärfung nach dem Hochskalieren
    blur = cv2.GaussianBlur(img, (0, 0), 1.6)
    img = cv2.addWeighted(img, 1.35, blur, -0.35, 0)
    f = img.astype(np.float32) / 255.0
    shadow, high, sat, contrast = GRADES.get(mood, GRADES["dark"])
    gray = cv2.cvtColor(f, cv2.COLOR_BGR2GRAY)[..., None]
    f = gray + (f - gray) * sat
    f = np.clip((f - 0.5) * contrast + 0.5 - 0.03, 0, 1)
    lum = gray
    f += (1 - lum) * np.array(shadow, np.float32) / 255.0 + lum * np.array(high, np.float32) / 255.0
    yy, xx = np.mgrid[0:sh, 0:sw].astype(np.float32)
    d = ((xx / sw - 0.5) ** 2) * 1.6 + ((yy / sh - 0.5) ** 2) * 1.1
    f *= np.clip(1 - d * 1.15, 0.25, 1)[..., None]
    return np.clip(f * 255, 0, 255).astype(np.uint8)


class SceneCamera:
    def __init__(self, src: np.ndarray, timing: SceneTiming, seed: int):
        self.src = src
        self.t = timing
        self.rng = np.random.default_rng(seed)
        sh, sw = src.shape[:2]
        self.sw, self.sh = sw, sh
        self.cx0, self.cy0 = sw / 2, sh / 2
        self.drift = self.rng.uniform(-1, 1, 2)
        self.shake_phase = self.rng.uniform(0, 100, 4)

    def _params(self, p: float, time: float) -> tuple[float, float, float, float]:
        cam = self.t.camera
        p = min(1.0, max(0.0, p))
        e = _smooth(p)
        z, ox, oy, rot = 1.0, 0.0, 0.0, 0.0
        if cam == "zoom_in":
            z = 1.0 + 0.14 * e
            ox, oy = self.drift * 0.25 * e
        elif cam == "zoom_out":
            z = 1.16 - 0.14 * e
            ox, oy = self.drift * 0.25 * (1 - e)
        elif cam == "dolly_in":
            z = 1.0 + 0.24 * (p ** 1.6)
        elif cam in ("pan_left", "pan_right"):
            z = 1.14
            d = (e - 0.5) * 2
            ox = d if cam == "pan_right" else -d
        elif cam in ("pan_up", "pan_down"):
            z = 1.14
            d = (e - 0.5) * 2
            oy = -d if cam == "pan_up" else d
        elif cam == "shake":
            z = 1.12 + 0.04 * e
            ph = self.shake_phase
            ox = 0.06 * (math.sin(time * 7.3 + ph[0]) + 0.5 * math.sin(time * 13.1 + ph[1]))
            oy = 0.05 * (math.sin(time * 6.1 + ph[2]) + 0.5 * math.sin(time * 11.7 + ph[3]))
            rot = 0.35 * math.sin(time * 3.3 + ph[0])
        return z, ox, oy, rot

    def frame(self, time: float) -> np.ndarray:
        p = (time - self.t.start) / max(self.t.duration, 0.01)
        z, ox, oy, rot = self._params(p, time)
        s = z / OVERSCAN                 # Ausgabe-Pixel pro Quell-Pixel
        half_w, half_h = W / (2 * s), H / (2 * s)
        max_dx = max(0.0, self.sw / 2 - half_w)
        max_dy = max(0.0, self.sh / 2 - half_h)
        cx = self.cx0 + np.clip(ox, -1, 1) * max_dx
        cy = self.cy0 + np.clip(oy, -1, 1) * max_dy
        m = cv2.getRotationMatrix2D((float(cx), float(cy)), float(rot), float(s))
        m[0, 2] += W / 2 - cx
        m[1, 2] += H / 2 - cy
        return cv2.warpAffine(self.src, m, (W, H), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REFLECT)


def _glitch(frame: np.ndarray, rng: np.random.Generator, strength: float) -> np.ndarray:
    out = frame.copy()
    shift = int(18 * strength)
    out[..., 2] = np.roll(frame[..., 2], shift, axis=1)
    out[..., 0] = np.roll(frame[..., 0], -shift, axis=1)
    for _ in range(int(6 * strength) + 1):
        y = int(rng.integers(0, H - 40))
        hgt = int(rng.integers(8, 60))
        out[y : y + hgt] = np.roll(out[y : y + hgt], int(rng.integers(-80, 80)), axis=1)
    return out


def render_frames(timeline: Timeline, images: list[Path], cfg: VideoConfig, seed: int):
    """Generator: liefert alle Frames (BGR uint8) der Reihe nach."""
    scenes = timeline.scenes
    cams = []
    for i, (st, img) in enumerate(zip(scenes, images)):
        cams.append(SceneCamera(prepare_source(img, st.mood), st, seed + i))
    rng = np.random.default_rng(seed)
    fps = cfg.fps
    n_frames = int(round(timeline.duration * fps))
    td = cfg.transition_seconds
    for fi in range(n_frames):
        t = fi / fps
        idx = next((k for k, s in enumerate(scenes) if s.start <= t < s.end), len(scenes) - 1)
        cur = scenes[idx]
        frame = cams[idx].frame(t)
        # Übergang aus der vorherigen Szene
        if idx > 0:
            prev = scenes[idx - 1]
            since = t - cur.start
            tr = prev.transition
            if tr == "crossfade" and since < td / 2:
                a = 0.5 - since / td
                frame = cv2.addWeighted(cams[idx - 1].frame(t), a, frame, 1 - a, 0)
            elif tr == "fade_black" and since < td / 2:
                frame = (frame.astype(np.float32) * (since / (td / 2))).astype(np.uint8)
            elif tr == "flash" and since < 0.3:
                a = 1 - since / 0.3
                frame = cv2.addWeighted(frame, 1 - a * 0.85, np.full_like(frame, 255), a * 0.85, 0)
            elif tr == "glitch" and since < 0.17:
                frame = _glitch(frame, rng, 1 - since / 0.17)
        # Übergang in die nächste Szene
        if idx < len(scenes) - 1:
            until = cur.end - t
            tr = cur.transition
            if tr == "crossfade" and until < td / 2:
                a = 0.5 - until / td
                frame = cv2.addWeighted(frame, 1 - a, cams[idx + 1].frame(t), a, 0)
            elif tr == "fade_black" and until < td / 2:
                frame = (frame.astype(np.float32) * (until / (td / 2))).astype(np.uint8)
            elif tr == "glitch" and until < 0.1:
                frame = _glitch(frame, rng, 1 - until / 0.1)
        # Flackern bei Twist / roter Stimmung
        if cur.beat == "twist" or cur.mood == "red":
            flick = 0.93 + 0.07 * math.sin(t * 23.0) * math.sin(t * 7.7)
            if rng.random() < 0.02:
                flick *= 0.7
            frame = cv2.convertScaleAbs(frame, alpha=flick, beta=0)
        # Ein- und Ausblenden
        if t < 0.18:
            frame = (frame.astype(np.float32) * (t / 0.18)).astype(np.uint8)
        tail = timeline.duration - t
        if tail < 0.9:
            frame = (frame.astype(np.float32) * max(0.0, tail / 0.9)).astype(np.uint8)
        yield frame


def encode(timeline: Timeline, images: list[Path], audio_wav: Path, ass_path: Path, out_path: Path,
           cfg: VideoConfig, seed: int) -> None:
    vf = ["format=yuv420p"]
    if cfg.film_grain:
        vf.append("noise=c0s=5:c0f=t+u")
    fonts = str(paths.FONTS_DIR).replace(":", r"\:")
    ass = str(ass_path).replace(":", r"\:").replace("'", r"\'")
    vf.append(f"ass='{ass}':fontsdir='{fonts}'")
    cmd = [
        "ffmpeg", "-y", "-v", "error",
        "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{W}x{H}", "-r", str(cfg.fps), "-i", "-",
        "-i", str(audio_wav),
        "-filter:v", ",".join(vf),
        "-map", "0:v", "-map", "1:a",
        "-c:v", "libx264", "-preset", cfg.preset, "-crf", str(cfg.crf), "-profile:v", "high", "-level:v", "4.2",
        "-pix_fmt", "yuv420p", "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
        "-g", str(cfg.fps * 2), "-bf", "2",
        "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
        "-t", f"{timeline.duration:.3f}",
        "-movflags", "+faststart",
        str(out_path),
    ]
    with tempfile.TemporaryFile() as errf:
        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=errf)
        assert proc.stdin is not None
        try:
            for frame in render_frames(timeline, images, cfg, seed):
                proc.stdin.write(frame.tobytes())
        except BrokenPipeError:
            pass
        finally:
            try:
                proc.stdin.close()
            except BrokenPipeError:
                pass
        code = proc.wait()
        errf.seek(0)
        err = errf.read().decode(errors="replace")
    if code != 0:
        raise RuntimeError(f"FFmpeg-Rendering fehlgeschlagen ({code}): {err[-1500:]}")
