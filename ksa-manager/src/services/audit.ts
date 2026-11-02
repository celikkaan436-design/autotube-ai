import type { APIEmbed } from 'discord.js';
import type { Db } from '../db/database.js';
import type { DiscordPort } from '../discord/port.js';
import { BRAND, COLORS } from '../domain/constants.js';
import { errInfo, type Logger } from '../logging/logger.js';
import type { Clock } from '../util/time.js';
import { truncate } from '../util/text.js';
import type { ResourceRegistry } from './registry.js';

export interface AuditEntry {
  id: number;
  guild_id: string;
  actor_id: string;
  action: string;
  target_type: string | null;
  target_id: string | null;
  details: string | null;
  created_at: number;
}

/**
 * Audit-Protokoll (SQLite) und Team-Log (Discord-Kanal 🧾・team-log).
 * Details enthalten niemals private Nachrichteninhalte oder interne Notiztexte.
 */
export class AuditService {
  constructor(
    private readonly db: Db,
    private readonly guildId: string,
    private readonly clock: Clock,
    private readonly log: Logger,
    private readonly getPort: () => DiscordPort,
    private readonly registry: ResourceRegistry,
  ) {}

  record(actorId: string, action: string, target?: { type: string; id: string | number }, details?: Record<string, unknown>): void {
    this.db
      .prepare(
        'INSERT INTO audit_log (guild_id, actor_id, action, target_type, target_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        this.guildId,
        actorId,
        action,
        target?.type ?? null,
        target ? String(target.id) : null,
        details ? JSON.stringify(details) : null,
        this.clock.now(),
      );
    this.log.info({ audit: action, actorId, targetType: target?.type, targetId: target?.id }, 'audit');
  }

  list(limit = 50, filter?: { targetType?: string; targetId?: string }): AuditEntry[] {
    if (filter?.targetType && filter.targetId) {
      return this.db
        .prepare<[string, string, string, number], AuditEntry>(
          'SELECT * FROM audit_log WHERE guild_id = ? AND target_type = ? AND target_id = ? ORDER BY id DESC LIMIT ?',
        )
        .all(this.guildId, filter.targetType, filter.targetId, limit);
    }
    return this.db
      .prepare<[string, number], AuditEntry>('SELECT * FROM audit_log WHERE guild_id = ? ORDER BY id DESC LIMIT ?')
      .all(this.guildId, limit);
  }

  /** Kurzer Eintrag im Team-Log. Fehler beim Posten werden nur geloggt. */
  async teamLog(title: string, lines: string[], color: number = COLORS.neutral): Promise<void> {
    await this.postTo('teamlog', title, lines, color);
  }

  async botStatus(title: string, lines: string[], color: number = COLORS.neutral): Promise<void> {
    await this.postTo('botstatus', title, lines, color);
  }

  private async postTo(key: 'teamlog' | 'botstatus', title: string, lines: string[], color: number): Promise<void> {
    const channelId = this.registry.channelId(key);
    if (!channelId) return;
    const embed: APIEmbed = {
      title: truncate(title, 256),
      description: truncate(lines.join('\n'), 4000),
      color,
      footer: { text: BRAND },
      timestamp: new Date(this.clock.now()).toISOString(),
    };
    try {
      await this.getPort().sendMessage(channelId, { embeds: [embed] });
    } catch (err) {
      this.log.warn({ err: errInfo(err), channel: key }, 'Team-Log konnte nicht gepostet werden');
    }
  }
}
