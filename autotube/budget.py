"""Budget- und Kontingent-Verwaltung.

Alle Standard-Anbieter sind kostenlos. Das Budget-Modul zählt trotzdem jeden Aufruf,
erzwingt Tageslimits (damit Gratis-Kontingente nicht gesprengt werden) und blockiert
jeden als kostenpflichtig markierten Anbieter, solange `allow_paid_providers` false ist.
"""
from __future__ import annotations

from datetime import datetime

from .config import LimitsConfig
from .state import State
from .timeutil import today_key

# geschätzte YouTube-Data-API-Kosten (konservativ, Upload war lange 1600 Einheiten)
YOUTUBE_UNITS = {"upload": 1600, "thumbnail": 50, "list": 1, "update": 50}


class BudgetExceeded(Exception):
    pass


class PaidProviderBlocked(Exception):
    pass


class Budget:
    def __init__(self, state: State, limits: LimitsConfig, now: datetime | None = None):
        self.state = state
        self.limits = limits
        self.key = today_key(now)

    def _today(self) -> dict:
        return self.state.data["usage"].setdefault(self.key, {})

    def used(self, counter: str) -> float:
        return float(self._today().get(counter, 0))

    def total(self, prefix: str) -> float:
        return sum(v for k, v in self._today().items() if k.startswith(prefix))

    def _limit_for(self, kind: str) -> float:
        return {
            "llm": self.limits.llm_calls_per_day,
            "image": self.limits.image_calls_per_day,
            "tts": self.limits.tts_calls_per_day,
            "youtube_units": self.limits.youtube_units_per_day,
        }[kind]

    def check(self, kind: str, amount: float = 1, *, paid: bool = False, est_cost_eur: float = 0.0) -> None:
        if paid and not self.limits.allow_paid_providers:
            raise PaidProviderBlocked(f"Kostenpflichtiger Anbieter für '{kind}' ist nicht freigegeben")
        if self.total(f"{kind}:") + amount > self._limit_for(kind):
            raise BudgetExceeded(f"Tageslimit für {kind} erreicht ({self._limit_for(kind)})")
        if est_cost_eur > 0:
            if self.used("cost_eur") + est_cost_eur > self.limits.daily_budget_eur:
                raise BudgetExceeded("Tagesbudget (EUR) erreicht")
            month = self.key[:7]
            spent = sum(v.get("cost_eur", 0) for k, v in self.state.data["usage"].items() if k.startswith(month))
            if spent + est_cost_eur > self.limits.monthly_budget_eur:
                raise BudgetExceeded("Monatsbudget (EUR) erreicht")

    def record(self, kind: str, provider: str, amount: float = 1, cost_eur: float = 0.0) -> None:
        t = self._today()
        k = f"{kind}:{provider}"
        t[k] = t.get(k, 0) + amount
        if cost_eur:
            t["cost_eur"] = round(t.get("cost_eur", 0) + cost_eur, 4)

    def youtube(self, op: str) -> None:
        units = YOUTUBE_UNITS[op]
        self.check("youtube_units", units)
        self.record("youtube_units", op, units)
