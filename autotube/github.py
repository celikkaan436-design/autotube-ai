"""GitHub-Integration: Video-Downloads als Release, Benachrichtigungen als Issue (GitHub schickt E-Mails)."""
from __future__ import annotations

import mimetypes
from pathlib import Path

from .config import Secrets
from .http import HttpError, request
from .log import get_logger

log = get_logger("github")
API = "https://api.github.com"


class GitHub:
    def __init__(self, secrets: Secrets):
        self.token = secrets.github_token
        self.repo = secrets.github_repository

    @property
    def enabled(self) -> bool:
        return bool(self.token and self.repo)

    def _h(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.token}", "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28"}

    def release_with_assets(self, tag: str, name: str, body: str, files: list[Path]) -> str | None:
        """Legt ein Release an (oder nutzt das vorhandene) und hängt Dateien an. Gibt die Release-URL zurück."""
        if not self.enabled:
            return None
        try:
            r = request("GET", f"{API}/repos/{self.repo}/releases/tags/{tag}", headers=self._h(), timeout=30,
                        raise_for_status=False)
            if r.status_code == 200:
                rel = r.json()
            else:
                rel = request("POST", f"{API}/repos/{self.repo}/releases", headers=self._h(), timeout=30,
                              json={"tag_name": tag, "name": name, "body": body, "make_latest": "false"}).json()
            existing = {a["name"] for a in rel.get("assets", [])}
            upload_url = rel["upload_url"].split("{")[0]
            for f in files:
                if f.name in existing:
                    continue
                ctype = mimetypes.guess_type(f.name)[0] or "application/octet-stream"
                request("POST", upload_url, params={"name": f.name}, data=f.read_bytes(), timeout=(30, 600),
                        headers={**self._h(), "Content-Type": ctype}, retries=2)
            return rel["html_url"]
        except (HttpError, ConnectionError, KeyError) as exc:
            log.warning("Release konnte nicht erstellt werden", data={"error": str(exc)[:300]})
            return None

    def notify(self, title: str, body: str, label: str = "autotube") -> None:
        """Öffnet ein Issue (oder kommentiert ein offenes mit gleichem Titel). GitHub benachrichtigt per E-Mail."""
        if not self.enabled:
            log.info("Benachrichtigung (lokal)", data={"title": title, "body": body[:500]})
            return
        try:
            q = request("GET", f"{API}/repos/{self.repo}/issues", headers=self._h(), timeout=30,
                        params={"state": "open", "labels": label, "per_page": 50}, raise_for_status=False)
            issues = q.json() if q.status_code == 200 else []
            match = next((i for i in issues if i.get("title") == title), None)
            if match:
                request("POST", f"{API}/repos/{self.repo}/issues/{match['number']}/comments", headers=self._h(),
                        json={"body": body}, timeout=30)
            else:
                request("POST", f"{API}/repos/{self.repo}/issues", headers=self._h(), timeout=30,
                        json={"title": title, "body": body, "labels": [label]})
        except (HttpError, ConnectionError) as exc:
            log.warning("Benachrichtigung fehlgeschlagen", data={"error": str(exc)[:300]})
