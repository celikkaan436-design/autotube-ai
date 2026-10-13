"""Bild-KI mit kostenloser Anbieter-Kette: Pollinations (anonym/Token) → Cloudflare Workers AI (Free Tier).

Letzte Rückfallebene: prozedural erzeugtes, stimmungsvolles Nebel-/Licht-Bild (lokal, ohne API).
Wie viele Szenen höchstens prozedural sein dürfen, regelt `images.max_fallback_scenes`.
"""
from __future__ import annotations

import base64
import io
import re
import time
import urllib.parse
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

from ..budget import Budget
from ..config import Config, Secrets
from ..http import HttpError, request
from ..log import get_logger

log = get_logger("images")
_BLOCKED: dict[str, str] = {}


class ImageError(Exception):
    pass


def _validate_image(data: bytes, min_side: int = 400) -> Image.Image:
    if len(data) < 8_000:
        raise ImageError(f"Bild zu klein ({len(data)} Bytes)")
    try:
        img = Image.open(io.BytesIO(data))
        img.load()
    except Exception as exc:  # noqa: BLE001
        raise ImageError(f"Bild nicht lesbar: {exc}") from exc
    if min(img.size) < min_side:
        raise ImageError(f"Auflösung zu gering: {img.size}")
    arr = np.asarray(img.convert("L"), dtype=np.float32)
    if arr.std() < 4.0:
        raise ImageError("Bild ist (fast) einfarbig — vermutlich Fehlerbild")
    return img.convert("RGB")


class PollinationsImage:
    name = "pollinations"
    paid = False

    def __init__(self, token: str | None, model: str):
        self.token = token
        self.model = model

    def available(self) -> bool:
        return True

    def generate(self, prompt: str, width: int, height: int, seed: int) -> Image.Image:
        q = urllib.parse.quote(prompt[:1500], safe="")
        params = {"width": width, "height": height, "seed": seed, "model": self.model,
                  "nologo": "true", "private": "true", "enhance": "false", "safe": "true"}
        endpoints: list[tuple[str, dict]] = []
        if self.token:
            endpoints.append((f"https://gen.pollinations.ai/image/{q}", {"Authorization": f"Bearer {self.token}"}))
        endpoints.append((f"https://image.pollinations.ai/prompt/{q}", {}))
        endpoints.append((f"https://gen.pollinations.ai/image/{q}", {}))
        last: Exception | None = None
        for url, headers in endpoints:
            try:
                r = request("GET", url, params=params, headers=headers, timeout=(20, 240), retries=3, backoff=6.0)
                ctype = r.headers.get("Content-Type", "")
                if "image" not in ctype:
                    raise ImageError(f"Kein Bild erhalten ({ctype})")
                return _validate_image(r.content)
            except (HttpError, ImageError, ConnectionError) as exc:
                log.warning("Pollinations-Endpunkt fehlgeschlagen", data={"url": url[:60], "error": str(exc)[:200]})
                last = exc
        raise ImageError(f"Pollinations fehlgeschlagen: {last}")


