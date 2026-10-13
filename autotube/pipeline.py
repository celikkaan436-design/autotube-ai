"""Orchestrierung: Produktion (mit Checkpoints), Upload, Verifizierung, Analytics, Preflight."""
from __future__ import annotations

import hashlib
import json
import shutil
import traceback
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import numpy as np

from . import analysis, gitsync, paths
from .budget import Budget
from .config import Config, Secrets, load_config, load_secrets
from .github import GitHub
from .log import get_logger, summary
from .media import audio, qa, render, subtitles, thumbnail
from .media.timeline import Timeline, build_timeline
from .providers import images as imgs
from .providers import llm, tts
from .state import DAY_FINAL, State
from .story import engine
from .story.schema import Storyboard
from .timeutil import BERLIN, iso, next_slot, now_utc, slot_on, to_rfc3339_utc
from .youtube.client import SCOPES, AuthRevoked, NotConfigured, QuotaExceeded, YouTube, YouTubeError, build_metadata

log = get_logger("pipeline")


class ProductionError(Exception):
    pass


@dataclass
class Context:
    config: Config
    secrets: Secrets
    state: State
    budget: Budget
    gh: GitHub
    work_root: Path = field(default_factory=lambda: paths.WORK_DIR)

    @classmethod
    def create(cls) -> "Context":
        config = load_config()
        secrets = load_secrets()
        state = State.load()
        return cls(config, secrets, state, Budget(state, config.limits), GitHub(secrets))

    def save(self, message: str | None = None) -> None:
        self.state.save()
        if message:
            gitsync.persist(message)


@dataclass
class Production:
    key: str
    storyboard: Storyboard
    video: Path
    thumbnail: Path
    qa: dict
    timeline: Timeline
    image_meta: list[dict]


def _seed(key: str) -> int:
    return int(hashlib.sha256(key.encode()).hexdigest()[:8], 16)


