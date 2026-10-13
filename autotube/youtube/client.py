"""YouTube Data API v3 + Analytics API — OAuth (Refresh Token), resumable Upload, Status, Statistiken."""
from __future__ import annotations

import json
import os
import time
from datetime import date, timedelta
from pathlib import Path
from typing import Any

from ..budget import Budget
from ..config import Secrets
from ..http import HttpError, request
from ..log import get_logger, register_secret

log = get_logger("youtube")

TOKEN_URL = "https://oauth2.googleapis.com/token"
API = "https://www.googleapis.com/youtube/v3"
UPLOAD = "https://www.googleapis.com/upload/youtube/v3"
ANALYTICS = "https://youtubeanalytics.googleapis.com/v2/reports"
SCOPES = [
    "https://www.googleapis.com/auth/youtube.upload",
    "https://www.googleapis.com/auth/youtube.readonly",
    "https://www.googleapis.com/auth/yt-analytics.readonly",
]
CHUNK = 8 * 1024 * 1024


class YouTubeError(Exception):
    kind = "error"


class AuthRevoked(YouTubeError):
    kind = "revoked"


class QuotaExceeded(YouTubeError):
    kind = "quota"


class NotConfigured(YouTubeError):
    kind = "not_configured"


def _classify(exc: HttpError) -> YouTubeError:
    body = exc.body or ""
    try:
        reasons = [e.get("reason") for e in json.loads(body).get("error", {}).get("errors", [])]
    except (ValueError, AttributeError):
        reasons = []
    if "quotaExceeded" in reasons or "dailyLimitExceeded" in reasons or "uploadLimitExceeded" in reasons:
        return QuotaExceeded(f"YouTube-Kontingent erschöpft ({reasons}) — morgen wieder verfügbar")
    if exc.status == 401 or "invalid_grant" in body:
        return AuthRevoked("YouTube-Zugriff widerrufen oder abgelaufen — Refresh Token neu erzeugen")
    if exc.status == 403 and ("insufficientPermissions" in body or "ACCESS_TOKEN_SCOPE_INSUFFICIENT" in body):
        return AuthRevoked("Dem Token fehlen Berechtigungen (Scopes) — Refresh Token mit allen Scopes neu erzeugen")
    err = YouTubeError(f"YouTube-API-Fehler {exc.status}: {body[:400]}")
    return err


