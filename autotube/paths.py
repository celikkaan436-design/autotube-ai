"""Zentrale Pfade. Alles relativ zum Repo-Root, per Umgebungsvariable überschreibbar."""
from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(os.environ.get("AUTOTUBE_ROOT", Path(__file__).resolve().parent.parent))
CONFIG_FILE = Path(os.environ.get("AUTOTUBE_CONFIG", ROOT / "config" / "autotube.json"))
DATA_DIR = Path(os.environ.get("AUTOTUBE_DATA", ROOT / "data"))
STATE_FILE = DATA_DIR / "state.json"
STORIES_DIR = DATA_DIR / "stories"
WORK_DIR = Path(os.environ.get("AUTOTUBE_WORK", ROOT / "work"))
ASSETS_DIR = ROOT / "assets"
FONTS_DIR = ASSETS_DIR / "fonts"
DASHBOARD_DIR = ROOT / "dashboard"

SUBTITLE_FONT_FILE = FONTS_DIR / "Outfit-Bold.ttf"
SUBTITLE_FONT_NAME = "Outfit"
TITLE_FONT_FILE = FONTS_DIR / "Gloock-Regular.ttf"
