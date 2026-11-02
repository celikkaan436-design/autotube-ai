/**
 * Custom-IDs für dauerhafte Buttons, Menüs und Modals.
 * Format: ksa:<namespace>:<aktion>[:<arg>]*  – maximal 100 Zeichen (Discord-Limit).
 *
 * Custom-IDs sind NICHT vertrauenswürdig: Jeder Handler validiert Server, Kanal,
 * Ticket-Zugehörigkeit, Berechtigung, Version und Hash erneut gegen die Datenbank.
 */

const PREFIX = 'ksa';
const ARG_RE = /^[A-Za-z0-9_-]{1,40}$/;
const MAX_LEN = 100;

export interface ParsedId {
  ns: string;
  action: string;
  args: string[];
}

export function cid(ns: string, action: string, ...args: (string | number)[]): string {
  const parts = [PREFIX, ns, action, ...args.map(String)];
  for (const p of parts.slice(1)) {
    if (!ARG_RE.test(p)) throw new Error(`Ungültiger Custom-ID-Bestandteil: ${p}`);
  }
  const id = parts.join(':');
  if (id.length > MAX_LEN) throw new Error('Custom-ID zu lang');
  return id;
}

export function parseCid(raw: string): ParsedId | null {
  if (raw.length > MAX_LEN) return null;
  const parts = raw.split(':');
  if (parts.length < 3 || parts[0] !== PREFIX) return null;
  const rest = parts.slice(1);
  if (!rest.every((p) => ARG_RE.test(p))) return null;
  const [ns, action, ...args] = rest as [string, string, ...string[]];
  return { ns, action, args };
}

/** Liest ein positives Ganzzahl-Argument; gibt null bei Manipulation/ungültigem Wert. */
export function argInt(p: ParsedId, index: number): number | null {
  const v = p.args[index];
  if (v === undefined || !/^\d{1,12}$/.test(v)) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export function argStr(p: ParsedId, index: number): string | null {
  return p.args[index] ?? null;
}
