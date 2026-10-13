"""Sichert den Zustand sofort ins Repo (Checkpoint), z. B. direkt nach einem Upload — Absturzsicherheit."""
from __future__ import annotations

import os
import subprocess
import time

from . import paths
from .log import get_logger

log = get_logger("git")


def _git(*args: str, check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], cwd=paths.ROOT, capture_output=True, text=True, check=check)


def persist(message: str) -> bool:
    if os.environ.get("AUTOTUBE_GIT_PERSIST") != "1":
        return False
    _git("config", "user.name", "AutoTube Bot", check=False)
    _git("config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com", check=False)
    _git("add", "data", check=False)
    if _git("diff", "--cached", "--quiet", check=False).returncode == 0:
        return False
    _git("commit", "-m", f"{message} [skip ci]", check=False)
    for attempt in range(4):
        pull = _git("pull", "--rebase", "--autostash", check=False)
        if pull.returncode != 0:
            _git("rebase", "--abort", check=False)
            log.warning("git pull --rebase fehlgeschlagen", data={"stderr": pull.stderr[-300:]})
        push = _git("push", check=False)
        if push.returncode == 0:
            return True
        time.sleep(3 * (attempt + 1))
    log.error("Zustand konnte nicht ins Repo gepusht werden")
    return False