class CloudflareImage:
    name = "cloudflare"
    paid = False  # Workers AI Free Allocation: 10.000 Neurons/Tag

    def __init__(self, account_id: str | None, token: str | None, models: list[str] | str):
        self.account_id = account_id
        self.token = token
        self.models = [models] if isinstance(models, str) else list(models)

    def available(self) -> bool:
        return bool(self.account_id and self.token)

    def _decode(self, r) -> Image.Image:
        ctype = r.headers.get("Content-Type", "")
        if "image" in ctype:
            return _validate_image(r.content, min_side=256)
        data = r.json()
        b64 = (data.get("result") or {}).get("image")
        if not b64:
            raise ImageError(f"Cloudflare lieferte kein Bild: {str(data)[:200]}")
        return _validate_image(base64.b64decode(b64), min_side=256)

    def generate(self, prompt: str, width: int, height: int, seed: int) -> Image.Image:
        last: Exception | None = None
        w16, h16 = min(1920, width // 16 * 16), min(1920, height // 16 * 16)
        for model in self.models:
            url = f"https://api.cloudflare.com/client/v4/accounts/{self.account_id}/ai/run/{model}"
            headers = {"Authorization": f"Bearer {self.token}"}
            try:
                if "flux-2" in model:
                    # FLUX.2 erwartet multipart/form-data und kann Hochformat direkt erzeugen
                    form = {"prompt": (None, prompt[:2000]), "width": (None, str(w16)), "height": (None, str(h16)),
                            "seed": (None, str(seed % 2_147_483_647))}
                    r = request("POST", url, files=form, headers=headers, timeout=180, retries=2)
                    return self._decode(r)
                body = {"prompt": prompt[:2000], "steps": 8, "seed": seed % 2_147_483_647}
                r = request("POST", url, json=body, headers=headers, timeout=180, retries=2)
                img = self._decode(r)
                # quadratisches Bild → mittig auf 9:16 zuschneiden
                iw, ih = img.size
                if iw / ih > width / height:
                    nw = int(ih * width / height)
                    img = img.crop(((iw - nw) // 2, 0, (iw - nw) // 2 + nw, ih))
                return img
            except (HttpError, ImageError, ConnectionError, ValueError) as exc:
                log.warning("Cloudflare-Modell fehlgeschlagen", data={"model": model, "error": str(exc)[:200]})
                last = exc
        raise ImageError(f"Cloudflare fehlgeschlagen: {last}")


def procedural_image(width: int, height: int, seed: int, mood: str = "dark") -> Image.Image:
    """Atmosphärisches Ersatzbild (Nebel, Lichtkegel, Silhouetten-Horizont). Rein lokal, lizenzfrei."""
    rng = np.random.default_rng(seed)
    h, w = height, width
    y = np.linspace(0, 1, h)[:, None]
    x = np.linspace(0, 1, w)[None, :]
    palettes = {
        "dark": ((8, 12, 22), (40, 58, 82)),
        "warm": ((18, 10, 8), (120, 70, 40)),
        "red": ((14, 4, 6), (110, 22, 28)),
        "cold": ((6, 14, 20), (50, 90, 110)),
    }
    lo, hi = palettes.get(mood, palettes["dark"])
    base = np.zeros((h, w, 3), np.float32)
    grad = np.clip(1.2 - y * 1.1, 0, 1)
    for c in range(3):
        base[..., c] = lo[c] + (hi[c] - lo[c]) * grad
    # Nebel: mehrere Oktaven geglättetes Rauschen
    fog = np.zeros((h, w), np.float32)
    for octave, amp in ((8, 0.55), (24, 0.3), (64, 0.15)):
        small = rng.random((max(2, int(octave * h / w)), octave)).astype(np.float32)
        layer = np.asarray(Image.fromarray((small * 255).astype(np.uint8)).resize((w, h), Image.BICUBIC), np.float32) / 255
        fog += layer * amp
    fog = (fog - fog.min()) / (np.ptp(fog) + 1e-6)
    base += (fog * 55.0 * (0.4 + 0.6 * y))[..., None]
    # Lichtkegel
    cx = rng.uniform(0.25, 0.75)
    beam = np.exp(-((x - cx) ** 2) / (0.02 + 0.08 * y)) * np.clip(1 - y * 0.9, 0, 1)
    base += beam[..., None] * np.array([70, 75, 85], np.float32)
    # Silhouette (Horizont mit Bäumen / Häusern)
    horizon = 0.72 + 0.04 * np.sin(np.linspace(0, rng.uniform(6, 14), w) + rng.uniform(0, 6))
    spikes = rng.random(w) ** 12 * 0.12
    spikes = np.convolve(spikes, np.ones(9) / 9, mode="same")
    mask = y > (horizon - spikes)[None, :]
    base[np.broadcast_to(mask, (h, w))] *= 0.12
    # Vignette
    vig = 1 - 0.65 * (((x - 0.5) ** 2) * 2.2 + ((y - 0.5) ** 2) * 1.6)
    base *= np.clip(vig, 0.15, 1)[..., None].astype(np.float32)
    img = Image.fromarray(np.clip(base, 0, 255).astype(np.uint8), "RGB").filter(ImageFilter.GaussianBlur(1.2))
    return img


def build_chain(config: Config, secrets: Secrets) -> list:
    chain = []
    for name in config.images.provider_chain:
        if name == "pollinations":
            p = PollinationsImage(secrets.pollinations_token, config.images.pollinations_model)
        elif name == "cloudflare":
            p = CloudflareImage(secrets.cloudflare_account_id, secrets.cloudflare_api_token, config.images.cloudflare_models)
        else:
            continue
        if p.available():
            chain.append(p)
    return chain


def generate_scene_image(
    chain: list,
    budget: Budget,
    prompt: str,
    out_path: Path,
    width: int,
    height: int,
    seed: int,
    *,
    spacing: float = 4.0,
    mood: str = "dark",
    allow_fallback: bool = True,
) -> dict:
    """Erzeugt ein Szenenbild und speichert es als JPEG. Gibt Metadaten (Anbieter, Fallback) zurück."""
    errors: list[str] = []
    for provider in chain:
        if provider.name in _BLOCKED:
            errors.append(f"{provider.name}: gesperrt ({_BLOCKED[provider.name]})")
            continue
        for attempt in range(2):
            try:
                budget.check("image", paid=provider.paid)
                budget.record("image", provider.name)
                img = provider.generate(prompt, width, height, seed + attempt * 7919)
                out_path.parent.mkdir(parents=True, exist_ok=True)
                img.save(out_path, "JPEG", quality=94)
                time.sleep(spacing)
                return {"provider": provider.name, "fallback": False, "size": list(img.size)}
            except Exception as exc:  # noqa: BLE001
                if exc.__class__.__name__ in ("BudgetExceeded", "PaidProviderBlocked"):
                    errors.append(f"{provider.name}: {exc}")
                    break
                errors.append(f"{provider.name}#{attempt + 1}: {str(exc)[:160]}")
                if re.search(r"HTTP 40[123]", str(exc)):
                    _BLOCKED[provider.name] = "Zugang verweigert (401/402/403) — Token/Konto nötig"
                    log.warning("Bildanbieter für diesen Lauf deaktiviert", data={"provider": provider.name})
                    break
                log.warning("Bildgenerierung fehlgeschlagen", data={"provider": provider.name, "attempt": attempt + 1, "error": str(exc)[:200]})
                time.sleep(spacing * (attempt + 2))
    if not allow_fallback:
        raise ImageError("Kein Bildanbieter erfolgreich: " + " | ".join(errors))
    img = procedural_image(width, height, seed, mood)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    img.save(out_path, "JPEG", quality=94)
    log.warning("Prozedurales Ersatzbild verwendet", data={"errors": errors[-3:]})
    return {"provider": "procedural", "fallback": True, "size": list(img.size), "errors": errors[-3:]}