# ====================================================================== Produktion
def produce(ctx: Context, key: str, *, record_day: bool = True) -> Production:
    cfg, state = ctx.config, ctx.state
    work = ctx.work_root / key
    work.mkdir(parents=True, exist_ok=True)
    seed = _seed(key)

    def mark(status: str, **kw: Any) -> None:
        if record_day:
            state.set_day(key, status=status, **kw)

    # ---------------- 1) Story + Storyboard
    story_file = work / "story.json"
    if story_file.exists():
        sb = Storyboard.model_validate(json.loads(story_file.read_text(encoding="utf-8")))
        log.info("Checkpoint: Story geladen", data={"id": sb.id, "title": sb.title})
    else:
        chain = llm.build_chain(cfg, ctx.secrets)
        sb = engine.create_story(cfg, state, ctx.budget, chain, key)
        story_file.write_text(json.dumps(sb.model_dump(), ensure_ascii=False, indent=2), encoding="utf-8")
        engine.save_story(sb)
        engine.register_story(state, sb, key)
        state.log("info", f"Story erstellt: {sb.title}", genre=sb.genre, provider=sb.provider,
                  review=(sb.review or {}).get("average"))
        mark("story_ready", story_id=sb.id, title=sb.title, genre=sb.genre, hook_style=sb.hook_style)
        ctx.save(f"story: {sb.title}")

    # ---------------- 2) Sprachausgabe (+ Dauer-Steuerung)
    voice_dir = work / "voice"
    rate_adjust = 0
    timeline: Timeline | None = None
    results: list[tts.TTSResult] = []
    for _round in range(3):
        results = []
        vcfg = cfg.voice.model_copy(update={"base_rate": cfg.voice.base_rate + rate_adjust})
        for i, scene in enumerate(sb.scenes):
            meta = voice_dir / f"scene_{i:02d}.json"
            if meta.exists() and rate_adjust == 0:
                res = tts.load_result(meta)
                if Path(res.wav_path).exists():
                    results.append(res)
                    continue
            res = tts.synthesize_scene(scene.narration, scene.beat, vcfg, ctx.budget, voice_dir, f"scene_{i:02d}",
                                       ctx.work_root / "_cache" / "piper")
            tts.save_result(res, meta)
            results.append(res)
        timeline = build_timeline(sb, results, cfg.voice.pause_between_scenes, cfg.voice.pause_before_twist)
        if timeline.duration > cfg.video.target_max + 1.5:
            rate_adjust += 9
            log.info("Zu lang — Sprechtempo wird erhöht", data={"duration": timeline.duration, "rate_adjust": rate_adjust})
            continue
        if timeline.duration < cfg.video.target_min - 1.5 and rate_adjust > -12:
            rate_adjust -= 7
            log.info("Zu kurz — Sprechtempo wird verringert", data={"duration": timeline.duration, "rate_adjust": rate_adjust})
            continue
        break
    assert timeline is not None
    if not (cfg.video.min_duration <= timeline.duration <= cfg.video.max_duration):
        # Story passt nicht in die Länge → beim nächsten Versuch neue Story schreiben
        story_file.unlink(missing_ok=True)
        shutil.rmtree(voice_dir, ignore_errors=True)
        raise ProductionError(f"Videolänge {timeline.duration:.1f}s liegt außerhalb {cfg.video.min_duration}–{cfg.video.max_duration}s — "
                              "nächster Versuch schreibt eine neue Story")
    for i, res in enumerate(results):
        data, _ = audio.mus.read_wav(Path(res.wav_path))
        rms = float(np.sqrt(np.mean(np.square(data))) + 1e-12)
        if 20 * np.log10(rms) < -45:
            raise ProductionError(f"Szene {i + 1}: Sprachaufnahme ist stumm")
    mark("voice_ready", duration=round(timeline.duration, 2), tts_provider=results[0].provider,
         voice=results[0].voice, estimated_timing=any(r.estimated_timing for r in results))

    # ---------------- 3) Szenenbilder
    img_dir = work / "images"
    img_meta_file = img_dir / "meta.json"
    img_meta: list[dict] = json.loads(img_meta_file.read_text()) if img_meta_file.exists() else []
    chain = imgs.build_chain(cfg, ctx.secrets)
    images: list[Path] = []
    for i, scene in enumerate(sb.scenes):
        p = img_dir / f"scene_{i:02d}.jpg"
        existing = next((m for m in img_meta if m.get("index") == i), None)
        if p.exists() and existing and not existing.get("fallback"):
            images.append(p)
            continue
        prompt = sb.scene_prompt(i, cfg.images.style_suffix)
        meta = imgs.generate_scene_image(chain, ctx.budget, prompt, p, cfg.images.gen_width, cfg.images.gen_height,
                                         seed % 1_000_000, spacing=cfg.images.request_spacing_seconds, mood=scene.mood)
        meta.update({"index": i, "prompt": prompt})
        img_meta = [m for m in img_meta if m.get("index") != i] + [meta]
        img_dir.mkdir(parents=True, exist_ok=True)
        img_meta_file.write_text(json.dumps(img_meta, ensure_ascii=False, indent=1))
        images.append(p)
    fallbacks = sum(1 for m in img_meta if m.get("fallback"))
    if fallbacks > cfg.images.max_fallback_scenes:
        raise ProductionError(f"{fallbacks} Szenen ohne KI-Bild (Bildanbieter nicht erreichbar) — Produktion wird später erneut versucht")
    mark("images_ready", image_providers=sorted({m["provider"] for m in img_meta}), fallback_images=fallbacks)

    # ---------------- 4) Audio-Mix, Untertitel, Rendering, QA (mit einem Reparaturversuch)
    known = {v.get("sha256") for v in state.data["videos"] if v.get("sha256")}
    mix_wav = work / "mix.wav"
    mix_report = audio.mix(timeline, results, cfg.music, seed, mix_wav)
    ass = work / "subtitles.ass"
    sub_report = subtitles.write_ass(ass, timeline.words, timeline.duration, title=sb.title)
    final = work / "final.mp4"
    report: dict = {}
    for attempt in range(2):
        render.encode(timeline, images, mix_wav, ass, final, cfg.video, seed + attempt)
        report = qa.check_video(final, cfg.video, scene_images=images, expected_scenes=len(sb.scenes),
                                subtitle_report=sub_report, narration_rms_db=mix_report.get("voice_rms_db"),
                                known_hashes=known)
        if report["passed"]:
            break
        failed = [k for k, c in report["checks"].items() if not c["ok"]]
        log.warning("QA fehlgeschlagen — Reparaturversuch", data={"failed": failed, "attempt": attempt + 1})
        if "standbild" in failed:
            for s in timeline.scenes:
                s.camera = "zoom_in" if s.camera != "zoom_in" else "pan_right"
        if "untertitel" in failed:
            subtitles.MAX_WORDS = 2
            sub_report = subtitles.write_ass(ass, timeline.words, timeline.duration, title=sb.title)
        if "lautheit" in failed or "audiocodec" in failed:
            mix_report = audio.mix(timeline, results, cfg.music, seed + 1, mix_wav)
    if not report.get("passed"):
        mark("failed", qa=report)
        raise ProductionError("Qualitätsprüfung nicht bestanden: " +
                              ", ".join(f"{k} ({c['detail']})" for k, c in report["checks"].items() if not c["ok"]))
    hook_scene = 0
    thumb = thumbnail.make_thumbnail(images[hook_scene], sb.youtube.thumbnail_text, work / "thumbnail.jpg")
    sb.timeline = timeline.to_json()
    engine.save_story(sb)
    story_file.write_text(json.dumps(sb.model_dump(), ensure_ascii=False, indent=2), encoding="utf-8")
    mark("qa_passed", qa={"passed": True, "duration": report["duration"], "lufs": report["lufs"],
                          "size_mb": report["size_mb"], "checks": {k: c["ok"] for k, c in report["checks"].items()}})
    return Production(key, sb, final, thumb, report, timeline, img_meta)


