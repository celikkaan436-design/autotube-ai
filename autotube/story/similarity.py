"""Semantische Ähnlichkeitsprüfung (TF-IDF, Uni- + Bigramme, ohne externe Abhängigkeiten)."""
from __future__ import annotations

import math
import re
from collections import Counter

STOPWORDS = set(
    """aber alle allem allen aller alles als also am an ander andere anderem anderen anderer anderes auch auf aus bei bin bis
    bist da damit dann das dass dein deine dem den denn der des dich die dies diese diesem diesen dieser dieses dir doch dort
    du durch ein eine einem einen einer eines er es etwas euch euer für gegen gewesen hab habe haben hat hatte hatten hier hin
    hinter ich ihm ihn ihnen ihr ihre im in indem ins ist jede jedem jeden jeder jedes jetzt kann kein keine man manche mein
    meine mich mir mit muss nach nicht nichts noch nun nur ob oder ohne sehr sein seine seinem seinen seiner sich sie sind so
    solche soll sondern um und uns unser unter vom von vor war waren warst was weil weiter welche wenn wer werde werden wie
    wieder will wir wird wo wollen würde zu zum zur zwar zwischen noch schon immer nie""".split()
)


def _tokens(text: str) -> list[str]:
    words = [w for w in re.findall(r"[a-zäöüß]+", text.lower()) if len(w) > 2 and w not in STOPWORDS]
    stems = [w[:7] for w in words]  # grobes Stemming
    return stems + [f"{a}_{b}" for a, b in zip(stems, stems[1:])]


def _vectors(docs: list[str]) -> list[dict[str, float]]:
    toks = [Counter(_tokens(d)) for d in docs]
    df: Counter = Counter()
    for t in toks:
        df.update(t.keys())
    n = len(docs)
    vecs = []
    for t in toks:
        v = {k: (1 + math.log(c)) * math.log((1 + n) / (1 + df[k]) + 1) for k, c in t.items()}
        norm = math.sqrt(sum(x * x for x in v.values())) or 1.0
        vecs.append({k: x / norm for k, x in v.items()})
    return vecs


def cosine(a: dict[str, float], b: dict[str, float]) -> float:
    if len(a) > len(b):
        a, b = b, a
    return sum(x * b.get(k, 0.0) for k, x in a.items())


def max_similarity(candidate: str, history: list[str]) -> tuple[float, int]:
    """Höchste Ähnlichkeit (0..1) des Kandidaten zu einer bisherigen Story + Index."""
    if not history:
        return 0.0, -1
    vecs = _vectors([candidate, *history])
    sims = [cosine(vecs[0], v) for v in vecs[1:]]
    best = max(range(len(sims)), key=sims.__getitem__)
    return sims[best], best


def story_text(title: str, logline: str, script: str) -> str:
    return f"{title}. {logline}. {logline}. {script}"
