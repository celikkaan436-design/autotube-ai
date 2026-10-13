"""HTTP mit Retry, exponentiellem Backoff + Jitter und Retry-After-Unterstützung."""
from __future__ import annotations

import random
import time
from typing import Any

import requests

from .log import get_logger, redact

log = get_logger("http")

RETRY_STATUS = {408, 425, 429, 500, 502, 503, 504}
_session = requests.Session()
_session.headers["User-Agent"] = "AutoTube-AI/1.0 (+https://github.com)"


class HttpError(Exception):
    def __init__(self, status: int, body: str, url: str):
        self.status = status
        self.body = body
        self.url = url
        super().__init__(f"HTTP {status} für {redact(url.split('?')[0])}: {redact(body[:500])}")


def _sleep_for(attempt: int, base: float, resp: requests.Response | None) -> float:
    if resp is not None:
        ra = resp.headers.get("Retry-After")
        if ra:
            try:
                return min(float(ra), 120.0)
            except ValueError:
                pass
    return min(base * (2 ** attempt), 90.0) * (0.75 + random.random() * 0.5)


def request(
    method: str,
    url: str,
    *,
    retries: int = 4,
    backoff: float = 2.0,
    timeout: float | tuple[float, float] = 60,
    retry_status: set[int] | None = None,
    raise_for_status: bool = True,
    **kwargs: Any,
) -> requests.Response:
    retry_status = RETRY_STATUS if retry_status is None else retry_status
    last_exc: Exception | None = None
    for attempt in range(retries + 1):
        resp = None
        try:
            resp = _session.request(method, url, timeout=timeout, **kwargs)
            if resp.status_code in retry_status and attempt < retries:
                wait = _sleep_for(attempt, backoff, resp)
                log.warning("HTTP-Retry", data={"status": resp.status_code, "url": url.split("?")[0], "wait": round(wait, 1)})
                time.sleep(wait)
                continue
            if raise_for_status and resp.status_code >= 400:
                raise HttpError(resp.status_code, resp.text, url)
            return resp
        except (requests.ConnectionError, requests.Timeout) as exc:
            last_exc = exc
            if attempt >= retries:
                break
            wait = _sleep_for(attempt, backoff, None)
            log.warning("Netzwerkfehler, neuer Versuch", data={"error": type(exc).__name__, "url": url.split("?")[0], "wait": round(wait, 1)})
            time.sleep(wait)
    raise ConnectionError(f"Nicht erreichbar nach {retries + 1} Versuchen: {redact(url.split('?')[0])}: {last_exc}")