def _release(ctx: Context, prod: Production, tag: str) -> str | None:
    body = (f"**{prod.storyboard.title}** ({prod.storyboard.genre})\n\n{prod.storyboard.logline}\n\n"
            f"Dauer: {prod.qa['duration']} s · Lautheit: {prod.qa['lufs']} LUFS · QA: bestanden\n")
    video_name = f"autotube-{prod.key}.mp4"
    named = prod.video.with_name(video_name)
    shutil.copyfile(prod.video, named)
    return ctx.gh.release_with_assets(tag, f"Video {prod.key}: {prod.storyboard.title}", body, [named, prod.thumbnail])


def _video_record(prod: Production, **extra: Any) -> dict:
    sb = prod.storyboard
    return {"story_id": sb.id, "date": prod.key, "title": sb.youtube.title, "story_title": sb.title, "genre": sb.genre,
            "hook_style": sb.hook_style, "duration": prod.qa["duration"], "sha256": prod.qa["sha256"],
            "words": sb.word_count, "review": (sb.review or {}).get("average"), "created_at": iso(), **extra}


def cleanup_work(root: Path, keep_days: int = 2) -> None:
    """Temporäre Dateien aufräumen: alte Arbeitsordner löschen (Cache _cache bleibt)."""
    if not root.exists():
        return
    cutoff = (now_utc().astimezone(BERLIN).date() - timedelta(days=keep_days)).isoformat()
    for d in root.iterdir():
        if not d.is_dir() or d.name.startswith("_"):
            continue
        day = d.name.split("test-")[-1][:10] if "test-" in d.name else d.name[:10]
        if len(day) == 8 and day.isdigit():  # test-YYYYMMDD
            day = f"{day[:4]}-{day[4:6]}-{day[6:]}"
        if day < cutoff:
            shutil.rmtree(d, ignore_errors=True)


