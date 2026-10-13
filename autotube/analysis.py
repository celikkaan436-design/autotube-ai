"""Performance-Analyse: lernt aus echten YouTube-Zahlen, welche Genres/Hooks/Längen funktionieren.

Es werden ausschließlich echte, über die API abgerufene Werte verwendet. Gibt es noch zu wenig
Daten, wird das offen ausgewiesen und gleichmäßig exploriert.
"""
from __future__ import annotations

import random
from collections import defaultdict
from statistics import mean
from typing import Any

from .state import State

MIN_VIDEOS_FOR_LEARNING = 3
EXPLORATION = 0.3

HOOK_STYLES = {
    "frage": "Eine direkte, beunruhigende Frage an den Zuschauer",
    "schock": "Eine schockierende Aussage als erster Satz",
    "geheimnis": "Eine rätselhafte, unmögliche Beobachtung",
    "warnung": "Eine eindringliche Warnung an den Zuschauer",
    "zeitdruck": "Ein Countdown oder Zeitdruck ab Sekunde eins",
    "gestaendnis": "Ein Ich-Erzähler beginnt mit einem Geständnis",
}


def _score(v: dict[str, Any]) -> float | None:
    """Kombinierter Score: durchschnittlich angesehener Anteil (Retention) + Views (log-skaliert)."""
    a = v.get("analytics") or {}
    avp = a.get("averageViewPercentage")
    views = a.get("views") if a.get("views") is not None else v.get("stats", {}).get("viewCount")
    if avp is None and views is None:
        return None
    import math

    s = 0.0
    if avp is not None:
        s += float(avp) / 100.0 * 0.6
    if views is not None:
        s += min(1.0, math.log10(1 + float(views)) / 5.0) * 0.4
    return s


def video_rows(state: State) -> list[dict[str, Any]]:
    rows = []
    vids = state.data["analytics"].get("videos", {})
    for v in state.published_videos():
        a = vids.get(v["video_id"], {})
        rows.append({**v, "analytics": a.get("analytics"), "stats": a.get("stats", {})})
    return rows


def group_scores(state: State, key: str) -> dict[str, dict[str, float]]:
    groups: dict[str, list[float]] = defaultdict(list)
    for row in video_rows(state):
        s = _score(row)
        if s is not None and row.get(key):
            groups[row[key]].append(s)
    return {k: {"score": round(mean(v), 4), "n": len(v)} for k, v in groups.items()}


def choose(options: list[str], scores: dict[str, dict[str, float]], rng: random.Random) -> str:
    """Epsilon-greedy mit Gewichtung — exploriert weiter, nutzt aber was funktioniert."""
    total_n = sum(s["n"] for s in scores.values())
    if total_n < MIN_VIDEOS_FOR_LEARNING or rng.random() < EXPLORATION:
        return rng.choice(options)
    weights = []
    for o in options:
        s = scores.get(o)
        weights.append(0.15 + (s["score"] if s else 0.35))  # Unbekanntes bekommt neutrales Gewicht
    return rng.choices(options, weights=weights, k=1)[0]


def build_insights(state: State) -> dict[str, Any]:
    rows = [r for r in video_rows(state) if _score(r) is not None]
    insights: dict[str, Any] = {
        "videos_with_data": len(rows),
        "enough_data": len(rows) >= MIN_VIDEOS_FOR_LEARNING,
        "genres": group_scores(state, "genre"),
        "hook_styles": group_scores(state, "hook_style"),
        "notes": [],
    }
    if not rows:
        insights["notes"].append("Noch keine Performance-Daten — es wird gleichmäßig exploriert.")
        return insights
    ranked = sorted(rows, key=lambda r: _score(r) or 0, reverse=True)
    insights["top"] = [{"title": r.get("title"), "genre": r.get("genre"), "hook_style": r.get("hook_style"),
                        "score": round(_score(r) or 0, 3)} for r in ranked[:3]]
    insights["bottom"] = [{"title": r.get("title"), "genre": r.get("genre"), "hook_style": r.get("hook_style"),
                           "score": round(_score(r) or 0, 3)} for r in ranked[-3:]]
    durs = [(r.get("duration"), (r.get("analytics") or {}).get("averageViewPercentage")) for r in rows]
    durs = [(d, p) for d, p in durs if d and p is not None]
    if len(durs) >= MIN_VIDEOS_FOR_LEARNING:
        short = [p for d, p in durs if d < 52]
        long_ = [p for d, p in durs if d >= 52]
        if short and long_:
            better = "kürzere (<52 s)" if mean(short) > mean(long_) else "längere (≥52 s)"
            insights["notes"].append(f"{better} Videos halten Zuschauer bisher besser.")
            insights["prefer_shorter"] = mean(short) > mean(long_)
    hooks = [((r.get("analytics") or {}).get("retention_at_10pct"), r.get("hook_style")) for r in rows]
    hooks = [(x, h) for x, h in hooks if x is not None and h]
    if hooks:
        best = max(hooks, key=lambda t: t[0])
        insights["notes"].append(f"Stärkster Hook bisher: Stil „{best[1]}“ (Retention nach 10 %: {best[0]:.0%}).")
    return insights


def prompt_insights(state: State) -> str:
    ins = state.data["analytics"].get("insights") or build_insights(state)
    if not ins.get("enough_data"):
        return "Noch keine belastbaren Performance-Daten vorhanden. Schreibe die bestmögliche Story."
    lines = ["Echte Performance-Daten unseres Kanals (nutze sie, um Hook, Tempo und Twist zu verbessern):"]
    for t in ins.get("top", []):
        lines.append(f"- Gut gelaufen: „{t['title']}“ ({t['genre']}, Hook: {t['hook_style']})")
    for t in ins.get("bottom", []):
        lines.append(f"- Schwach gelaufen: „{t['title']}“ ({t['genre']}, Hook: {t['hook_style']}) — anders machen")
    for n in ins.get("notes", []):
        lines.append(f"- {n}")
    return "\n".join(lines)
