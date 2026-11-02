import { createHash, randomBytes } from 'node:crypto';

/** Deterministisches JSON (sortierte Schlüssel) für Hashes über Inhalte. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortValue(v);
    }
    return out;
  }
  if (typeof value === 'bigint') return value.toString();
  return value;
}

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function hashObject(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

/** Zufälliges, URL-sicheres Token (für Custom-IDs und Nonces). */
export function randomToken(bytes = 12): string {
  return randomBytes(bytes).toString('base64url');
}
