import type { Db } from '../db/database.js';

/** Persistente Cooldowns (überleben Neustarts). */
export class CooldownService {
  constructor(
    private readonly db: Db,
    private readonly guildId: string,
  ) {}

  /** Restzeit in ms oder 0, wenn kein Cooldown aktiv ist. */
  remaining(userId: string, action: string, now: number): number {
    const row = this.db
      .prepare<[string, string, string], { until: number }>(
        'SELECT until FROM cooldowns WHERE guild_id = ? AND user_id = ? AND action = ?',
      )
      .get(this.guildId, userId, action);
    return row ? Math.max(0, row.until - now) : 0;
  }

  set(userId: string, action: string, until: number): void {
    this.db
      .prepare(
        `INSERT INTO cooldowns (guild_id, user_id, action, until) VALUES (?, ?, ?, ?)
         ON CONFLICT(guild_id, user_id, action) DO UPDATE SET until = excluded.until`,
      )
      .run(this.guildId, userId, action, until);
  }

  clear(userId: string, action: string): void {
    this.db.prepare('DELETE FROM cooldowns WHERE guild_id = ? AND user_id = ? AND action = ?').run(this.guildId, userId, action);
  }

  purgeExpired(now: number): number {
    return this.db.prepare('DELETE FROM cooldowns WHERE until < ?').run(now).changes;
  }
}
