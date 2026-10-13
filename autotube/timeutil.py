"""Zeitzonen-Logik (Europe/Berlin inkl. Sommer-/Winterzeit)."""
from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

BERLIN = ZoneInfo("Europe/Berlin")


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def now_berlin() -> datetime:
    return now_utc().astimezone(BERLIN)


def parse_hhmm(value: str) -> time:
    hh, mm = value.split(":")
    return time(int(hh), int(mm))


def slot_on(day: date, publish_time: str = "18:00") -> datetime:
    """Veröffentlichungszeitpunkt an einem Tag (Berliner Ortszeit, DST-korrekt)."""
    return datetime.combine(day, parse_hhmm(publish_time), tzinfo=BERLIN)


def next_slot(now: datetime | None = None, publish_time: str = "18:00", min_lead_minutes: int = 45) -> datetime:
    """Nächster Slot, der noch mindestens `min_lead_minutes` in der Zukunft liegt."""
    now = (now or now_utc()).astimezone(BERLIN)
    slot = slot_on(now.date(), publish_time)
    if now + timedelta(minutes=min_lead_minutes) > slot:
        slot = slot_on(now.date() + timedelta(days=1), publish_time)
    return slot


def to_rfc3339_utc(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def iso(dt: datetime | None = None) -> str:
    return (dt or now_utc()).astimezone(timezone.utc).isoformat(timespec="seconds")


def today_key(now: datetime | None = None) -> str:
    return (now or now_utc()).astimezone(BERLIN).date().isoformat()