def slot_key(config: Config) -> str:
    return next_slot(now_utc(), config.publish_time, config.min_lead_minutes).date().isoformat()


# ====================================================================== Täglicher Lauf
def run_daily(ctx: Context, *, force: bool = False) -> str:
    cfg, state = ctx.config, ctx.state
    cleanup_work(ctx.work_root)
    if not state.autopilot_enabled and not force:
        summary("### ⏸️ Autopilot ist inaktiv\nAktivieren über den Workflow **AutoTube Steuerung → activate**.")
        state.add_run("daily", "skipped_inactive")
        return "inactive"
    now = now_utc()
    slot = next_slot(now, cfg.publish_time, cfg.min_lead_minutes)
    key = slot.date().isoformat()
    day = state.day(key)
    if day["status"] in DAY_FINAL:
        summary(f"### ✅ {key}: bereits erledigt (Status: {day['status']})")
        state.add_run("daily", "already_done", day=key)
        return "already_done"

    yt = YouTube(ctx.secrets, ctx.budget)
    channel = yt.channel()
    state.data["channel"] = {**channel, "checked_at": iso()}
    marker = f"{cfg.youtube.marker_prefix}: {key}"
    existing = yt.find_by_marker(channel["uploads_playlist"], marker)
    if existing:
        st = yt.video_status(existing["video_id"]) or {}
        state.set_day(key, status="scheduled" if st.get("publish_at") else "uploaded", video_id=existing["video_id"])
        state.add_video({"video_id": existing["video_id"], "date": key, "title": existing.get("title"),
                         "privacy": st.get("privacy"), "publish_at": st.get("publish_at"), "test": False})
        state.log("warning", f"Video für {key} existiert bereits auf YouTube — kein zweiter Upload", video_id=existing["video_id"])
        summary(f"### ✅ {key}: Video existiert bereits ({existing['video_id']}) — Duplikat verhindert")
        return "already_uploaded"

    day["attempts"] = int(day.get("attempts", 0)) + 1
    try:
        prod = produce(ctx, key)
    except Exception as exc:
        state.day_error(key, f"{type(exc).__name__}: {exc}")
        state.log("error", f"Produktion {key} fehlgeschlagen: {exc}")
        state.add_run("daily", "failed", day=key, error=str(exc)[:300])
        last_chance = now.astimezone(BERLIN) > slot - timedelta(hours=3, minutes=15)
        if last_chance:
            state.set_day(key, status="failed")
            ctx.gh.notify(f"AutoTube: Video für {key} fehlgeschlagen",
                          f"Die Produktion ist auch im letzten Versuch fehlgeschlagen.\n\n```\n{str(exc)[:1500]}\n```\n\n"
                          f"Es wird **kein** Ersatzvideo hochgeladen. Morgen läuft der Autopilot normal weiter.")
        raise

    release_url = _release(ctx, prod, f"video-{key}")
    first = not state.data.get("first_private_upload")
    publish_at = None if first else to_rfc3339_utc(slot)
    if publish_at and slot <= now_utc() + timedelta(minutes=15):
        raise ProductionError("Veröffentlichungszeit liegt zu nah — Slot wird übersprungen, um Doppel-Uploads zu vermeiden")
    meta = build_metadata(prod.storyboard, cfg, publish_at, key)
    resp = yt.upload(prod.video, meta)
    vid = resp["id"]
    state.set_day(key, status="uploaded", video_id=vid, release_url=release_url, publish_at=publish_at)
    state.add_video(_video_record(prod, video_id=vid, url=f"https://youtube.com/shorts/{vid}", privacy="private",
                                  publish_at=publish_at, release_url=release_url, test=False))
    ctx.save(f"upload: {key} -> {vid}")  # sofort sichern (Crash-Schutz)

    if cfg.youtube.upload_thumbnail:
        try:
            state.set_day(key, thumbnail_set=yt.set_thumbnail(vid, prod.thumbnail))
        except Exception as exc:  # noqa: BLE001 — Thumbnail ist optional
            log.warning("Thumbnail fehlgeschlagen", data={"error": str(exc)[:200]})
    try:
        st = yt.video_status(vid) or {}
    except Exception as exc:  # noqa: BLE001 — Status wird abends erneut geprüft
        log.warning("Status nach Upload nicht abrufbar", data={"error": str(exc)[:200]})
        st = {}
    if first:
        state.data["first_private_upload"] = {"video_id": vid, "verified_at": iso(), "privacy": st.get("privacy")}
        state.set_day(key, status="uploaded", note="Erster Upload bewusst privat")
        result = "uploaded_private_first"
    elif st.get("publish_at"):
        state.set_day(key, status="scheduled", publish_at=st["publish_at"])
        result = "scheduled"
    else:
        state.set_day(key, status="uploaded",
                      note="YouTube hat keinen Veröffentlichungstermin übernommen. Bei nicht geprüften API-Projekten "
                           "bleiben Uploads privat, bis das kostenlose YouTube-API-Audit bestanden ist.")
        result = "uploaded_private_locked"
    state.add_video({"video_id": vid, "privacy": st.get("privacy"), "upload_status": st.get("upload_status")})
    state.log("info", f"Upload {key}: {prod.storyboard.youtube.title}", video_id=vid, result=result)
    state.add_run("daily", result, day=key, video_id=vid)
    summary(_daily_summary(key, prod, vid, result, publish_at, release_url))
    return result


