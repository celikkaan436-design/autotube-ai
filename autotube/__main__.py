"""Kommandozeile: python -m autotube <befehl>"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
import time
from pathlib import Path

from . import paths
from .log import get_logger, summary

log = get_logger("cli")


def _ctx():
    from .pipeline import Context

    return Context.create()


def cmd_daily(args) -> int:
    from .pipeline import ProductionError, handle_youtube_failure, run_daily
    from .youtube.client import YouTubeError

    ctx = _ctx()
    try:
        result = run_daily(ctx, force=args.force)
        log.info("Täglicher Lauf beendet", data={"result": result})
        return 0
    except YouTubeError as exc:
        handle_youtube_failure(ctx, exc)
        log.error("YouTube-Fehler", data={"error": str(exc)})
        summary(f"### ❌ YouTube-Fehler\n{exc}")
        return 1
    except ProductionError as exc:
        log.error("Produktion fehlgeschlagen", data={"error": str(exc)})
        summary(f"### ❌ Produktion fehlgeschlagen\n{exc}")
        return 1
    except Exception as exc:  # noqa: BLE001
        log.exception("Unerwarteter Fehler")
        summary(f"### ❌ Fehler\n`{type(exc).__name__}: {exc}`")
        return 1
    finally:
        ctx.save()


def cmd_verify(args) -> int:
    from .pipeline import handle_youtube_failure, run_verify
    from .youtube.client import YouTubeError

    ctx = _ctx()
    try:
        out = run_verify(ctx)
        summary(f"### 🔎 Verifizierung\n```json\n{json.dumps(out, ensure_ascii=False)}\n```")
        return 0
    except YouTubeError as exc:
        handle_youtube_failure(ctx, exc)
        summary(f"### ❌ YouTube-Fehler\n{exc}")
        return 1
    finally:
        ctx.save()


def cmd_check(args) -> int:
    from .pipeline import preflight

    ctx = _ctx()
    try:
        res = preflight(ctx, live=not args.offline)
        return 0 if res["passed"] or args.no_fail else 1
    finally:
        ctx.save()


def cmd_activate(args) -> int:
    from .pipeline import activate

    ctx = _ctx()
    try:
        return 0 if activate(ctx) else 1
    finally:
        ctx.save()


def cmd_deactivate(args) -> int:
    from .pipeline import deactivate

    ctx = _ctx()
    deactivate(ctx, "manuell über Steuerung")
    ctx.save()
    return 0


def cmd_test_render(args) -> int:
    from .pipeline import test_render

    ctx = _ctx()
    try:
        prod = test_render(ctx)
        out = paths.ROOT / "out"
        out.mkdir(exist_ok=True)
        shutil.copy(prod.video, out / f"{prod.key}.mp4")
        shutil.copy(prod.thumbnail, out / f"{prod.key}.jpg")
        return 0
    except Exception as exc:  # noqa: BLE001
        log.exception("Testvideo fehlgeschlagen")
        summary(f"### ❌ Testvideo fehlgeschlagen\n`{type(exc).__name__}: {exc}`")
        return 1
    finally:
        ctx.save()


def cmd_test_upload(args) -> int:
    from .pipeline import handle_youtube_failure, test_upload
    from .youtube.client import YouTubeError

    ctx = _ctx()
    try:
        test_upload(ctx)
        return 0
    except YouTubeError as exc:
        handle_youtube_failure(ctx, exc)
        summary(f"### ❌ YouTube-Fehler\n{exc}")
        return 1
    except Exception as exc:  # noqa: BLE001
        log.exception("Test-Upload fehlgeschlagen")
        summary(f"### ❌ Test-Upload fehlgeschlagen\n`{type(exc).__name__}: {exc}`")
        return 1
    finally:
        ctx.save()


def cmd_demo(args) -> int:
    """Offline-Render ohne externe Dienste (Platzhalter-Stimme, prozedurale Bilder)."""
    from .config import load_config
    from .demo import demo_assets, demo_storyboard
    from .media import audio, qa, render, subtitles, thumbnail
    from .media.timeline import build_timeline

    cfg = load_config()
    out = Path(args.out)
    work = out / "demo_work"
    sb = demo_storyboard()
    t0 = time.time()
    results, images = demo_assets(work, sb)
    tl = build_timeline(sb, results, cfg.voice.pause_between_scenes, cfg.voice.pause_before_twist)
    mix = audio.mix(tl, results, cfg.music, 7, work / "mix.wav")
    sub = subtitles.write_ass(work / "subs.ass", tl.words, tl.duration, title=sb.title)
    video = out / "demo.mp4"
    render.encode(tl, images, work / "mix.wav", work / "subs.ass", video, cfg.video, 7)
    report = qa.check_video(video, cfg.video, scene_images=images, expected_scenes=len(sb.scenes),
                            subtitle_report=sub, narration_rms_db=mix.get("voice_rms_db"), known_hashes=set())
    thumbnail.make_thumbnail(images[0], sb.youtube.thumbnail_text, out / "demo_thumbnail.jpg")
    report["render_seconds"] = round(time.time() - t0, 1)
    report["timeline"] = {"duration": tl.duration, "scenes": len(tl.scenes), "words": len(tl.words), "twist": tl.twist_time}
    (out / "demo_qa.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps({k: report[k] for k in ("passed", "duration", "lufs", "size_mb", "render_seconds")}, ensure_ascii=False))
    for k, c in report["checks"].items():
        print(f"  {'OK ' if c['ok'] else 'ERR'} {k}: {c['detail']}")
    return 0 if report["passed"] else 1


def cmd_dashboard(args) -> int:
    """Baut die statische Dashboard-Seite (GitHub Pages)."""
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    shutil.copy(paths.DASHBOARD_DIR / "index.html", out / "index.html")
    from .config import load_config
    from .state import State
    from .timeutil import next_slot

    state = State.load()
    cfg = load_config()
    data = dict(state.data)
    data["config"] = json.loads(load_config().model_dump_json())
    data["next_slot"] = next_slot(None, cfg.publish_time, cfg.min_lead_minutes).isoformat()
    stories = []
    for s in state.data["stories"][-30:]:
        p = paths.STORIES_DIR / f"{s['id']}.json"
        if p.exists():
            stories.append(json.loads(p.read_text(encoding="utf-8")))
    data["story_details"] = stories
    (out / "state.json").write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    (out / ".nojekyll").write_text("")
    print(f"Dashboard gebaut: {out}")
    return 0


def cmd_slot(args) -> int:
    from .config import load_config
    from .pipeline import slot_key

    print(slot_key(load_config()))
    return 0


def cmd_oauth_url(args) -> int:
    from .youtube.client import oauth_consent_url

    print(oauth_consent_url(args.client_id, args.redirect_uri))
    return 0


def cmd_oauth_exchange(args) -> int:
    from .youtube.client import exchange_code

    data = exchange_code(args.client_id, args.client_secret, args.code, args.redirect_uri)
    if "refresh_token" not in data:
        print("Kein refresh_token erhalten — beim Login 'prompt=consent' nutzen und Zugriff vorher widerrufen.", file=sys.stderr)
        return 1
    print("YOUTUBE_REFRESH_TOKEN =", data["refresh_token"])
    return 0


def cmd_serve(args) -> int:
    """Dauerbetrieb ohne GitHub Actions (z. B. Docker auf eigenem Server): eingebauter Scheduler."""
    from datetime import timedelta

    from .timeutil import BERLIN, now_utc

    runs = {"07:15": "daily", "10:45": "daily", "13:45": "daily", "16:05": "daily", "19:20": "verify"}
    log.info("Scheduler gestartet", data={"zeiten_berlin": runs})
    done: set[str] = set()
    while True:
        now = now_utc().astimezone(BERLIN)
        hhmm = now.strftime("%H:%M")
        tag = f"{now.date()} {hhmm}"
        if hhmm in runs and tag not in done:
            done.add(tag)
            ns = argparse.Namespace(force=False)
            (cmd_daily if runs[hhmm] == "daily" else cmd_verify)(ns)
            cmd_dashboard(argparse.Namespace(out=str(paths.ROOT / "site")))
        time.sleep(20)
        if len(done) > 50:
            done = {d for d in done if d.startswith(str((now - timedelta(days=1)).date())) or d.startswith(str(now.date()))}


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="autotube", description="AutoTube AI — Story Edition")
    sub = p.add_subparsers(dest="cmd", required=True)
    d = sub.add_parser("daily", help="Video für den nächsten 18:00-Slot produzieren und planen")
    d.add_argument("--force", action="store_true", help="auch bei inaktivem Autopilot ausführen")
    d.set_defaults(fn=cmd_daily)
    sub.add_parser("verify", help="Veröffentlichung prüfen + Analytics sammeln").set_defaults(fn=cmd_verify)
    c = sub.add_parser("check", help="Systemprüfung (Preflight)")
    c.add_argument("--offline", action="store_true")
    c.add_argument("--no-fail", action="store_true")
    c.set_defaults(fn=cmd_check)
    sub.add_parser("activate", help="Autopilot nach bestandener Prüfung aktivieren").set_defaults(fn=cmd_activate)
    sub.add_parser("deactivate", help="Autopilot pausieren").set_defaults(fn=cmd_deactivate)
    sub.add_parser("test-render", help="Echtes Testvideo erzeugen (ohne Upload)").set_defaults(fn=cmd_test_render)
    sub.add_parser("test-upload", help="Testvideo PRIVAT hochladen und verifizieren").set_defaults(fn=cmd_test_upload)
    dm = sub.add_parser("demo", help="Offline-Render-Test ohne externe Dienste")
    dm.add_argument("--out", default="out")
    dm.set_defaults(fn=cmd_demo)
    db = sub.add_parser("dashboard", help="Dashboard für GitHub Pages bauen")
    db.add_argument("--out", default="site")
    db.set_defaults(fn=cmd_dashboard)
    ou = sub.add_parser("oauth-url", help="Google-Login-URL für das Refresh Token")
    ou.add_argument("--client-id", required=True)
    ou.add_argument("--redirect-uri", default="http://localhost:8080/")
    ou.set_defaults(fn=cmd_oauth_url)
    oe = sub.add_parser("oauth-exchange", help="Code gegen Refresh Token tauschen")
    oe.add_argument("--client-id", required=True)
    oe.add_argument("--client-secret", required=True)
    oe.add_argument("--code", required=True)
    oe.add_argument("--redirect-uri", default="http://localhost:8080/")
    oe.set_defaults(fn=cmd_oauth_exchange)
    sub.add_parser("slot", help="Datum des nächsten Veröffentlichungs-Slots ausgeben").set_defaults(fn=cmd_slot)
    sub.add_parser("serve", help="Eingebauter Scheduler (Docker/Server)").set_defaults(fn=cmd_serve)
    args = p.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
