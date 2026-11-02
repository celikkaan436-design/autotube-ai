import type { Db } from '../db/database.js';

/** Kleine Schlüssel/Wert-Ablage für Betriebszustand (Heartbeat, Befehls-Hash …). */
export class BotState {
  constructor(private readonly db: Db) {}

  get(key: string): string | undefined {
    return this.db.prepare<[string], { value: string }>('SELECT value FROM bot_state WHERE key = ?').get(key)?.value;
  }

  getNumber(key: string): number | undefined {
    const v = this.get(key);
    if (v === undefined) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }

  set(key: string, value: string | number, now = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO bot_state (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, String(value), now);
  }
}