def _daily_summary(key, prod, vid, result, publish_at, release_url) -> str:
    rows = "\n".join(f"| {k} | {'✅' if c['ok'] else '❌'} | {c['detail']} |" for k, c in prod.qa["checks"].items())
    return (f"## 🎬 {key}: {prod.storyboard.title}\n\n"
            f"- YouTube-ID: `{vid}` → https://studio.youtube.com/video/{vid}/edit\n"
            f"- Ergebnis: **{result}**\n- Geplante Veröffentlichung: {publish_at or '— (privat)'}\n"
            f"- Download: {release_url or '—'}\n\n| Prüfung | OK | Detail |\n|---|---|---|\n{rows}\n")


# ====================================================================== Abend: Verifizierung + Analytics
def run_verify(ctx: Context) -> dict:
    state = ctx.state
    try:
        yt = YouTube(ctx.secrets, ctx.budget)
    except NotConfigured:
        state.add_run("verify", "skipped_not_configured")
        return {"skipped": True}
    channel = yt.channel()
    state.data["channel"] = {**channel, "checked_at": iso()}
    now_b = now_utc().astimezone(BERLIN)
    out = {"confirmed": [], "not_public": []}
    for key, day in sorted(state.data["days"].items())[-7:]:
        vid = day.get("video_id")
        if not vid or day.get("status") not in ("scheduled", "uploaded", "not_public"):
            continue
        st = yt.video_status(vid)
        if st is None:
            state.set_day(key, status="failed", note="Video auf YouTube nicht mehr auffindbar")
            continue
        state.add_video({"video_id": vid, "date": key, "title": st.get("title") or day.get("title"),
                         "genre": day.get("genre"), "hook_style": day.get("hook_style"),
                         "privacy": st["privacy"], "upload_status": st["upload_status"]})
        slot = slot_on(date.fromisoformat(key), ctx.config.publish_time)
        if st["privacy"] == "public":
            state.set_day(key, status="published", published_confirmed_at=iso())
            state.add_video({"video_id": vid, "published_confirmed_at": iso(), "privacy": "public"})
            out["confirmed"].append(vid)
        elif now_b > slot + timedelta(minutes=20) and day.get("status") != "not_public":
            if (state.data.get("first_private_upload") or {}).get("video_id") == vid:
                continue
            state.set_day(key, status="not_public")
            out["not_public"].append(vid)
            ctx.gh.notify("AutoTube: Video wurde nicht öffentlich",
                          f"Das Video vom {key} (`{vid}`) ist nach 18:00 noch **{st['privacy']}**.\n\n"
                          "Häufigste Ursache: Das Google-Cloud-Projekt hat das YouTube-API-Audit noch nicht bestanden "
                          "(dann sperrt YouTube API-Uploads auf privat). Du kannst das Video in YouTube Studio manuell "
                          "veröffentlichen. Audit-Formular: https://support.google.com/youtube/contact/yt_api_form")
    collect_analytics(ctx, yt)
    state.add_run("verify", "ok", **{k: len(v) for k, v in out.items()})
    return out


