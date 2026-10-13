"""Automatische Qualitätsprüfung vor jedem Upload. Ungültige Videos werden nie veröffentlicht."""
from __future__ import annotations

import hashlib
import json
import re
import subprocess
from pathlib import Path

from PIL import Image

from ..config import VideoConfig


def ffprobe(path: Path) -> dict:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_format", "-show_streams", "-of", "json", str(path)],
        capture_output=True, text=True, check=True,
    ).stdout
    return json.loads(out)


def _ffmpeg_filter_log(path: Path, args: list[str]) -> str:
    proc = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-i", str(path), *args, "-f", "null", "-"],
                          capture_output=True, text=True)
    return proc.stderr


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def check_video(
    path: Path,
    cfg: VideoConfig,
    *,
    scene_images: list[Path],
    expected_scenes: int,
    subtitle_report: dict,
    narration_rms_db: float | None,
    known_hashes: set[str],
) -> dict:
    checks: dict[str, dict] = {}

    def add(name: str, ok: bool, detail: str) -> None:
        checks[name] = {"ok": bool(ok), "detail": detail}

    if not path.exists() or path.stat().st_size < 200_000:
        add("datei", False, "Ausgabedatei fehlt oder ist zu klein")
        return {"passed": False, "checks": checks}

    info = ffprobe(path)
    v = next((s for s in info["streams"] if s["codec_type"] == "video"), None)
    a = next((s for s in info["streams"] if s["codec_type"] == "audio"), None)
    dur = float(info["format"].get("duration", 0))
    add("aufloesung", bool(v) and (v["width"], v["height"]) == (cfg.width, cfg.height),
        f"{v['width']}x{v['height']}" if v else "kein Videostream")
    add("videocodec", bool(v) and v.get("codec_name") == "h264" and v.get("pix_fmt") == "yuv420p",
        f"{v.get('codec_name')}/{v.get('pix_fmt')}" if v else "-")
    add("audiocodec", bool(a) and a.get("codec_name") == "aac" and int(a.get("channels", 0)) >= 1,
        f"{a.get('codec_name')} {a.get('channels')}ch" if a else "keine Tonspur")
    add("container", "mp4" in info["format"].get("format_name", ""), info["format"].get("format_name", ""))
    add("dauer", cfg.min_duration <= dur <= cfg.max_duration, f"{dur:.1f}s (erlaubt {cfg.min_duration}–{cfg.max_duration}s)")
    if v:
        fr = v.get("avg_frame_rate", "0/1").split("/")
        fps = float(fr[0]) / max(1.0, float(fr[1]))
        add("framerate", abs(fps - cfg.fps) < 0.5, f"{fps:.2f} fps")

    # Szenen vollständig + Bilder intakt
    bad = []
    for p in scene_images:
        try:
            with Image.open(p) as im:
                im.verify()
        except Exception:  # noqa: BLE001
            bad.append(p.name)
    add("szenen", len(scene_images) == expected_scenes and not bad,
        f"{len(scene_images)}/{expected_scenes} Szenen" + (f", defekt: {bad}" if bad else ""))

    # Dekodierfehler (korrupte Datei)
    log = _ffmpeg_filter_log(path, ["-v", "error"])
    errors = [l for l in log.splitlines() if l.strip()]
    add("dekodierbar", not errors, "ohne Fehler" if not errors else errors[0][:160])

    # Schwarzbild, Standbild, Stille, Lautheit in einem Durchlauf
    log = subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostats", "-i", str(path),
         "-vf", "blackdetect=d=0.25:pix_th=0.06,freezedetect=n=0.002:d=2.5",
         "-af", "silencedetect=n=-45dB:d=1.6,ebur128=peak=true", "-f", "null", "-"],
        capture_output=True, text=True,
    ).stderr
    black = sum(float(x) for x in re.findall(r"black_duration:\s*([\d.]+)", log))
    add("schwarzbild", black <= 1.2, f"{black:.2f}s schwarz (Ein-/Ausblendung erlaubt ≤1.2s)")
    freezes = [float(x) for x in re.findall(r"freeze_duration:\s*([\d.]+)", log)]
    add("standbild", not freezes, "keine eingefrorenen Bilder" if not freezes else f"Standbild {max(freezes):.1f}s")
    silences = [(float(s), float(e)) for s, e in zip(re.findall(r"silence_start:\s*([\d.]+)", log),
                                                    re.findall(r"silence_end:\s*([\d.]+)", log))]
    long_sil = [(s, e) for s, e in silences if e < dur - 2.0]
    add("stille", not long_sil, "keine Lücken in der Erzählung" if not long_sil else f"Stille bei {long_sil[0][0]:.1f}s")
    m = re.findall(r"I:\s*(-?[\d.]+) LUFS", log)
    lufs = float(m[-1]) if m else None
    add("lautheit", lufs is not None and -17.5 <= lufs <= -10.5, f"{lufs} LUFS" if lufs is not None else "nicht messbar")
    if narration_rms_db is not None:
        add("erzaehlstimme", narration_rms_db > -40, f"Stimme {narration_rms_db:.1f} dBFS RMS")

    # Untertitel
    ov = subtitle_report.get("overflow", [])
    add("untertitel", not ov and subtitle_report.get("chunks", 0) > 5,
        f"{subtitle_report.get('chunks')} Blöcke, max. Breite {subtitle_report.get('max_width')}/{subtitle_report.get('limit')} px"
        + (f", Überlauf: {ov[:2]}" if ov else ""))

    digest = sha256(path)
    add("duplikat", digest not in known_hashes, "neues Video" if digest not in known_hashes else "identisches Video existiert bereits")
    return {"passed": all(c["ok"] for c in checks.values()), "checks": checks, "duration": round(dur, 2),
            "sha256": digest, "lufs": lufs, "size_mb": round(path.stat().st_size / 1e6, 2)}
