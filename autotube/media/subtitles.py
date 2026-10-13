"""Wortgenaue, animierte Untertitel (ASS/libass) inkl. Überlauf-Prüfung."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from PIL import ImageFont

from .. import paths
from ..providers.tts import Word

W, H = 1080, 1920
SAFE_MARGIN = 80                 # links/rechts
MAX_TEXT_WIDTH = W - 2 * SAFE_MARGIN
BASE_SIZE = 84
ACTIVE_SCALE = 1.12
MAX_WORDS = 3
MAX_CHARS = 22
CAPTION_Y = 1190                 # über der Shorts-UI, unter der Bildmitte
ACCENT = "&H000AD6FF&"           # #FFD60A (ASS: &HAABBGGRR)
WHITE = "&H00FFFFFF&"


@dataclass
class Chunk:
    words: list[Word]
    size: int = BASE_SIZE

    @property
    def start(self) -> float:
        return self.words[0].start

    @property
    def end(self) -> float:
        return self.words[-1].end

    @property
    def text(self) -> str:
        return " ".join(w.text for w in self.words)


def _font(size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(paths.SUBTITLE_FONT_FILE), size)


def text_width(text: str, size: int, scale: float = 1.0) -> float:
    return _font(size).getlength(text) * scale


def _chunk_width(c: Chunk) -> float:
    # Breite, wenn das breiteste Wort aktiv (vergrößert) ist
    base = text_width(c.text, c.size)
    widest = max(text_width(w.text, c.size) for w in c.words)
    return base + widest * (ACTIVE_SCALE - 1)


def make_chunks(words: list[Word]) -> list[Chunk]:
    chunks: list[Chunk] = []
    cur: list[Word] = []
    for i, w in enumerate(words):
        cur.append(w)
        nxt = words[i + 1] if i + 1 < len(words) else None
        chars = len(" ".join(x.text for x in cur))
        brk = (
            nxt is None
            or len(cur) >= MAX_WORDS
            or w.text[-1:] in ".!?…:;,–"
            or (nxt.start - w.end) > 0.35
            or chars + 1 + len(nxt.text) > MAX_CHARS
        )
        if brk:
            chunks.append(Chunk(cur))
            cur = []
    # Überlauf beheben: aufteilen, bei Einzelwörtern Schrift verkleinern
    fixed: list[Chunk] = []
    queue = list(chunks)
    while queue:
        c = queue.pop(0)
        if _chunk_width(c) <= MAX_TEXT_WIDTH:
            fixed.append(c)
        elif len(c.words) > 1:
            mid = len(c.words) // 2
            queue[0:0] = [Chunk(c.words[:mid], c.size), Chunk(c.words[mid:], c.size)]
        else:
            size = c.size
            while size > 60 and _chunk_width(Chunk(c.words, size)) > MAX_TEXT_WIDTH:
                size -= 4
            if _chunk_width(Chunk(c.words, size)) <= MAX_TEXT_WIDTH:
                fixed.append(Chunk(c.words, size))
                continue
            # Extrem lange Komposita trennen: „Überwachungskamera-“ + „aufzeichnung“
            w = c.words[0]
            text = w.text
            cut = len(text) // 2
            mid_t = w.start + (w.end - w.start) * cut / len(text)
            queue[0:0] = [Chunk([Word(text[:cut] + "-", w.start, mid_t)], c.size),
                          Chunk([Word(text[cut:], mid_t, w.end)], c.size)]
    return fixed


def _ts(t: float) -> str:
    t = max(0.0, t)
    h = int(t // 3600)
    m = int(t % 3600 // 60)
    s = t % 60
    return f"{h}:{m:02d}:{s:05.2f}"


def _esc(text: str) -> str:
    return text.replace("\\", "").replace("{", "(").replace("}", ")")


def _wrap_title(title: str, size: int, max_w: int) -> str:
    font = ImageFont.truetype(str(paths.TITLE_FONT_FILE), size)
    words, lines, cur = title.split(), [], ""
    for w in words:
        test = f"{cur} {w}".strip()
        if font.getlength(test) <= max_w or not cur:
            cur = test
        else:
            lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return "\\N".join(_esc(x) for x in lines[:3])


def build_ass(words: list[Word], total: float, title: str | None = None) -> tuple[str, dict]:
    chunks = make_chunks(words)
    header = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {W}
PlayResY: {H}
WrapStyle: 2
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,{paths.SUBTITLE_FONT_NAME},{BASE_SIZE},&H00FFFFFF,&H00FFFFFF,&H00000000,&H96000000,-1,0,0,0,100,100,0,0,1,7,3,5,{SAFE_MARGIN},{SAFE_MARGIN},0,1
Style: Title,Gloock,88,&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,0,0,0,0,100,100,1,0,1,4,2,8,90,90,250,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    lines: list[str] = []
    if title:
        wrapped = _wrap_title(title, 88, W - 180)
        lines.append(f"Dialogue: 1,{_ts(0.0)},{_ts(2.9)},Title,,0,0,0,,{{\\fad(150,450)}}{wrapped}")
    report = {"chunks": len(chunks), "max_width": 0.0, "limit": MAX_TEXT_WIDTH, "overflow": [], "reduced_size": 0}
    for ci, c in enumerate(chunks):
        nxt_start = chunks[ci + 1].start if ci + 1 < len(chunks) else total
        chunk_end = min(nxt_start, c.end + 0.45)
        width = _chunk_width(c)
        report["max_width"] = max(report["max_width"], round(width, 1))
        if width > MAX_TEXT_WIDTH:
            report["overflow"].append(c.text)
        if c.size != BASE_SIZE:
            report["reduced_size"] += 1
        for wi, w in enumerate(c.words):
            start = c.start if wi == 0 else w.start
            end = c.words[wi + 1].start if wi + 1 < len(c.words) else chunk_end
            if end - start < 0.04:
                continue
            parts = []
            for wj, x in enumerate(c.words):
                if wj == wi:
                    parts.append(f"{{\\c{ACCENT}\\fscx{int(ACTIVE_SCALE * 100)}\\fscy{int(ACTIVE_SCALE * 100)}}}{_esc(x.text)}{{\\c{WHITE}\\fscx100\\fscy100}}")
                else:
                    parts.append(_esc(x.text))
            pop = "\\fscx92\\fscy92\\t(0,90,\\fscx100\\fscy100)" if wi == 0 else ""
            size = f"\\fs{c.size}" if c.size != BASE_SIZE else ""
            lines.append(f"Dialogue: 0,{_ts(start)},{_ts(end)},Caption,,0,0,0,,{{\\pos({W // 2},{CAPTION_Y}){pop}{size}}}" + " ".join(parts))
    return header + "\n".join(lines) + "\n", report


def write_ass(path: Path, words: list[Word], total: float, title: str | None = None) -> dict:
    content, report = build_ass(words, total, title)
    path.write_text(content, encoding="utf-8")
    return report