def collect_analytics(ctx: Context, yt: YouTube) -> None:
    state = ctx.state
    an = state.data["analytics"]
    vids = [v for v in state.published_videos()][-60:]
    ids = [v["video_id"] for v in vids]
    stats = {}
    if ids:
        for item in yt.videos(ids):
            stats[item["id"]] = {k: int(x) for k, x in item.get("statistics", {}).items() if str(x).isdigit()}
    for v in vids:
        rec = an["videos"].setdefault(v["video_id"], {"snapshots": []})
        rec["stats"] = stats.get(v["video_id"], rec.get("stats", {}))
        if (v.get("published_confirmed_at") or v.get("privacy") == "public") and v.get("date"):
            try:
                rec["analytics"] = yt.video_analytics(v["video_id"], date.fromisoformat(v["date"][:10]))
            except YouTubeError as exc:
                log.info("Analytics für Video nicht verfügbar", data={"video": v["video_id"], "error": str(exc)[:200]})
        rec["snapshots"] = (rec["snapshots"] + [{"ts": iso(), **rec.get("stats", {})}])[-30:]
    try:
        an["channel_daily"] = yt.channel_daily(28)
    except YouTubeError as exc:
        an["channel_daily_error"] = str(exc)[:300]
    an["insights"] = analysis.build_insights(state)
    an["updated_at"] = iso()
    an["unavailable"] = ["Impressionen und Klickrate (CTR) sind über die YouTube Analytics API nicht abrufbar — nur in YouTube Studio."]


