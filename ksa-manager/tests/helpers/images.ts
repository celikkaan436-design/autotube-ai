import { crc32, deflateSync } from 'node:zlib';

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** Gültiges 2x2-PNG mit Text-Metadaten (tEXt/iTXt/eXIf/tIME) und Daten nach IEND. */
export function makePng(seed = 1, withMeta = true): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0);
  ihdr.writeUInt32BE(2, 4);
  ihdr[8] = 8; // Bittiefe
  ihdr[9] = 2; // RGB
  const raw = Buffer.from([0, seed, 0, 0, 0, 255, 0, 0, 0, 0, 0, 255, 255, 255, 255]);
  const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', ihdr), pngChunk('sRGB', Buffer.from([0]))];
  if (withMeta) {
    parts.push(pngChunk('tEXt', Buffer.from('Author\u0000max.mustermann@example.com', 'latin1')));
    parts.push(pngChunk('tIME', Buffer.from([7, 234, 11, 2, 12, 0, 0])));
    parts.push(pngChunk('eXIf', Buffer.from('MM\u0000*\u0000\u0000\u0000\u0008GPS', 'latin1')));
  }
  parts.push(pngChunk('IDAT', deflateSync(raw)));
  if (withMeta) parts.push(pngChunk('iTXt', Buffer.from('Comment\u0000\u0000\u0000\u0000\u0000geheim', 'latin1')));
  parts.push(pngChunk('IEND', Buffer.alloc(0)));
  if (withMeta) parts.push(Buffer.from('ANGEHÄNGTE-DATEN-NACH-IEND'));
  return Buffer.concat(parts);
}

function seg(marker: number, data: Buffer): Buffer {
  const h = Buffer.alloc(4);
  h[0] = 0xff;
  h[1] = marker;
  h.writeUInt16BE(data.length + 2, 2);
  return Buffer.concat([h, data]);
}

function exifWithOrientation(orientation: number): Buffer {
  const tiff = Buffer.alloc(8 + 2 + 24 + 4 + 16);
  tiff.write('II', 0, 'latin1');
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(2, 8);
  // Eintrag 1: Make (ASCII) – soll entfernt werden
  tiff.writeUInt16LE(0x010f, 10);
  tiff.writeUInt16LE(2, 12);
  tiff.writeUInt32LE(4, 14);
  tiff.write('Cam', 18, 'latin1');
  // Eintrag 2: Orientation
  tiff.writeUInt16LE(0x0112, 22);
  tiff.writeUInt16LE(3, 24);
  tiff.writeUInt32LE(1, 26);
  tiff.writeUInt16LE(orientation, 30);
  tiff.writeUInt32LE(0, 34);
  tiff.write('GPS-POSITION-XYZ', 38, 'latin1');
  return Buffer.concat([Buffer.from('Exif\u0000\u0000', 'latin1'), tiff]);
}

/** Strukturell gültiges JPEG mit EXIF (inkl. Ausrichtung), XMP, Kommentar und Daten nach EOI. */
export function makeJpeg(seed = 1, orientation = 6): Buffer {
  const jfif = Buffer.from([0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const xmp = Buffer.from('http://ns.adobe.com/xap/1.0/\u0000<x:xmpmeta>Autor: Max</x:xmpmeta>', 'latin1');
  const icc = Buffer.concat([Buffer.from('ICC_PROFILE\u0000', 'latin1'), Buffer.from([1, 1, 0, 0, 0, 0])]);
  const dqt = Buffer.concat([Buffer.from([0]), Buffer.alloc(64, seed)]);
  const sof = Buffer.from([8, 0, 1, 0, 1, 1, 1, 0x11, 0]);
  const dht = Buffer.concat([Buffer.from([0]), Buffer.alloc(16, 0), Buffer.alloc(0)]);
  const sos = Buffer.from([1, 1, 0, 0, 63, 0]);
  const entropy = Buffer.from([seed, 0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56, 0x78]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    seg(0xe0, jfif),
    seg(0xe1, exifWithOrientation(orientation)),
    seg(0xe1, xmp),
    seg(0xe2, icc),
    seg(0xfe, Buffer.from('Kommentar mit Namen', 'latin1')),
    seg(0xdb, dqt),
    seg(0xc0, sof),
    seg(0xc4, dht),
    seg(0xda, sos),
    entropy,
    Buffer.from([0xff, 0xd9]),
    Buffer.from('TRAILER-METADATEN'),
  ]);
}

function riffChunk(fourcc: string, data: Buffer): Buffer {
  const h = Buffer.alloc(8);
  h.write(fourcc, 0, 'latin1');
  h.writeUInt32LE(data.length, 4);
  return Buffer.concat([h, data, data.length % 2 ? Buffer.from([0]) : Buffer.alloc(0)]);
}

/** WebP (VP8X + VP8L) mit EXIF- und XMP-Chunk. */
export function makeWebp(seed = 1): Buffer {
  const vp8x = Buffer.alloc(10);
  vp8x[0] = 0x08 | 0x04; // EXIF + XMP
  const body = Buffer.concat([
    riffChunk('VP8X', vp8x),
    riffChunk('VP8L', Buffer.from([0x2f, seed, 0, 0, 0, 0x10, 0x07, 0x10, 0x11])),
    riffChunk('EXIF', Buffer.from('MM\u0000*GPS-DATEN', 'latin1')),
    riffChunk('XMP ', Buffer.from('<x:xmpmeta>Autor</x:xmpmeta>', 'latin1')),
  ]);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(body.length + 4, 4);
  header.write('WEBP', 8, 'latin1');
  return Buffer.concat([header, body]);
}
