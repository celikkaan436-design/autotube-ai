/**
 * Bildprüfung und verlustfreie Metadaten-Entfernung für Proofs – ohne erneute
 * Kompression (keine Qualitätsverluste). Unterstützt PNG, JPEG und WebP.
 *
 * Entfernt: PNG-Text-/EXIF-/Zeitchunks und unbekannte Chunks, JPEG-APP1 (EXIF/XMP),
 * APP3–APP13, APP15, Kommentare, MPF-Daten und Daten nach dem Bildende, WebP-EXIF/XMP.
 * Behalten: Bilddaten, Farbprofile (ICC) und – bei JPEG – nur die Ausrichtung.
 *
 * Wichtig: Das ersetzt NICHT die manuelle Prüfung auf sichtbare persönliche Daten
 * im Bildinhalt (E-Mail-Adressen, Chats, Zugangsdaten …).
 */

export type ImageType = 'png' | 'jpeg' | 'webp';

export const IMAGE_MIME: Record<ImageType, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

export const IMAGE_EXT: Record<ImageType, string> = {
  png: 'png',
  jpeg: 'jpg',
  webp: 'webp',
};

export class ImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageError';
  }
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function detectImageType(buf: Buffer): ImageType | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIG)) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

export function mimeToType(mime: string | null): ImageType | null {
  const m = (mime ?? '').split(';')[0]!.trim().toLowerCase();
  if (m === 'image/png') return 'png';
  if (m === 'image/jpeg' || m === 'image/jpg') return 'jpeg';
  if (m === 'image/webp') return 'webp';
  return null;
}

// ---------------------------------------------------------------- PNG

const PNG_KEEP = new Set([
  'IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'cHRM', 'gAMA', 'iCCP', 'sBIT', 'sRGB',
  'cICP', 'mDCV', 'cLLI', 'bKGD', 'hIST', 'pHYs', 'sPLT', 'acTL', 'fcTL', 'fdAT',
]);

export function stripPng(buf: Buffer): Buffer {
  if (!buf.subarray(0, 8).equals(PNG_SIG)) throw new ImageError('Keine gültige PNG-Datei');
  const parts: Buffer[] = [PNG_SIG];
  let pos = 8;
  let first = true;
  let sawEnd = false;
  let sawData = false;
  while (pos + 12 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const end = pos + 12 + len;
    if (len > 0x7fffffff || end > buf.length) throw new ImageError('PNG-Chunk beschädigt');
    if (!/^[A-Za-z]{4}$/.test(type)) throw new ImageError('PNG-Chunktyp ungültig');
    if (first && type !== 'IHDR') throw new ImageError('PNG beginnt nicht mit IHDR');
    first = false;
    if (PNG_KEEP.has(type)) parts.push(buf.subarray(pos, end));
    if (type === 'IDAT') sawData = true;
    pos = end;
    if (type === 'IEND') {
      sawEnd = true;
      break; // Daten nach IEND werden verworfen
    }
  }
  if (!sawEnd || !sawData) throw new ImageError('PNG unvollständig');
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- JPEG

function readExifOrientation(seg: Buffer): number | null {
  // seg = Segmentdaten ohne Marker/Länge
  if (seg.length < 14 || seg.toString('latin1', 0, 6) !== 'Exif\u0000\u0000') return null;
  const tiff = seg.subarray(6);
  const order = tiff.toString('latin1', 0, 2);
  const le = order === 'II';
  if (!le && order !== 'MM') return null;
  const u16 = (o: number) => (o + 2 <= tiff.length ? (le ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o)) : -1);
  const u32 = (o: number) => (o + 4 <= tiff.length ? (le ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o)) : -1);
  if (u16(2) !== 42) return null;
  const ifd = u32(4);
  if (ifd < 8 || ifd + 2 > tiff.length) return null;
  const count = u16(ifd);
  for (let i = 0; i < count && i < 512; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > tiff.length) break;
    if (u16(e) === 0x0112) {
      const v = u16(e + 8);
      return v >= 1 && v <= 8 ? v : null;
    }
  }
  return null;
}

/** Minimales EXIF-Segment, das ausschließlich die Ausrichtung enthält. */
export function minimalOrientationApp1(orientation: number): Buffer {
  const tiff = Buffer.alloc(26);
  tiff.write('MM', 0, 'latin1');
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(8, 4);
  tiff.writeUInt16BE(1, 8); // 1 Eintrag
  tiff.writeUInt16BE(0x0112, 10); // Orientation
  tiff.writeUInt16BE(3, 12); // SHORT
  tiff.writeUInt32BE(1, 14); // Anzahl
  tiff.writeUInt16BE(orientation, 18);
  tiff.writeUInt32BE(0, 22); // kein weiteres IFD
  const payload = Buffer.concat([Buffer.from('Exif\u0000\u0000', 'latin1'), tiff]);
  const header = Buffer.alloc(4);
  header[0] = 0xff;
  header[1] = 0xe1;
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([header, payload]);
}

function keepJpegSegment(marker: number, data: Buffer): boolean {
  if (marker === 0xfe) return false; // COM
  if (marker >= 0xe0 && marker <= 0xef) {
    const n = marker - 0xe0;
    if (n === 0) return true; // JFIF/JFXX
    if (n === 2) return data.toString('latin1', 0, 12) === 'ICC_PROFILE\u0000'; // nur ICC, kein MPF/FlashPix
    if (n === 14) return data.toString('latin1', 0, 5) === 'Adobe'; // Farbtransformation
    return false; // APP1 (EXIF/XMP), APP3–13, APP15
  }
  return true;
}