# ====================================================================== Preflight / Aktivierung
def preflight(ctx: Context, *, live: bool = True) -> dict:
    cfg, s = ctx.config, ctx.secrets
    checks: dict[str, dict] = {}

    def add(name: str, ok: bool, detail: str, required: bool = True) -> None:
        checks[name] = {"ok": bool(ok), "detail": detail, "required": required}

    add("konfiguration", True, "config/autotube.json gültig")
    add("kostenlos", not cfg.limits.allow_paid_providers, "Kostenpflichtige Anbieter gesperrt" if not cfg.limits.allow_paid_providers
        else "ACHTUNG: kostenpflichtige Anbieter erlaubt")
    ff = shutil.which("ffmpeg") and shutil.which("ffprobe")
    add("ffmpeg", bool(ff), "ffmpeg/ffprobe gefunden" if ff else "ffmpeg fehlt")
    add("schriften", paths.SUBTITLE_FONT_FILE.exists() and paths.TITLE_FONT_FILE.exists(), "Outfit + Gloock (OFL)")
    if live:
        # Text-KI
        chain = llm.build_chain(cfg, s)
        ok_llm = []
        for p in chain:
            try:
                res, _ = llm.generate_json([p], ctx.budget, "Antworte nur mit JSON.", 'Gib {"ok": true, "wort": "Nebel"} zurück.',
                                           temperature=0)
                ok_llm.append(p.name)
            except Exception as exc:  # noqa: BLE001
                add(f"textki_{p.name}", False, str(exc)[:200], required=False)
                continue
            add(f"textki_{p.name}", True, "antwortet", required=False)
        add("textki", bool(ok_llm), f"verfügbar: {', '.join(ok_llm) or 'keiner'}")
        add("gemini_key", bool(s.gemini_api_key), "gesetzt" if s.gemini_api_key else "fehlt (empfohlen, kostenlos)", required=False)
        # Bild-KI
        ichain = imgs.build_chain(cfg, s)
        tmp = ctx.work_root / "_preflight"
        tmp.mkdir(parents=True, exist_ok=True)
        try:
            meta = imgs.generate_scene_image(ichain, ctx.budget, "foggy forest at night, single lantern, cinematic",
                                             tmp / "test.jpg", 512, 896, 42, spacing=0, allow_fallback=False)
            add("bildki", True, f"Testbild von {meta['provider']}")
        except Exception as exc:  # noqa: BLE001
            add("bildki", False, str(exc)[:200])
        # Stimme
        try:
            res = tts.synthesize_scene("Das ist ein kurzer Test.", "setup", cfg.voice, ctx.budget, tmp, "tts_test", tmp)
            add("stimme", res.duration > 0.8, f"{res.provider}/{res.voice}, {res.duration:.1f}s, Wortzeiten: "
                + ("geschätzt" if res.estimated_timing else "exakt"))
        except Exception as exc:  # noqa: BLE001
            add("stimme", False, str(exc)[:200])
        # YouTube
        if not s.youtube_configured:
            add("youtube", False, "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / YOUTUBE_REFRESH_TOKEN fehlen")
        else:
            try:
                yt = YouTube(s, ctx.budget)
                ch = yt.channel()
                ctx.state.data["channel"] = {**ch, "checked_at": iso()}
                add("youtube", True, f"Kanal „{ch['title']}“ ({ch['id']})")
                missing = [sc.rsplit("/", 1)[-1] for sc in SCOPES if yt.scopes and sc not in yt.scopes]
                add("youtube_scopes", not missing, "alle Berechtigungen" if not missing else f"fehlend: {missing}")
                try:
                    yt.channel_daily(7)
                    add("analytics", True, "YouTube Analytics erreichbar", required=False)
                except YouTubeError as exc:
                    add("analytics", False, str(exc)[:200], required=False)
            except YouTubeError as exc:
                add("youtube", False, str(exc)[:300])
    fpu = ctx.state.data.get("first_private_upload")
    add("erster_privater_upload", bool(fpu), f"verifiziert: {fpu['video_id']}" if fpu else
        "noch nicht — Workflow 'test-upload' ausführen")
    add("github", ctx.gh.enabled, "Releases + Benachrichtigungen aktiv" if ctx.gh.enabled else "nur lokal", required=False)
    passed = all(c["ok"] for c in checks.values() if c["required"])
    result = {"ran_at": iso(), "passed": passed, "checks": checks}
    ctx.state.data["preflight"] = result
    rows = "\n".join(f"| {k} | {'✅' if c['ok'] else ('❌' if c['required'] else '⚠️')} | {c['detail']} |" for k, c in checks.items())
    summary(f"## 🔍 Systemprüfung: {'BESTANDEN' if passed else 'NICHT bestanden'}\n\n| Prüfung | Status | Detail |\n|---|---|---|\n{rows}\n")
    return result


def activate(ctx: Context) -> bool:
    res = preflight(ctx, live=True)
    if not res["passed"]:
        failed = [k for k, c in res["checks"].items() if c["required"] and not c["ok"]]
        ctx.state.log("warning", "Autopilot-Aktivierung abgelehnt", failed=failed)
        summary(f"### ❌ Autopilot NICHT aktiviert — offene Punkte: {', '.join(failed)}")
        return False
    ctx.state.data["autopilot"].update({"enabled": True, "activated_at": iso(), "last_change_reason": "Preflight bestanden"})
    ctx.state.log("info", "Autopilot aktiviert")
    slot = next_slot(now_utc(), ctx.config.publish_time, ctx.config.min_lead_minutes)
    summary(f"### 🚀 Autopilot AKTIV\nNächste Veröffentlichung: **{slot.strftime('%d.%m.%Y %H:%M')} (Berlin)**")
    return True


