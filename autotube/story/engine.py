"""Story Intelligence Engine: Generierung → Regelprüfung → Duplikat-Check → KI-Review → Speichern."""
from __future__ import annotations

import hashlib
import json
import random
from pathlib import Path
from statistics import mean
from typing import Any

from .. import analysis, paths
from ..budget import Budget
from ..config import Config
from ..log import get_logger
from ..providers.llm import LLMError, Provider, generate_json
from ..state import State
from ..timeutil import iso
from . import prompts, rules
from .schema import Storyboard
from .similarity import max_similarity, story_text

log = get_logger("story")

REVIEW_KEYS = ("hook", "suspense", "twist", "originality", "language", "visuals")


class StoryError(Exception):
    pass


def story_path(story_id: str) -> Path:
    return paths.STORIES_DIR / f"{story_id}.json"


def save_story(sb: Storyboard) -> Path:
    paths.STORIES_DIR.mkdir(parents=True, exist_ok=True)
    p = story_path(sb.id or "unknown")
    p.write_text(json.dumps(sb.model_dump(), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return p


def load_story(story_id: str) -> Storyboard:
    return Storyboard.model_validate(json.loads(story_path(story_id).read_text(encoding="utf-8")))


def history_texts(state: State) -> tuple[list[str], list[str]]:
    texts, titles = [], []
    for s in state.data["stories"]:
        p = story_path(s["id"])
        if p.exists():
            try:
                sb = Storyboard.model_validate(json.loads(p.read_text(encoding="utf-8")))
                texts.append(story_text(sb.title, sb.logline, sb.script))
                titles.append(sb.title)
                continue
            except Exception:  # noqa: BLE001
                pass
        texts.append(story_text(s.get("title", ""), s.get("logline", ""), ""))
        titles.append(s.get("title", ""))
    return texts, titles


def _review(chain: list[Provider], budget: Budget, sb: Storyboard) -> dict[str, Any] | None:
    payload = json.dumps({k: v for k, v in sb.model_dump().items() if k not in ("review", "timeline", "provider")},
                         ensure_ascii=False)

    def validate(obj: dict[str, Any]) -> dict[str, Any]:
        scores = obj.get("scores") or {}
        vals = {k: float(scores[k]) for k in REVIEW_KEYS if k in scores}
        if len(vals) < 4:
            raise ValueError("Review unvollständig")
        obj["scores"] = vals
        obj["average"] = round(mean(vals.values()), 2)
        fb = obj.get("feedback") or []
        obj["feedback"] = [str(f) for f in (fb if isinstance(fb, list) else [fb])][:6]
        return obj

    try:
        review, provider = generate_json(chain, budget, prompts.SYSTEM_REVIEW, prompts.review_user_prompt(payload),
                                         temperature=0.2, validate=validate)
        review["provider"] = provider
        return review
    except LLMError as exc:
        log.warning("KI-Review nicht verfügbar — nur deterministische Regeln greifen", data={"error": str(exc)[:300]})
        return None


def create_story(config: Config, state: State, budget: Budget, chain: list[Provider], day_key: str,
                 seed: int | None = None) -> Storyboard:
    rng = random.Random(seed if seed is not None else int(hashlib.sha256(day_key.encode()).hexdigest()[:8], 16))
    insights = state.data["analytics"].get("insights") or analysis.build_insights(state)
    genre = analysis.choose(config.genres, insights.get("genres", {}), rng)
    hook_style = analysis.choose(list(analysis.HOOK_STYLES), insights.get("hook_styles", {}), rng)
    avoid = [f"{s.get('title')}: {s.get('logline')}" for s in state.data["stories"]]
    history, titles = history_texts(state)

    feedback: list[str] | None = None
    best: tuple[float, Storyboard] | None = None
    attempts = config.llm.max_story_attempts
    for attempt in range(1, attempts + 1):
        user = prompts.story_user_prompt(
            genre=genre, hook_style=hook_style, hook_desc=analysis.HOOK_STYLES[hook_style],
            scenes_min=config.video.scenes_min, scenes_max=config.video.scenes_max,
            insights=analysis.prompt_insights(state), avoid=avoid, feedback=feedback,
            prefer_shorter=insights.get("prefer_shorter"),
        )
        try:
            sb, provider = generate_json(chain, budget, prompts.SYSTEM_STORY, user,
                                         temperature=config.llm.temperature, validate=Storyboard.model_validate)
        except LLMError as exc:
            if "Tageslimit" in str(exc) or attempt == attempts:
                raise
            log.warning("Story-Entwurf unbrauchbar, neuer Versuch", data={"attempt": attempt, "error": str(exc)[:400]})
            feedback = ["Die Antwort entsprach nicht der geforderten JSON-Struktur. Halte dich exakt an das Schema "
                        f"und liefere {config.video.scenes_min}–{config.video.scenes_max} Szenen."]
            continue
        sb.provider = provider
        sb.genre = sb.genre if sb.genre in config.genres else genre
        sb.hook_style = sb.hook_style if sb.hook_style in analysis.HOOK_STYLES else hook_style

        issues = rules.check(sb, config)
        sim, idx = max_similarity(story_text(sb.title, sb.logline, sb.script), history)
        if sim > config.llm.max_similarity:
            issues.append(f"Zu ähnlich zu einer früheren Story („{titles[idx]}“, Ähnlichkeit {sim:.2f}). Völlig neue Prämisse wählen.")
        if any(sb.title.strip().lower() == t.strip().lower() for t in titles):
            issues.append("Dieser Titel wurde schon verwendet.")
        log.info("Story-Entwurf geprüft", data={"attempt": attempt, "provider": provider, "title": sb.title,
                                                "words": sb.word_count, "scenes": len(sb.scenes),
                                                "similarity": round(sim, 3), "issues": issues})
        if issues:
            feedback = issues
            continue

        review = _review(chain, budget, sb)
        sb.review = {**(review or {"skipped": True}), "similarity": round(sim, 3), "attempt": attempt}
        if review is None:
            return _finalize(sb, day_key)
        score = min(review["average"], review["scores"].get("twist", review["average"]) + 0.5)
        if best is None or score > best[0]:
            best = (score, sb)
        if score >= config.llm.min_review_score and review.get("verdict", "accept") != "reject":
            return _finalize(sb, day_key)
        feedback = review["feedback"] or [f"Bewertung {review['average']}/10 — Hook und Twist deutlich stärker machen."]

    if best and best[0] >= config.llm.min_review_score - 1.0:
        log.warning("Beste Story knapp unter Review-Schwelle übernommen", data={"score": best[0]})
        return _finalize(best[1], day_key)
    raise StoryError(f"Keine Story hat die Qualitätsprüfung bestanden ({attempts} Versuche). Letztes Feedback: {feedback}")


def _finalize(sb: Storyboard, day_key: str) -> Storyboard:
    digest = hashlib.sha1(f"{sb.title}{sb.logline}".encode()).hexdigest()[:6]
    sb.id = f"{day_key}-{digest}"
    sb.created_at = iso()
    return sb


def register_story(state: State, sb: Storyboard, day_key: str) -> None:
    entries = [s for s in state.data["stories"] if s["id"] != sb.id]
    entries.append({"id": sb.id, "date": day_key, "title": sb.title, "genre": sb.genre,
                    "hook_style": sb.hook_style, "logline": sb.logline, "words": sb.word_count,
                    "review": (sb.review or {}).get("average")})
    state.data["stories"] = entries
