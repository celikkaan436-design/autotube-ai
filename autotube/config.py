"""Konfiguration: config/autotube.json (validiert mit Pydantic) + Secrets aus Umgebungsvariablen."""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator

from . import paths
from .log import register_secret


class VideoConfig(BaseModel):
    width: int = 1080
    height: int = 1920
    fps: int = 30
    min_duration: float = 40.0        # harte QA-Grenzen
    max_duration: float = 62.0
    target_min: float = 45.0          # Zielbereich für die Story-Länge
    target_max: float = 60.0
    scenes_min: int = 6
    scenes_max: int = 10
    crf: int = 21
    preset: str = "medium"
    film_grain: bool = True
    transition_seconds: float = 0.45

    @model_validator(mode="after")
    def _check(self):
        if (self.width, self.height) != (1080, 1920):
            raise ValueError("Shorts-Format muss 1080x1920 sein")
        if not (self.min_duration <= self.target_min < self.target_max <= self.max_duration):
            raise ValueError("Dauer-Grenzen inkonsistent")
        return self


class VoiceConfig(BaseModel):
    provider_chain: list[Literal["edge", "gemini", "piper"]] = ["edge", "gemini", "piper"]
    voice: str = "de-DE-ConradNeural"
    fallback_voices: list[str] = ["de-DE-KillianNeural", "de-DE-FlorianMultilingualNeural"]
    base_rate: int = 4                 # Prozent, Grundtempo
    base_pitch: int = -2               # Hz
    pause_between_scenes: float = 0.22
    pause_before_twist: float = 0.6
    target_lufs: float = -16.0
    pronunciations: dict[str, str] = Field(default_factory=lambda: {"KI": "K.I.", "z.B.": "zum Beispiel", "WLAN": "W-LAN"})
    piper_voice: str = "de_DE-thorsten-high"
    gemini_voice: str = "Charon"
    gemini_tts_models: list[str] = ["gemini-3.8-flash-tts", "gemini-3.8-flash-lite-tts", "gemini-2.5-flash-preview-tts"]


