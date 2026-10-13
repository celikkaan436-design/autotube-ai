"""Thumbnail (1080x1920 JPEG < 2 MB) aus dem stärksten Szenenbild + großer Schrift."""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont, ImageOps

from .. import paths

W, H = 1080, 1920


def _wrap(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.FreeTypeFont, max_w: int) -> list[str]:
    words, lines, cur = text.split(), [], ""
    for w in words:
        test = f"{cur} {w}".strip()
        if draw.textlength(test, font=font) <= max_w or not cur:
            cur = test
        else:
            lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


def make_thumbnail(image_path: Path, text: str, out_path: Path, accent: tuple[int, int, int] = (255, 214, 10)) -> Path:
    img = Image.open(image_path).convert("RGB")
    img = ImageOps.fit(img, (W, H), Image.LANCZOS)
    img = ImageEnhance.Contrast(img).enhance(1.15)
    img = ImageEnhance.Brightness(img).enhance(0.8)
    # dunkler Verlauf unten für Lesbarkeit
    grad = Image.new("L", (1, H))
    for y in range(H):
        grad.putpixel((0, y), int(max(0, (y - H * 0.45) / (H * 0.55)) * 215))
    shade = Image.new("RGB", (W, H), (0, 0, 0))
    img = Image.composite(shade, img, grad.resize((W, H)))
    draw = ImageDraw.Draw(img)
    text = text.upper()
    size = 150
    while size > 70:
        font = ImageFont.truetype(str(paths.SUBTITLE_FONT_FILE), size)
        lines = _wrap(draw, text, font, W - 140)
        if len(lines) <= 3:
            break
        size -= 10
    y = int(H * 0.62)
    for i, line in enumerate(lines):
        tw = draw.textlength(line, font=font)
        x = (W - tw) / 2
        fill = accent if i == len(lines) - 1 else (255, 255, 255)
        glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        ImageDraw.Draw(glow).text((x, y), line, font=font, fill=(0, 0, 0, 255), stroke_width=18, stroke_fill=(0, 0, 0, 255))
        img.paste(glow.filter(ImageFilter.GaussianBlur(10)), (0, 0), glow.filter(ImageFilter.GaussianBlur(10)))
        draw = ImageDraw.Draw(img)
        draw.text((x, y), line, font=font, fill=fill, stroke_width=8, stroke_fill=(0, 0, 0))
        y += int(size * 1.08)
    quality = 92
    while True:
        img.save(out_path, "JPEG", quality=quality, optimize=True, progressive=True)
        if out_path.stat().st_size < 1_900_000 or quality <= 60:
            break
        quality -= 8
    return out_path
