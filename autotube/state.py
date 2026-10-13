"""Persistenter Zustand als JSON im Repo (data/state.json).

Die Workflows committen die Datei nach jedem Lauf zurück ins Repo. Zusammen mit der
GitHub-Actions-`concurrency`-Gruppe ergibt das einen sauberen, gesperrten Single-Writer-Store.
"""
from __future__ import annotations

import copy
import json
import os
import tempfile
from pathlib import Path
from typing import Any

from . import paths
from .timeutil import iso

# Status eines Veröffentlichungstages
DAY_FINAL = {"scheduled", "uploaded", "published", "not_public"}
DAY_STATES = [
    "pending", "story_ready", "voice_ready", "images_ready", "rendered", "qa_passed",
    "uploaded", "scheduled", "published", "not_public", "failed", "missed",
]

_EMPTY: dict[str, Any] = {
    "version": 1,
    "repo": None,
    "autopilot": {"enabled": False, "activated_at": None, "deactivated_at": None, "last_change_reason": None},
    "channel": None,
    "preflight": None,
    "first_private_upload": None,
    "days": {},
    "videos": [],
    "stories": [],
    "analytics": {"updated_at": None, "channel_daily": [], "videos": {}, "insights": None},
    "usage": {},
    "activity": [],
    "runs": [],
}


class State:
    def __init__(self, data: dict[str, Any], path: Path):
        self.data = data
        self.path = path

    # ---------- Laden / Speichern ----------
    @classmethod
    def load(cls, path: Path | None = None) -> "State":
        path = path or paths.STATE_FILE
        data = copy.deepcopy(_EMPTY)
        if path.exists():
            loaded = json.loads(path.read_text(encoding="utf-8"))
            data.update(loaded)
            for k, v in _EMPTY.items():
                data.setdefault(k, copy.deepcopy(v))
        if os.environ.get("GITHUB_REPOSITORY"):
            data["repo"] = os.environ["GITHUB_REPOSITORY"]
        return cls(data, path)

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._trim()
        fd, tmp = tempfile.mkstemp(dir=self.path.parent, prefix=".state-", suffix=".json")
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(self.data, fh, ensure_ascii=False, indent=2, sort_keys=False)
            fh.write("\n")
        os.replace(tmp, self.path)  # atomar

    def _trim(self) -> None:
        self.data["activity"] = self.data["activity"][-400:]
        self.data["runs"] = self.data["runs"][-120:]
        usage = self.data["usage"]
        for k in sorted(usage)[:-62]:
            usage.pop(k, None)

    # ---------- Aktivitätslog ----------
    def log(self, level: str, msg: str, **data: Any) -> None:
        entry = {"ts": iso(), "level": level, "msg": msg}
        if data:
            entry["data"] = data
        self.data["activity"].append(entry)

    # ---------- Tage ----------
    def day(self, key: str) -> dict[str, Any]:
        days = self.data["days"]
        if key not in days:
            days[key] = {"status": "pending", "attempts": 0, "errors": [], "created_at": iso(), "updated_at": iso()}
        return days[key]

    def set_day(self, key: str, **fields: Any) -> dict[str, Any]:
        d = self.day(key)
        if "status" in fields and fields["status"] not in DAY_STATES:
            raise ValueError(f"Unbekannter Status {fields['status']}")
        d.update(fields)
        d["updated_at"] = iso()
        return d

    def day_error(self, key: str, error: str) -> None:
        d = self.day(key)
        d.setdefault("errors", []).append({"ts": iso(), "error": error[:800]})
        d["errors"] = d["errors"][-10:]
        d["updated_at"] = iso()

    # ---------- Videos ----------
    def add_video(self, record: dict[str, Any]) -> None:
        vids = self.data["videos"]
        if record.get("video_id"):
            for i, v in enumerate(vids):
                if v.get("video_id") == record["video_id"]:
                    vids[i] = {**v, **record}
                    return
        vids.append(record)

    def find_video(self, video_id: str) -> dict[str, Any] | None:
        return next((v for v in self.data["videos"] if v.get("video_id") == video_id), None)

    def published_videos(self) -> list[dict[str, Any]]:
        return [v for v in self.data["videos"] if v.get("video_id") and not v.get("test")]

    # ---------- Runs ----------
    def add_run(self, kind: str, result: str, **info: Any) -> None:
        self.data["runs"].append({
            "id": os.environ.get("GITHUB_RUN_ID"),
            "url": _run_url(),
            "kind": kind,
            "result": result,
            "ts": iso(),
            **info,
        })

    @property
    def autopilot_enabled(self) -> bool:
        return bool(self.data["autopilot"].get("enabled"))


def _run_url() -> str | None:
    server = os.environ.get("GITHUB_SERVER_URL")
    repo = os.environ.get("GITHUB_REPOSITORY")
    run = os.environ.get("GITHUB_RUN_ID")
    if server and repo and run:
        return f"{server}/{repo}/actions/runs/{run}"
    return None