export function stripJpeg(buf: Buffer): Buffer {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) throw new ImageError('Keine gültige JPEG-Datei');
  const out: Buffer[] = [buf.subarray(0, 2)];
  let pos = 2;
  let orientation: number | null = null;
  let insertedOrientation = false;
  let sawFrame = false;
  let sawScan = false;
  const pushOrientationOnce = () => {
    if (!insertedOrientation && orientation !== null && orientation !== 1) {
      out.push(minimalOrientationApp1(orientation));
    }
    insertedOrientation = true;
  };

  while (pos < buf.length) {
    if (buf[pos] !== 0xff) throw new ImageError('JPEG-Struktur beschädigt');
    while (pos < buf.length && buf[pos] === 0xff) pos++; // Füllbytes
    if (pos >= buf.length) break;
    const marker = buf[pos]!;
    pos++;
    if (marker === 0xd9) {
      out.push(Buffer.from([0xff, 0xd9]));
      if (!sawFrame || !sawScan) throw new ImageError('JPEG unvollständig');
      return Buffer.concat(out); // Daten nach EOI werden verworfen
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      out.push(Buffer.from([0xff, marker]));
      continue;
    }
    if (pos + 2 > buf.length) throw new ImageError('JPEG-Segment beschädigt');
    const len = buf.readUInt16BE(pos);
    if (len < 2 || pos + len > buf.length) throw new ImageError('JPEG-Segmentlänge ungültig');
    const data = buf.subarray(pos + 2, pos + len);
    const segment = buf.subarray(pos - 2, pos + len);
    pos += len;

    if (marker === 0xe1 && orientation === null) orientation = readExifOrientation(data);
    const isApp0 = marker === 0xe0;
    if (!isApp0 && !(marker >= 0xe0 && marker <= 0xef)) pushOrientationOnce();
    if (keepJpegSegment(marker, data)) out.push(segment);
    if ((marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)) sawFrame = true;

    if (marker === 0xda) {
      sawScan = true;
      // Entropiecodierte Daten bis zum nächsten echten Marker kopieren.
      const start = pos;
      while (pos < buf.length) {
        if (buf[pos] === 0xff) {
          const next = buf[pos + 1];
          if (next === undefined) break;
          if (next === 0x00 || (next >= 0xd0 && next <= 0xd7) || next === 0xff) {
            pos += next === 0xff ? 1 : 2;
            continue;
          }
          break;
        }
        pos++;
      }
      out.push(buf.subarray(start, pos));
    }
  }
  throw new ImageError('JPEG ohne Bildende (EOI)');
}

// ---------------------------------------------------------------- WebP

export function stripWebp(buf: Buffer): Buffer {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') {
    throw new ImageError('Keine gültige WebP-Datei');
  }
  const riffSize = buf.readUInt32LE(4);
  const end = Math.min(buf.length, 8 + riffSize);
  const chunks: Buffer[] = [];
  let pos = 12;
  let sawImage = false;
  while (pos + 8 <= end) {
    const fourcc = buf.toString('latin1', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const padded = size + (size % 2);
    const chunkEnd = pos + 8 + padded;
    if (chunkEnd > end + (size % 2)) throw new ImageError('WebP-Chunk beschädigt');
    let chunk = Buffer.from(buf.subarray(pos, Math.min(chunkEnd, buf.length)));
    if (chunk.length < 8 + padded) chunk = Buffer.concat([chunk, Buffer.alloc(8 + padded - chunk.length)]);
    if (fourcc === 'VP8 ' || fourcc === 'VP8L' || fourcc === 'ANMF') sawImage = true;
    if (fourcc === 'VP8X' && chunk.length >= 9) {
      chunk[8] = chunk[8]! & ~0x08 & ~0x04; // EXIF- und XMP-Flag löschen
    }
    if (fourcc !== 'EXIF' && fourcc !== 'XMP ') chunks.push(chunk);
    pos = chunkEnd;
  }
  if (!sawImage) throw new ImageError('WebP ohne Bilddaten');
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(body.length + 4, 4);
  header.write('WEBP', 8, 'ascii');
  return Buffer.concat([header, body]);
}

export interface SanitizedImage {
  type: ImageType;
  data: Buffer;
  contentType: string;
  ext: string;
}

/**
 * Prüft die tatsächliche Dateisignatur gegen den angegebenen Typ und entfernt Metadaten.
 * Wirft ImageError bei unbekannten, beschädigten oder falsch deklarierten Dateien.
 */
export function sanitizeImage(buf: Buffer, declaredMime: string | null): SanitizedImage {
  const detected = detectImageType(buf);
  if (!detected) throw new ImageError('Nicht unterstütztes Dateiformat (erlaubt: PNG, JPEG, WebP)');
  const declared = mimeToType(declaredMime);
  if (declared !== null && declared !== detected) throw new ImageError('Dateityp passt nicht zur tatsächlichen Dateisignatur');
  const data = detected === 'png' ? stripPng(buf) : detected === 'jpeg' ? stripJpeg(buf) : stripWebp(buf);
  if (detectImageType(data) !== detected) throw new ImageError('Bild nach der Bereinigung ungültig');
  return { type: detected, data, contentType: IMAGE_MIME[detected], ext: IMAGE_EXT[detected] };
}