class LLMConfig(BaseModel):
    provider_chain: list[Literal["gemini", "pollinations", "openrouter"]] = ["gemini", "pollinations", "openrouter"]
    gemini_models: list[str] = ["gemini-3.6-flash", "gemini-3.8-flash", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite"]
    pollinations_model: str = "openai"
    openrouter_model: str = "deepseek/deepseek-chat-v3-0324:free"
    temperature: float = 1.0
    max_story_attempts: int = 4
    min_review_score: float = 7.0
    max_similarity: float = 0.45


class ImageConfig(BaseModel):
    provider_chain: list[Literal["pollinations", "cloudflare"]] = ["cloudflare", "pollinations"]
    pollinations_model: str = "flux"
    cloudflare_models: list[str] = ["@cf/black-forest-labs/flux-2-klein-4b", "@cf/black-forest-labs/flux-1-schnell"]
    gen_width: int = 864
    gen_height: int = 1536
    style_suffix: str = (
        "cinematic film still, moody low-key lighting, volumetric fog, 35mm anamorphic lens, "
        "shallow depth of field, film grain, muted teal and amber color grade, photorealistic, "
        "highly detailed, vertical composition, no text, no letters, no watermark"
    )
    max_fallback_scenes: int = 2       # max. prozedurale Ersatzbilder, sonst Abbruch
    request_spacing_seconds: float = 4.0


class MusicConfig(BaseModel):
    enabled: bool = True
    music_db: float = -19.0            # Musikpegel relativ zur Stimme
    duck_db: float = -7.0              # zusätzliches Absenken während gesprochen wird
    sfx_db: float = -14.0
    final_lufs: float = -14.0
    true_peak: float = -1.5


class YouTubeConfig(BaseModel):
    category_id: str = "24"            # Entertainment
    default_language: str = "de"
    made_for_kids: bool = False
    contains_synthetic_media: bool = True
    base_tags: list[str] = ["Shorts", "Gruselgeschichte", "Mystery", "Horror", "Kurzgeschichte", "Plot Twist", "KI Geschichte"]
    base_hashtags: list[str] = ["#shorts", "#gruselgeschichte", "#mystery", "#horror"]
    upload_thumbnail: bool = True
    disclosure_line: str = "Diese Geschichte ist frei erfunden und wurde mit KI erstellt (Text, Bilder, Stimme, Musik)."
    marker_prefix: str = "AutoTube-ID"


class LimitsConfig(BaseModel):
    llm_calls_per_day: int = 40
    image_calls_per_day: int = 80
    tts_calls_per_day: int = 60
    youtube_units_per_day: int = 8000
    allow_paid_providers: bool = False
    daily_budget_eur: float = 0.0
    monthly_budget_eur: float = 0.0


class Config(BaseModel):
    channel_name: str = "AutoTube Stories"
    timezone: str = "Europe/Berlin"
    publish_time: str = "18:00"
    min_lead_minutes: int = 45
    language: Literal["de"] = "de"
    genres: list[str] = ["Mystery", "Suspense", "Horror", "Plot-Twist"]
    video: VideoConfig = VideoConfig()
    voice: VoiceConfig = VoiceConfig()
    llm: LLMConfig = LLMConfig()
    images: ImageConfig = ImageConfig()
    music: MusicConfig = MusicConfig()
    youtube: YouTubeConfig = YouTubeConfig()
    limits: LimitsConfig = LimitsConfig()

    @field_validator("publish_time")
    @classmethod
    def _hhmm(cls, v: str) -> str:
        hh, mm = v.split(":")
        if not (0 <= int(hh) < 24 and 0 <= int(mm) < 60):
            raise ValueError("publish_time muss HH:MM sein")
        return f"{int(hh):02d}:{int(mm):02d}"

    @field_validator("timezone")
    @classmethod
    def _tz(cls, v: str) -> str:
        if v != "Europe/Berlin":
            raise ValueError("Zeitzone ist fest auf Europe/Berlin eingestellt")
        return v


def load_config(path: Path | None = None) -> Config:
    path = path or paths.CONFIG_FILE
    if path.exists():
        return Config.model_validate(json.loads(path.read_text(encoding="utf-8")))
    return Config()


class Secrets(BaseModel):
    """Secrets kommen ausschließlich aus Umgebungsvariablen (GitHub Secrets) — nie aus Dateien im Repo."""
    gemini_api_key: str | None = None
    pollinations_token: str | None = None
    openrouter_api_key: str | None = None
    cloudflare_account_id: str | None = None
    cloudflare_api_token: str | None = None
    google_client_id: str | None = None
    google_client_secret: str | None = None
    youtube_refresh_token: str | None = None
    github_token: str | None = None
    github_repository: str | None = None

    @property
    def youtube_configured(self) -> bool:
        return bool(self.google_client_id and self.google_client_secret and self.youtube_refresh_token)


def load_secrets() -> Secrets:
    def env(name: str) -> str | None:
        v = os.environ.get(name, "").strip()
        return v or None

    s = Secrets(
        gemini_api_key=env("GEMINI_API_KEY"),
        pollinations_token=env("POLLINATIONS_TOKEN"),
        openrouter_api_key=env("OPENROUTER_API_KEY"),
        cloudflare_account_id=env("CLOUDFLARE_ACCOUNT_ID"),
        cloudflare_api_token=env("CLOUDFLARE_API_TOKEN"),
        google_client_id=env("GOOGLE_CLIENT_ID"),
        google_client_secret=env("GOOGLE_CLIENT_SECRET"),
        youtube_refresh_token=env("YOUTUBE_REFRESH_TOKEN"),
        github_token=env("GITHUB_TOKEN"),
        github_repository=env("GITHUB_REPOSITORY"),
    )
    for name, value in s.model_dump().items():
        if name not in ("github_repository", "google_client_id", "cloudflare_account_id"):
            register_secret(value)
    return s