class YouTube:
    def __init__(self, secrets: Secrets, budget: Budget):
        if not secrets.youtube_configured:
            raise NotConfigured("YouTube ist nicht verbunden (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / YOUTUBE_REFRESH_TOKEN fehlen)")
        self.secrets = secrets
        self.budget = budget
        self._token: str | None = None
        self._token_exp = 0.0
        self.scopes: list[str] = []

    # ------------------------------------------------------------ Auth
    def token(self) -> str:
        if self._token and time.time() < self._token_exp - 60:
            return self._token
        try:
            r = request("POST", TOKEN_URL, data={
                "client_id": self.secrets.google_client_id,
                "client_secret": self.secrets.google_client_secret,
                "refresh_token": self.secrets.youtube_refresh_token,
                "grant_type": "refresh_token",
            }, timeout=30, retries=3)
        except HttpError as exc:
            if "invalid_grant" in exc.body or exc.status in (400, 401):
                raise AuthRevoked("Refresh Token ungültig/widerrufen. Hinweis: Im Google-Testmodus laufen Tokens nach 7 Tagen ab — "
                                  "OAuth-App auf 'In Produktion' stellen und Token neu erzeugen.") from exc
            raise _classify(exc) from exc
        data = r.json()
        self._token = data["access_token"]
        register_secret(self._token)
        self._token_exp = time.time() + int(data.get("expires_in", 3600))
        self.scopes = (data.get("scope") or "").split()
        return self._token

    def _h(self, extra: dict[str, str] | None = None) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.token()}", **(extra or {})}

    def _get(self, url: str, params: dict[str, Any], op: str = "list") -> dict:
        self.budget.youtube(op)
        try:
            return request("GET", url, params=params, headers=self._h(), timeout=60).json()
        except HttpError as exc:
            raise _classify(exc) from exc

    # ------------------------------------------------------------ Kanal
    def channel(self) -> dict[str, Any]:
        data = self._get(f"{API}/channels", {"part": "snippet,statistics,contentDetails,status", "mine": "true"})
        items = data.get("items") or []
        if not items:
            raise YouTubeError("Mit diesem Google-Konto ist kein YouTube-Kanal verknüpft")
        ch = items[0]
        stats = ch.get("statistics", {})
        return {
            "id": ch["id"],
            "title": ch["snippet"]["title"],
            "custom_url": ch["snippet"].get("customUrl"),
            "thumbnail": ch["snippet"].get("thumbnails", {}).get("default", {}).get("url"),
            "subscribers": None if stats.get("hiddenSubscriberCount") else int(stats.get("subscriberCount", 0)),
            "views": int(stats.get("viewCount", 0)),
            "videos": int(stats.get("videoCount", 0)),
            "uploads_playlist": ch["contentDetails"]["relatedPlaylists"]["uploads"],
            "long_uploads": ch.get("status", {}).get("longUploadsStatus"),
        }

    def recent_uploads(self, uploads_playlist: str, max_results: int = 25) -> list[dict[str, Any]]:
        data = self._get(f"{API}/playlistItems", {"part": "snippet,status", "playlistId": uploads_playlist,
                                                  "maxResults": max_results})
        return [{"video_id": it["snippet"]["resourceId"]["videoId"], "title": it["snippet"]["title"],
                 "description": it["snippet"].get("description", ""), "privacy": it.get("status", {}).get("privacyStatus")}
                for it in data.get("items", [])]

    def find_by_marker(self, uploads_playlist: str, marker: str) -> dict[str, Any] | None:
        for it in self.recent_uploads(uploads_playlist):
            if marker in it["description"]:
                return it
        return None

    # ------------------------------------------------------------ Videos
    def videos(self, ids: list[str]) -> list[dict[str, Any]]:
        out = []
        for i in range(0, len(ids), 50):
            data = self._get(f"{API}/videos", {"part": "status,snippet,statistics,processingDetails,contentDetails",
                                              "id": ",".join(ids[i : i + 50])})
            out.extend(data.get("items", []))
        return out

    def video_status(self, video_id: str) -> dict[str, Any] | None:
        items = self.videos([video_id])
        if not items:
            return None
        v = items[0]
        st = v.get("status", {})
        return {
            "video_id": v["id"],
            "privacy": st.get("privacyStatus"),
            "upload_status": st.get("uploadStatus"),
            "publish_at": st.get("publishAt"),
            "rejection_reason": st.get("rejectionReason"),
            "failure_reason": st.get("failureReason"),
            "processing": v.get("processingDetails", {}).get("processingStatus"),
            "synthetic": st.get("containsSyntheticMedia"),
            "stats": {k: int(x) for k, x in v.get("statistics", {}).items() if str(x).isdigit()},
            "title": v.get("snippet", {}).get("title"),
        }

    def upload(self, video: Path, meta: dict[str, Any]) -> dict[str, Any]:
        """Resumable Upload gemäß YouTube-Doku, mit Wiederaufnahme nach Abbrüchen."""
        self.budget.youtube("upload")
        size = video.stat().st_size
        try:
            init = request(
                "POST", f"{UPLOAD}/videos", params={"uploadType": "resumable", "part": "snippet,status"},
                headers=self._h({"Content-Type": "application/json; charset=UTF-8",
                                 "X-Upload-Content-Type": "video/mp4", "X-Upload-Content-Length": str(size)}),
                data=json.dumps(meta).encode("utf-8"), timeout=60, retries=3,
            )
        except HttpError as exc:
            raise _classify(exc) from exc
        session_url = init.headers.get("Location")
        if not session_url:
            raise YouTubeError("Keine Upload-Session erhalten")
        offset = 0
        failures = 0
        with open(video, "rb") as fh:
            while True:
                fh.seek(offset)
                chunk = fh.read(CHUNK)
                end = offset + len(chunk) - 1
                try:
                    r = request("PUT", session_url, data=chunk, timeout=(30, 300), retries=0, raise_for_status=False,
                                headers=self._h({"Content-Length": str(len(chunk)),
                                                 "Content-Range": f"bytes {offset}-{end}/{size}"}))
                except ConnectionError:
                    r = None
                if r is not None and r.status_code in (200, 201):
                    return r.json()
                if r is not None and r.status_code == 308:
                    rng = r.headers.get("Range")
                    offset = int(rng.split("-")[1]) + 1 if rng else 0
                    failures = 0
                    continue
                if r is not None and r.status_code < 500 and r.status_code not in (408, 429):
                    raise _classify(HttpError(r.status_code, r.text, session_url))
                failures += 1
                if failures > 6:
                    raise YouTubeError("Upload nach mehreren Wiederholungen abgebrochen")
                time.sleep(min(60, 2 ** failures))
                st = request("PUT", session_url, timeout=60, retries=2, raise_for_status=False,
                             headers=self._h({"Content-Length": "0", "Content-Range": f"bytes */{size}"}))
                if st.status_code in (200, 201):
                    return st.json()
                rng = st.headers.get("Range")
                offset = int(rng.split("-")[1]) + 1 if rng else 0

    def set_thumbnail(self, video_id: str, image: Path) -> bool:
        self.budget.youtube("thumbnail")
        try:
            request("POST", f"{UPLOAD}/thumbnails/set", params={"videoId": video_id, "uploadType": "media"},
                    headers=self._h({"Content-Type": "image/jpeg"}), data=image.read_bytes(), timeout=120, retries=2)
            return True
        except HttpError as exc:
            log.warning("Thumbnail nicht gesetzt (Kanal evtl. nicht für eigene Thumbnails verifiziert)",
                        data={"status": exc.status, "body": exc.body[:300]})
            return False

    # ------------------------------------------------------------ Analytics
    def analytics_query(self, params: dict[str, Any]) -> dict:
        try:
            return request("GET", ANALYTICS, params={"ids": "channel==MINE", **params}, headers=self._h(), timeout=60).json()
        except HttpError as exc:
            raise _classify(exc) from exc

    def video_analytics(self, video_id: str, published: date) -> dict[str, Any]:
        start = published.isoformat()
        end = (date.today()).isoformat()
        metrics = "views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,likes,comments,shares,subscribersGained,subscribersLost"
        data = self.analytics_query({"startDate": start, "endDate": end, "metrics": metrics, "filters": f"video=={video_id}"})
        out: dict[str, Any] = {}
        if data.get("rows"):
            for h, val in zip(data["columnHeaders"], data["rows"][0]):
                out[h["name"]] = val
        try:
            ret = self.analytics_query({"startDate": start, "endDate": end, "metrics": "audienceWatchRatio",
                                        "dimensions": "elapsedVideoTimeRatio", "filters": f"video=={video_id}"})
            curve = [(float(r[0]), float(r[1])) for r in ret.get("rows", [])]
            if curve:
                out["retention_curve"] = curve
                near = min(curve, key=lambda c: abs(c[0] - 0.1))
                out["retention_at_10pct"] = near[1]
        except YouTubeError as exc:
            log.info("Retention nicht verfügbar", data={"video": video_id, "error": str(exc)[:200]})
        return out

    def channel_daily(self, days: int = 28) -> list[dict[str, Any]]:
        end = date.today()
        start = end - timedelta(days=days)
        data = self.analytics_query({"startDate": start.isoformat(), "endDate": end.isoformat(),
                                     "metrics": "views,estimatedMinutesWatched,subscribersGained,subscribersLost",
                                     "dimensions": "day", "sort": "day"})
        heads = [h["name"] for h in data.get("columnHeaders", [])]
        return [dict(zip(heads, row)) for row in data.get("rows", [])]


