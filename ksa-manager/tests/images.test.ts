import { describe, expect, it } from 'vitest';
import { detectImageType, ImageError, sanitizeImage, stripJpeg, stripPng, stripWebp } from '../src/services/images.js';
import { makeJpeg, makePng, makeWebp } from './helpers/images.js';

describe('Dateisignaturen', () => {
  it('erkennt Formate an der tatsächlichen Signatur', () => {
    expect(detectImageType(makePng())).toBe('png');
    expect(detectImageType(makeJpeg())).toBe('jpeg');
    expect(detectImageType(makeWebp())).toBe('webp');
    expect(detectImageType(Buffer.from('GIF89a....'))).toBeNull();
    expect(detectImageType(Buffer.from('<svg></svg>'))).toBeNull();
  });
  it('weist falsch deklarierte und unbekannte Dateien zurück', () => {
    expect(() => sanitizeImage(makePng(), 'image/jpeg')).toThrow(ImageError);
    expect(() => sanitizeImage(Buffer.from('MZ\u0090\u0000ausfuehrbar'), 'image/png')).toThrow(/Nicht unterstütztes/);
    expect(() => sanitizeImage(makePng().subarray(0, 40), 'image/png')).toThrow(ImageError);
  });
});

describe('Metadaten-Entfernung', () => {
  it('PNG: entfernt Text-/EXIF-/Zeitchunks und Daten nach IEND, behält Bilddaten', () => {
    const input = makePng(7);
    const out = stripPng(input);
    const s = out.toString('latin1');
    expect(s).not.toContain('tEXt');
    expect(s).not.toContain('iTXt');
    expect(s).not.toContain('eXIf');
    expect(s).not.toContain('tIME');
    expect(s).not.toContain('example.com');
    expect(s).not.toContain('ANGEH');
    expect(s).toContain('IHDR');
    expect(s).toContain('IDAT');
    expect(s).toContain('sRGB');
    expect(out.subarray(out.length - 12, out.length - 8).readUInt32BE(0)).toBe(0); // IEND-Länge
    expect(stripPng(out).equals(out)).toBe(true); // idempotent
  });
  it('JPEG: entfernt EXIF/XMP/Kommentar/Trailer, behält ICC und nur die Ausrichtung', () => {
    const out = stripJpeg(makeJpeg(3, 6));
    const s = out.toString('latin1');
    expect(s).not.toContain('GPS');
    expect(s).not.toContain('Cam');
    expect(s).not.toContain('xmpmeta');
    expect(s).not.toContain('Kommentar');
    expect(s).not.toContain('TRAILER');
    expect(s).toContain('ICC_PROFILE');
    expect(s).toContain('Exif');
    expect(out[out.length - 2]).toBe(0xff);
    expect(out[out.length - 1]).toBe(0xd9);
    // Ausrichtung 6 bleibt in einem minimalen EXIF-Segment erhalten
    const idx = out.indexOf(Buffer.from('Exif\u0000\u0000', 'latin1'));
    expect(out.readUInt16BE(idx + 6 + 18)).toBe(6);
  });
  it('JPEG ohne abweichende Ausrichtung enthält gar kein EXIF mehr', () => {
    const out = stripJpeg(makeJpeg(3, 1));
    expect(out.toString('latin1')).not.toContain('Exif');
  });
  it('WebP: entfernt EXIF/XMP und löscht die Flags', () => {
    const out = stripWebp(makeWebp(2));
    const s = out.toString('latin1');
    expect(s).not.toContain('EXIF');
    expect(s).not.toContain('XMP ');
    expect(s).toContain('VP8L');
    expect(out.readUInt32LE(4)).toBe(out.length - 8);
    const vp8x = out.indexOf(Buffer.from('VP8X'));
    expect(out[vp8x + 8]! & 0x0c).toBe(0);
  });
  it('sanitizeImage liefert passenden Typ und Endung', () => {
    expect(sanitizeImage(makePng(), 'image/png')).toMatchObject({ type: 'png', ext: 'png', contentType: 'image/png' });
    expect(sanitizeImage(makeJpeg(), 'image/jpeg')).toMatchObject({ type: 'jpeg', ext: 'jpg' });
    expect(sanitizeImage(makeWebp(), null)).toMatchObject({ type: 'webp', ext: 'webp' });
  });
});
