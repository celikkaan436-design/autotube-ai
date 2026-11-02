import type { Db } from '../db/database.js';
import type { RoleDirectory } from '../domain/permissions.js';
import type { CategoryKey, ChannelKey, RoleKey } from '../setup/blueprint.js';

export type ResourceKind = 'role' | 'category' | 'text' | 'voice' | 'panel' | 'automod';

export interface ResourceRow {
  guild_id: string;
  key: string;
  kind: ResourceKind;
  discord_id: string | null;
  channel_id: string | null;
  content_hash: string | null;
  status: 'in_progress' | 'done' | 'failed';
  adopted: number;
  managed_by_discord: number;
  attempt_started_at: number | null;
  last_error: string | null;
  updated_at: number;
}

export const roleResKey = (k: RoleKey) => `role:${k}`;
export const categoryResKey = (k: CategoryKey | string) => `category:${k}`;
export const channelResKey = (k: ChannelKey) => `channel:${k}`;
export const panelResKey = (k: string) => `panel:${k}`;
export const automodResKey = (k: string) => `automod:${k}`;

/**
 * Zugriff auf die beim Setup angelegten Ressourcen. Der Bot findet Rollen und
 * Kanäle ausschließlich über diese gespeicherten IDs – nicht über Namen.
 */
export class ResourceRegistry {
  constructor(
    private readonly db: Db,
    private readonly guildId: string,
  ) {}

  get(key: string): ResourceRow | undefined {
    return this.db
      .prepare<[string, string], ResourceRow>('SELECT * FROM setup_resources WHERE guild_id = ? AND key = ?')
      .get(this.guildId, key);
  }

  /** ID einer erfolgreich angelegten Ressource. */
  id(key: string): string | undefined {
    const row = this.get(key);
    return row && row.status === 'done' && row.discord_id ? row.discord_id : undefined;
  }

  roleId(k: RoleKey): string | undefined {
    return this.id(roleResKey(k));
  }

  channelId(k: ChannelKey): string | undefined {
    return this.id(channelResKey(k));
  }

  categoryId(k: CategoryKey | string): string | undefined {
    return this.id(categoryResKey(k));
  }

  roleDirectory(): RoleDirectory {
    return {
      founder: this.roleId('founder'),
      admin: this.roleId('admin'),
      support: this.roleId('support'),
      operator: this.roleId('operator'),
    };
  }

  all(): ResourceRow[] {
    return this.db
      .prepare<[string], ResourceRow>('SELECT * FROM setup_resources WHERE guild_id = ? ORDER BY key')
      .all(this.guildId);
  }

  byPrefix(prefix: string): ResourceRow[] {
    return this.db
      .prepare<[string, string], ResourceRow>(
        "SELECT * FROM setup_resources WHERE guild_id = ? AND key LIKE ? ESCAPE '\\' ORDER BY key",
      )
      .all(this.guildId, `${prefix.replace(/[%_\\]/g, (m) => `\\${m}`)}%`);
  }

  /** Discord-ID gehört zu einer vom Bot verwalteten Ressource? */
  findByDiscordId(discordId: string): ResourceRow | undefined {
    return this.db
      .prepare<[string, string], ResourceRow>('SELECT * FROM setup_resources WHERE guild_id = ? AND discord_id = ?')
      .get(this.guildId, discordId);
  }

  markInProgress(key: string, kind: ResourceKind, now: number): void {
    this.db
      .prepare(
        `INSERT INTO setup_resources (guild_id, key, kind, status, attempt_started_at, updated_at)
         VALUES (?, ?, ?, 'in_progress', ?, ?)
         ON CONFLICT(guild_id, key) DO UPDATE SET status = 'in_progress', kind = excluded.kind,
           attempt_started_at = excluded.attempt_started_at, last_error = NULL, updated_at = excluded.updated_at,
           discord_id = CASE WHEN setup_resources.status = 'done' THEN setup_resources.discord_id ELSE NULL END`,
      )
      .run(this.guildId, key, kind, now, now);
  }

  markDone(
    key: string,
    kind: ResourceKind,
    discordId: string,
    now: number,
    extra: { channelId?: string | null; contentHash?: string | null; adopted?: boolean; managedByDiscord?: boolean } = {},
  ): void {
    this.db
      .prepare(
        `INSERT INTO setup_resources (guild_id, key, kind, discord_id, channel_id, content_hash, status, adopted, managed_by_discord, updated_at)
         VALUES (@g, @key, @kind, @id, @ch, @hash, 'done', @adopted, @managed, @now)
         ON CONFLICT(guild_id, key) DO UPDATE SET kind = @kind, discord_id = @id, channel_id = @ch, content_hash = @hash,
           status = 'done', adopted = @adopted, managed_by_discord = @managed, last_error = NULL, updated_at = @now`,
      )
      .run({
        g: this.guildId,
        key,
        kind,
        id: discordId,
        ch: extra.channelId ?? null,
        hash: extra.contentHash ?? null,
        adopted: extra.adopted ? 1 : 0,
        managed: extra.managedByDiscord ? 1 : 0,
        now,
      });
  }

  markFailed(key: string, kind: ResourceKind, error: string, now: number): void {
    this.db
      .prepare(
        `INSERT INTO setup_resources (guild_id, key, kind, status, last_error, updated_at)
         VALUES (?, ?, ?, 'failed', ?, ?)
         ON CONFLICT(guild_id, key) DO UPDATE SET status = CASE WHEN setup_resources.discord_id IS NOT NULL AND setup_resources.status = 'done' THEN 'done' ELSE 'failed' END,
           last_error = excluded.last_error, updated_at = excluded.updated_at`,
      )
      .run(this.guildId, key, kind, error.slice(0, 500), now);
  }

  updateHash(key: string, contentHash: string, now: number): void {
    this.db
      .prepare('UPDATE setup_resources SET content_hash = ?, updated_at = ? WHERE guild_id = ? AND key = ?')
      .run(contentHash, now, this.guildId, key);
  }

  /** Vergisst eine Ressource (z. B. wenn sie in Discord gelöscht wurde). */
  forget(key: string): void {
    this.db.prepare('DELETE FROM setup_resources WHERE guild_id = ? AND key = ?').run(this.guildId, key);
  }
}