def build_metadata(storyboard, cfg, publish_at: str | None, marker: str) -> dict[str, Any]:
    y = cfg.youtube
    title = storyboard.youtube.title.strip()
    if "#shorts" not in title.lower() and len(title) <= 90:
        title = f"{title} #shorts"
    title = title[:100]
    hashtags = " ".join(dict.fromkeys(y.base_hashtags + [f"#{storyboard.genre.lower().replace('-', '')}"]))
    description = (
        f"{storyboard.youtube.description.strip()}\n\n{hashtags}\n\n{y.disclosure_line}\n\n{y.marker_prefix}: {marker}"
    )[:4900]
    tags = list(dict.fromkeys([*storyboard.youtube.tags, *y.base_tags, storyboard.genre]))
    total, kept = 0, []
    for t in tags:
        if total + len(t) + 3 > 480:
            break
        kept.append(t)
        total += len(t) + 3
    status: dict[str, Any] = {
        "privacyStatus": "private",
        "selfDeclaredMadeForKids": y.made_for_kids,
        "containsSyntheticMedia": y.contains_synthetic_media,
        "embeddable": True,
        "license": "youtube",
    }
    if publish_at:
        status["publishAt"] = publish_at
    return {
        "snippet": {"title": title, "description": description, "tags": kept, "categoryId": y.category_id,
                    "defaultLanguage": y.default_language, "defaultAudioLanguage": y.default_language},
        "status": status,
    }


def oauth_consent_url(client_id: str, redirect_uri: str) -> str:
    from urllib.parse import urlencode

    return "https://accounts.google.com/o/oauth2/v2/auth?" + urlencode({
        "client_id": client_id, "redirect_uri": redirect_uri, "response_type": "code",
        "scope": " ".join(SCOPES), "access_type": "offline", "prompt": "consent", "include_granted_scopes": "true",
    })


def exchange_code(client_id: str, client_secret: str, code: str, redirect_uri: str) -> dict:
    r = request("POST", TOKEN_URL, data={"client_id": client_id, "client_secret": client_secret, "code": code,
                                         "redirect_uri": redirect_uri, "grant_type": "authorization_code"}, timeout=30)
    return r.json()


def is_github_actions() -> bool:
    return os.environ.get("GITHUB_ACTIONS") == "true"