def deactivate(ctx: Context, reason: str = "manuell") -> None:
    ctx.state.data["autopilot"].update({"enabled": False, "deactivated_at": iso(), "last_change_reason": reason})
    ctx.state.log("info", f"Autopilot deaktiviert ({reason})")
    summary(f"### ⏸️ Autopilot deaktiviert ({reason})")


def test_render(ctx: Context) -> Production:
    key = "test-" + datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    prod = produce(ctx, key, record_day=False)
    url = _release(ctx, prod, key)
    ctx.state.add_video(_video_record(prod, video_id=None, release_url=url, test=True))
    ctx.state.log("info", f"Testvideo gerendert: {prod.storyboard.title}", release=url)
    ctx.state.add_run("test-render", "ok", release=url)
    rows = "\n".join(f"| {k} | {'✅' if c['ok'] else '❌'} | {c['detail']} |" for k, c in prod.qa["checks"].items())
    summary(f"## 🎞️ Testvideo: {prod.storyboard.title}\n\nDownload: {url or 'siehe Artefakte'}\n\n"
            f"| Prüfung | OK | Detail |\n|---|---|---|\n{rows}\n")
    return prod


def test_upload(ctx: Context) -> str:
    """Rendert ein Video und lädt es PRIVAT (ohne Veröffentlichungstermin) hoch — verifiziert per API."""
    yt = YouTube(ctx.secrets, ctx.budget)
    ch = yt.channel()
    ctx.state.data["channel"] = {**ch, "checked_at": iso()}
    key = "upload-test-" + datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    prod = produce(ctx, key, record_day=False)
    url = _release(ctx, prod, key)
    meta = build_metadata(prod.storyboard, ctx.config, None, key)
    resp = yt.upload(prod.video, meta)
    vid = resp["id"]
    st = yt.video_status(vid) or {}
    ok = st.get("video_id") == vid and st.get("privacy") == "private"
    if ctx.config.youtube.upload_thumbnail:
        yt.set_thumbnail(vid, prod.thumbnail)
    ctx.state.add_video(_video_record(prod, video_id=vid, url=f"https://youtube.com/shorts/{vid}", privacy=st.get("privacy"),
                                      release_url=url, test=True, upload_test=True))
    if ok:
        ctx.state.data["first_private_upload"] = {"video_id": vid, "verified_at": iso(), "privacy": "private"}
    ctx.state.log("info" if ok else "error", f"Test-Upload privat: {vid}", status=st)
    ctx.state.add_run("test-upload", "ok" if ok else "unverified", video_id=vid)
    summary(f"## 📤 Privater Test-Upload {'✅ verifiziert' if ok else '⚠️ nicht verifiziert'}\n\n"
            f"- Video: https://studio.youtube.com/video/{vid}/edit\n- Status laut API: `{json.dumps(st, ensure_ascii=False)[:400]}`\n")
    if not ok:
        raise YouTubeError("Upload konnte nicht als privat verifiziert werden")
    return vid


def handle_youtube_failure(ctx: Context, exc: Exception) -> None:
    if isinstance(exc, AuthRevoked):
        deactivate(ctx, "YouTube-Zugriff widerrufen")
        ctx.gh.notify("AutoTube: YouTube-Verbindung getrennt",
                      f"{exc}\n\nDer Autopilot wurde zur Sicherheit pausiert. Neues Refresh Token erzeugen (siehe README → "
                      "„YouTube verbinden“), als Secret `YOUTUBE_REFRESH_TOKEN` speichern und erneut aktivieren.")
    elif isinstance(exc, QuotaExceeded):
        ctx.gh.notify("AutoTube: YouTube-Kontingent erschöpft", f"{exc}\n\nDer nächste Versuch läuft automatisch.")


def format_exc(exc: Exception) -> str:
    return "".join(traceback.format_exception_only(type(exc), exc)).strip()
