"""Strukturiertes Logging (JSON-Zeilen) mit automatischer Schwärzung von Secrets."""
from __future__ import annotations

import json
import logging
import os
import re
import sys
from datetime import datetime, timezone
from typing import Any

_SECRET_PATTERNS = [
    re.compile(r"ya29\.[0-9A-Za-z_\-\.]+"),            # Google Access Token
    re.compile(r"1//[0-9A-Za-z_\-]{20,}"),             # Google Refresh Token
    re.compile(r"AIza[0-9A-Za-z_\-]{30,}"),            # Google API Key
    re.compile(r"AQ\.[0-9A-Za-z_\-\.]{20,}"),          # Google Authorization Key (neues AI-Studio-Format)
    re.compile(r"GOCSPX-[0-9A-Za-z_\-]+"),             # Google Client Secret
    re.compile(r"(?i)bearer\s+[0-9A-Za-z\._\-]{12,}"),
    re.compile(r"sk-or-v1-[0-9a-f]{20,}"),             # OpenRouter
    re.compile(r"\bsk_[0-9A-Za-z]{16,}"),              # Pollinations secret key
    re.compile(r"gh[pousr]_[0-9A-Za-z]{20,}"),         # GitHub Token
]
_registered: set[str] = set()


def register_secret(value: str | None) -> None:
    """Merkt sich einen Secret-Wert zum Schwärzen; maskiert ihn zusätzlich in GitHub-Actions-Logs."""
    if not value or len(value) < 8 or value in _registered:
        return
    _registered.add(value)
    if os.environ.get("GITHUB_ACTIONS") == "true":
        sys.stdout.write(f"::add-mask::{value}\n")
        sys.stdout.flush()


def redact(text: str) -> str:
    for s in _registered:
        text = text.replace(s, "***")
    for p in _SECRET_PATTERNS:
        text = p.sub("***", text)
    return text


class _JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "level": record.levelname,
            "msg": redact(record.getMessage()),
        }
        data = getattr(record, "data", None)
        if data:
            payload["data"] = json.loads(redact(json.dumps(data, default=str, ensure_ascii=False)))
        if record.exc_info:
            payload["exc"] = redact(self.formatException(record.exc_info))
        return json.dumps(payload, ensure_ascii=False)


class _Adapter(logging.LoggerAdapter):
    def process(self, msg, kwargs):
        data = kwargs.pop("data", None)
        if data is not None:
            kwargs.setdefault("extra", {})["data"] = data
        return msg, kwargs


_configured = False


def get_logger(name: str = "autotube") -> _Adapter:
    global _configured
    if not _configured:
        handler = logging.StreamHandler(sys.stderr)
        handler.setFormatter(_JsonFormatter())
        root = logging.getLogger("autotube")
        root.handlers[:] = [handler]
        root.setLevel(os.environ.get("AUTOTUBE_LOG_LEVEL", "INFO"))
        root.propagate = False
        _configured = True
    if not name.startswith("autotube"):
        name = f"autotube.{name}"
    return _Adapter(logging.getLogger(name), {})


def summary(markdown: str) -> None:
    """Schreibt Markdown in die GitHub-Actions-Job-Zusammenfassung (falls vorhanden)."""
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if path:
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(redact(markdown) + "\n")
    else:
        sys.stdout.write(redact(markdown) + "\n")
