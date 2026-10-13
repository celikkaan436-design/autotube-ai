"""Typisiertes Storyboard-Schema (Pydantic) — validiert jede KI-Antwort."""
from __future__ import annotations

import re
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator

Beat = Literal["hook", "setup", "escalation", "twist", "ending"]
Camera = Literal["zoom_in", "zoom_out", "pan_left", "pan_right", "pan_up", "pan_down", "shake", "dolly_in"]
Transition = Literal["crossfade", "fade_black", "flash", "glitch", "cut"]
AudioCue = Literal["none", "whoosh", "heartbeat", "riser", "impact", "sting", "silence", "drone"]
Mood = Literal["dark", "cold", "warm", "red"]

_CAMERA_ALIASES = {"zoom": "zoom_in", "push_in": "dolly_in", "pan": "pan_right", "static": "zoom_in", "handheld": "shake"}
_TRANSITION_ALIASES = {"fade": "fade_black", "dissolve": "crossfade", "whip": "glitch", "hard_cut": "cut"}


def _norm(v: Any, allowed: tuple[str, ...], aliases: dict[str, str], default: str) -> str:
    s = str(v or "").strip().lower().replace("-", "_").replace(" ", "_")
    s = aliases.get(s, s)
    return s if s in allowed else default


class Character(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    visual: str = Field(min_length=10, max_length=400, description="Englische, wiedererkennbare Optik-Beschreibung")


class Scene(BaseModel):
    beat: Beat
    narration: str = Field(min_length=3, max_length=420)
    visual_prompt: str = Field(min_length=25, max_length=900)
    characters: list[str] = Field(default_factory=list)
    camera: Camera = "zoom_in"
    transition: Transition = "crossfade"
    audio_cue: AudioCue = "none"
    mood: Mood = "dark"

    @field_validator("beat", mode="before")
    @classmethod
    def _beat(cls, v: Any) -> str:
        s = str(v).strip().lower()
        return {"plot_twist": "twist", "plottwist": "twist", "climax": "twist", "intro": "hook", "end": "ending", "outro": "ending",
                "build_up": "escalation", "buildup": "escalation", "rising": "escalation"}.get(s, s)

    @field_validator("camera", mode="before")
    @classmethod
    def _cam(cls, v: Any) -> str:
        return _norm(v, Camera.__args__, _CAMERA_ALIASES, "zoom_in")  # type: ignore[attr-defined]

    @field_validator("transition", mode="before")
    @classmethod
    def _tr(cls, v: Any) -> str:
        return _norm(v, Transition.__args__, _TRANSITION_ALIASES, "crossfade")  # type: ignore[attr-defined]

    @field_validator("audio_cue", mode="before")
    @classmethod
    def _cue(cls, v: Any) -> str:
        return _norm(v, AudioCue.__args__, {"boom": "impact", "hit": "impact", "swoosh": "whoosh"}, "none")  # type: ignore[attr-defined]

    @field_validator("mood", mode="before")
    @classmethod
    def _mood(cls, v: Any) -> str:
        return _norm(v, Mood.__args__, {"blue": "cold", "night": "dark", "orange": "warm", "blood": "red"}, "dark")  # type: ignore[attr-defined]

    @field_validator("narration")
    @classmethod
    def _clean(cls, v: str) -> str:
        return re.sub(r"\s+", " ", v).strip()


class YouTubeMeta(BaseModel):
    title: str = Field(min_length=5, max_length=95)
    description: str = Field(min_length=10, max_length=4000)
    tags: list[str] = Field(default_factory=list)
    thumbnail_text: str = Field(min_length=2, max_length=48)

    @field_validator("tags")
    @classmethod
    def _tags(cls, v: list[str]) -> list[str]:
        out, seen = [], set()
        for t in v:
            t = str(t).strip().lstrip("#")[:30]
            if t and t.lower() not in seen:
                seen.add(t.lower())
                out.append(t)
        return out[:15]


class Storyboard(BaseModel):
    id: str | None = None
    created_at: str | None = None
    title: str = Field(min_length=3, max_length=80)
    genre: str
    logline: str = Field(min_length=10, max_length=400)
    hook_style: str = "frage"
    setting: str = Field(min_length=5, max_length=500)
    visual_style: str = Field(default="", max_length=400)
    characters: list[Character] = Field(default_factory=list, max_length=4)
    scenes: list[Scene] = Field(min_length=4, max_length=12)
    youtube: YouTubeMeta
    # werden nach der Generierung ergänzt
    provider: str | None = None
    review: dict | None = None
    timeline: dict | None = None

    @property
    def script(self) -> str:
        return " ".join(s.narration for s in self.scenes)

    @property
    def word_count(self) -> int:
        return len([w for w in self.script.split() if re.search(r"\w", w)])

    def scene_prompt(self, idx: int, style_suffix: str) -> str:
        """Bildprompt mit konsistenter Figuren- und Stilbeschreibung."""
        scene = self.scenes[idx]
        chars = {c.name.lower(): c for c in self.characters}
        parts = [scene.visual_prompt.strip().rstrip(".")]
        for name in scene.characters:
            c = chars.get(name.lower())
            if c and c.visual.lower()[:30] not in scene.visual_prompt.lower():
                parts.append(f"{c.name}: {c.visual.strip().rstrip('.')}")
        if self.visual_style:
            parts.append(self.visual_style.strip().rstrip("."))
        parts.append(style_suffix)
        return ". ".join(parts)
