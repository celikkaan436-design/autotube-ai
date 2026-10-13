"""Deterministische Qualitätsregeln für Storyboards."""
from __future__ import annotations

import re

from ..config import Config
from .schema import Storyboard

MIN_WORDS = 100
MAX_WORDS = 150
MAX_HOOK_WORDS = 18
MAX_SCENE_WORDS = 42

# YouTube-sicher bleiben: keine expliziten Gewaltdetails, keine realen Marken/Personen im Prompt
BANNED_PATTERNS = [
    r"\bblutüberströmt\w*", r"\bzerstückel\w*", r"\bausgeweidet\w*", r"\bvergewaltig\w*", r"\bselbstmord\w*",
    r"\bsuizid\w*", r"\bkinderleiche\w*", r"\bfolter\w*",
]
BANNED_VISUAL = [r"\bgore\b", r"\bdismember", r"\bnude\b", r"\bnaked\b", r"\bblood ?bath", r"\bsuicide\b", r"\bchild corpse"]


def _words(text: str) -> int:
    return len([w for w in text.split() if re.search(r"\w", w)])


def check(sb: Storyboard, config: Config) -> list[str]:
    issues: list[str] = []
    v = config.video
    n = len(sb.scenes)
    if not (v.scenes_min <= n <= v.scenes_max):
        issues.append(f"Es müssen {v.scenes_min}–{v.scenes_max} Szenen sein (aktuell {n}).")
    beats = [s.beat for s in sb.scenes]
    if beats and beats[0] != "hook":
        issues.append("Die erste Szene muss der Hook sein.")
    if beats and beats[-1] != "ending":
        issues.append("Die letzte Szene muss das Ende (ending) sein.")
    if "setup" not in beats:
        issues.append("Es fehlt eine Setup-Szene.")
    if "escalation" not in beats:
        issues.append("Es fehlt eine Eskalations-Szene.")
    if beats.count("twist") < 1:
        issues.append("Es fehlt der Plot-Twist (beat=twist).")
    else:
        idx = beats.index("twist")
        if idx < n * 0.5:
            issues.append("Der Twist kommt zu früh — er gehört ins letzte Drittel/Viertel.")
    order = {"hook": 0, "setup": 1, "escalation": 2, "twist": 3, "ending": 4}
    ranks = [order[b] for b in beats]
    if any(b < a for a, b in zip(ranks, ranks[1:])):
        issues.append("Die Abschnitte müssen in der Reihenfolge Hook → Setup → Eskalation → Twist → Ende stehen.")
    wc = sb.word_count
    if wc < MIN_WORDS:
        issues.append(f"Erzähltext zu kurz ({wc} Wörter, Ziel 115–140).")
    if wc > MAX_WORDS:
        issues.append(f"Erzähltext zu lang ({wc} Wörter, Ziel 115–140).")
    if sb.scenes and _words(sb.scenes[0].narration) > MAX_HOOK_WORDS:
        issues.append(f"Der Hook ist zu lang (max. {MAX_HOOK_WORDS} Wörter) — er muss in 3 Sekunden sitzen.")
    for i, s in enumerate(sb.scenes, 1):
        if _words(s.narration) > MAX_SCENE_WORDS:
            issues.append(f"Szene {i} hat zu viel Text (max. {MAX_SCENE_WORDS} Wörter).")
        if re.search(r"[A-Za-z]{3,}", s.visual_prompt) is None:
            issues.append(f"Szene {i}: visual_prompt muss Englisch sein.")
        for pat in BANNED_VISUAL:
            if re.search(pat, s.visual_prompt, re.I):
                issues.append(f"Szene {i}: Bildprompt enthält nicht YouTube-taugliche Inhalte.")
    full = sb.script + " " + sb.title + " " + sb.youtube.title
    for pat in BANNED_PATTERNS:
        if re.search(pat, full, re.I):
            issues.append("Text enthält zu explizite/sensible Inhalte (YouTube-Richtlinien).")
            break
    if len(sb.youtube.title) > 90:
        issues.append("YouTube-Titel zu lang.")
    if not re.search(r"[äöüÄÖÜß]|\b(der|die|das|und|nicht|ich|ein|eine)\b", sb.script):
        issues.append("Der Erzähltext muss Deutsch sein.")
    return issues
