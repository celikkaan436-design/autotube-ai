import { embed } from '../discord/ui.js';
import type { MemberInfo } from '../discord/port.js';
import { COLORS } from '../domain/constants.js';
import { assertAllowed, type Actor } from '../domain/permissions.js';
import { errInfo } from '../logging/logger.js';
import { UserError } from '../util/errors.js';
import { MINUTE } from '../util/time.js';
import { authConfig, type AppContext } from './context.js';

/**
 * Discord-Serverboost-Erkennung – ausdrücklich getrennt von Ranked-Aufträgen.
 *
 * Quellen (laut Discord-Doku):
 *  1. Systemnachrichten vom Typ GUILD_BOOST (8) bzw. GUILD_BOOST_TIER_1–3 (9–11) im
 *     Systemkanal – je Boost eine Nachricht, sofern in den Servereinstellungen aktiviert.
 *  2. GUILD_MEMBER_UPDATE mit premium_since (Beginn des Boost-Status). Ein zusätzlicher
 *     Boost derselben Person ändert premium_since NICHT – nur Quelle 1 erkennt ihn.
 *
 * Deduplizierung: jedes Ereignis hat einen eindeutigen Schlüssel (UNIQUE in SQLite),
 * Ereignisse derselben Person innerhalb eines Korrelationsfensters werden zu einer
 * Danksagung zusammengeführt. Nach Neustarts gibt es keine Danksagungen für
 * Vergangenes: Der Startabgleich speichert den Ist-Zustand stillschweigend und meldet
 * während der Offline-Zeit begonnene Boosts nur intern in ⚙️・bot-status.
 */

export const CORRELATION_WINDOW_MS = 10 * MINUTE;
export const FRESHNESS_MS = 15 * MINUTE;
export const MEMBER_UPDATE_DELAY_MS = 20_000;

export interface BoostEventRow {
  id: number;
  guild_id: string;
  user_id: string;
  source: 'system_message' | 'member_update';
  source_key: string;
  occurred_at: number;
  status: 'pending' | 'thanked' | 'merged' | 'stale' | 'failed' | 'disabled';
  due_at: number;
  merged_into: number | null;
  thank_message_id: string | null;
  last_error: string | null;
  created_at: number;
  processed_at: number | null;
}

interface StateRow {
  guild_id: string;
  user_id: string;
  premium_since: number | null;
  updated_at: number;
}

export interface BaselineReport {
  members: number;
  boosting: number;
  startedWhileOffline: string[];
  endedWhileOffline: string[];
  roleAdded: number;
  roleRemoved: number;
}

export const BOOST_MESSAGE_TYPES = new Set([8, 9, 10, 11]);

export class BoostService {
  private timer: NodeJS.Timeout | null = null;
  baselineDone = false;
  lastBaseline: BaselineReport | null = null;

  constructor(private readonly ctx: AppContext) {}

  private get guildId() {
    return this.ctx.config.guildId;
  }

  private state(userId: string): StateRow | undefined {
    return this.ctx.db
      .prepare<[string, string], StateRow>('SELECT * FROM boost_member_state WHERE guild_id = ? AND user_id = ?')
      .get(this.guildId, userId);
  }

  private setState(userId: string, premiumSince: number | null): void {
    this.ctx.db
      .prepare(
        `INSERT INTO boost_member_state (guild_id, user_id, premium_since, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(guild_id, user_id) DO UPDATE SET premium_since = excluded.premium_since, updated_at = excluded.updated_at`,
      )
      .run(this.guildId, userId, premiumSince, this.ctx.clock.now());
  }

  private customRoleId(): string | null {
    if (this.ctx.settings.get('boost.roleMode') !== 'custom') return null;
    const row = this.ctx.registry.get('role:booster');
    if (!row || row.status !== 'done' || !row.discord_id || row.managed_by_discord) return null;
    return row.discord_id;
  }

  /**
   * Startabgleich: speichert den aktuellen Boost-Status aller Mitglieder ohne Danksagung.
   * lastSeen = letzter Heartbeat vor dem Neustart (für die Offline-Meldung).
   */
  async baseline(lastSeen: number | undefined): Promise<BaselineReport> {
    const members = await this.ctx.port.fetchAllMembers();
    const report: BaselineReport = { members: members.length, boosting: 0, startedWhileOffline: [], endedWhileOffline: [], roleAdded: 0, roleRemoved: 0 };
    const roleId = this.customRoleId();
    for (const m of members) {
      if (m.isBot) continue;
      const prev = this.state(m.userId);
      if (m.premiumSince !== null) report.boosting++;
      if (prev && prev.premium_since !== m.premiumSince) {
        if (m.premiumSince !== null && lastSeen !== undefined && m.premiumSince > lastSeen) report.startedWhileOffline.push(m.userId);
        if (m.premiumSince === null && prev.premium_since !== null) report.endedWhileOffline.push(m.userId);
      } else if (!prev && m.premiumSince !== null && lastSeen !== undefined && m.premiumSince > lastSeen) {
        report.startedWhileOffline.push(m.userId);
      }
      this.setState(m.userId, m.premiumSince);
      if (roleId) {
        const r = await this.syncRoleFor(m, roleId);
        if (r === 'added') report.roleAdded++;
        if (r === 'removed') report.roleRemoved++;
      }
    }
    this.baselineDone = true;
    this.lastBaseline = report;
    return report;
  }

  /** GUILD_MEMBER_UPDATE: Beginn bzw. Ende des Boost-Status erkennen. */
  async onMemberUpdate(member: MemberInfo): Promise<void> {
    if (member.isBot) return;
    const prev = this.state(member.userId);
    const now = this.ctx.clock.now();
    const since = member.premiumSince;
    if (prev && prev.premium_since === since) return;
    this.setState(member.userId, since);
    const roleId = this.customRoleId();

    if (since !== null && (!prev || prev.premium_since !== since)) {
      if (now - since <= FRESHNESS_MS && since <= now + MINUTE) {
        this.insertEvent(member.userId, 'member_update', `premium:${member.userId}:${since}`, since, now + MEMBER_UPDATE_DELAY_MS);
      }
      if (roleId && !member.roleIds.includes(roleId)) {
        await this.ctx.port.addRole(member.userId, roleId, 'Discord-Serverboost erkannt').catch((err: unknown) => this.ctx.log.warn({ err: errInfo(err) }, 'Booster-Rolle nicht vergeben'));
      }
      this.schedule();
      return;
    }
    if (since === null && prev?.premium_since != null && roleId) {
      // Ende nur nach frischer Bestätigung per REST – keine öffentliche Nachricht.
      const fresh = await this.ctx.port.fetchMember(member.userId, { force: true });
      if (fresh && fresh.premiumSince === null && fresh.roleIds.includes(roleId)) {
        await this.ctx.port.removeRole(member.userId, roleId, 'Discord-Serverboost beendet (bestätigt)').catch((err: unknown) => this.ctx.log.warn({ err: errInfo(err) }, 'Booster-Rolle nicht entfernt'));
      }
    }
  }

  onMemberJoin(member: MemberInfo): void {
    if (!member.isBot) this.setState(member.userId, member.premiumSince);
  }

  onMemberLeave(userId: string): void {
    this.setState(userId, null);
  }

  /** Systemnachricht „… hat den Server geboostet“ (Typ 8–11). */
  async onSystemBoostMessage(messageId: string, userId: string, createdAt: number): Promise<void> {
    const now = this.ctx.clock.now();
    if (now - createdAt > FRESHNESS_MS) return;
    this.insertEvent(userId, 'system_message', `msg:${messageId}`, createdAt, now);
    await this.processDue();
  }

  private insertEvent(userId: string, source: BoostEventRow['source'], key: string, occurredAt: number, dueAt: number): boolean {
    const info = this.ctx.db
      .prepare(
        `INSERT OR IGNORE INTO boost_events (guild_id, user_id, source, source_key, occurred_at, status, due_at, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(this.guildId, userId, source, key, occurredAt, dueAt, this.ctx.clock.now());
    return info.changes === 1;
  }

  schedule(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.processDue().catch((err: unknown) => this.ctx.log.warn({ err: errInfo(err) }, 'Boost-Verarbeitung fehlgeschlagen'));
    }, 5000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Verarbeitet fällige Ereignisse seriell (keine Doppel-Danksagung bei parallelen Quellen). */
  async processDue(): Promise<number> {
    return this.ctx.locks.run('boost-process', async () => {
      const now = this.ctx.clock.now();
      const due = this.ctx.db
        .prepare<[string, number], BoostEventRow>(
          "SELECT * FROM boost_events WHERE guild_id = ? AND status = 'pending' AND due_at <= ? ORDER BY due_at, id",
        )
        .all(this.guildId, now);
      let thanked = 0;
      for (const ev of due) {
        const current = this.ctx.db.prepare<[number], BoostEventRow>('SELECT * FROM boost_events WHERE id = ?').get(ev.id)!;
        if (current.status !== 'pending') continue;
        if (now - current.occurred_at > FRESHNESS_MS + MEMBER_UPDATE_DELAY_MS) {
          this.finish(current.id, 'stale');
          continue;
        }
        const related = this.ctx.db
          .prepare<[string, string, number, number, number], BoostEventRow>(
            `SELECT * FROM boost_events WHERE guild_id = ? AND user_id = ? AND id != ? AND occurred_at BETWEEN ? AND ?
             AND status IN ('thanked','pending') ORDER BY id`,
          )
          .all(this.guildId, current.user_id, current.id, current.occurred_at - CORRELATION_WINDOW_MS, current.occurred_at + CORRELATION_WINDOW_MS);
        const alreadyThanked = related.find((r) => r.status === 'thanked');
        if (alreadyThanked) {
          this.finish(current.id, 'merged', alreadyThanked.id);
          continue;
        }
        // Eine noch ausstehende Systemnachricht ist aussagekräftiger als das Member-Update.
        const pendingSystem = related.find((r) => r.status === 'pending' && r.source === 'system_message');
        if (current.source === 'member_update' && pendingSystem) {
          this.finish(current.id, 'merged', pendingSystem.id);
          continue;
        }
        if (!this.ctx.settings.get('boost.thanksEnabled')) {
          this.finish(current.id, 'disabled');
          continue;
        }
        const messageId = await this.sendThanks(current.user_id);
        if (messageId) {
          this.ctx.db
            .prepare("UPDATE boost_events SET status = 'thanked', thank_message_id = ?, processed_at = ? WHERE id = ? AND status = 'pending'")
            .run(messageId, this.ctx.clock.now(), current.id);
          for (const r of related.filter((x) => x.status === 'pending')) this.finish(r.id, 'merged', current.id);
          thanked++;
        } else {
          this.finish(current.id, 'failed', null, 'Danksagung konnte nicht gesendet werden');
        }
      }
      return thanked;
    });
  }

  private finish(id: number, status: BoostEventRow['status'], mergedInto: number | null = null, error: string | null = null): void {
    this.ctx.db
      .prepare('UPDATE boost_events SET status = ?, merged_into = ?, last_error = ?, processed_at = ? WHERE id = ?')
      .run(status, mergedInto, error, this.ctx.clock.now(), id);
  }

  private async sendThanks(userId: string): Promise<string | null> {
    const channelId = this.ctx.registry.channelId('boost_danke');
    if (!channelId) return null;
    const mention = this.ctx.settings.get('boost.mentionBooster');
    let premiumLine = '';
    try {
      const p = await this.ctx.port.fetchGuildPremium();
      if (typeof p.count === 'number') premiumLine = `\nDer Server hat aktuell **${p.count} Boosts** (Boost-Stufe ${p.tier}).`;
      else premiumLine = `\nAktuelle Boost-Stufe: ${p.tier}.`;
    } catch {
      premiumLine = '';
    }
    try {
      return await this.ctx.port.sendMessage(channelId, {
        content: mention ? `<@${userId}>` : undefined,
        embeds: [
          embed({
            title: 'Danke für deinen Boost',
            color: COLORS.booster,
            description: `${mention ? `Vielen Dank, <@${userId}>` : 'Vielen Dank'}, dass du KSA Boosting mit einem Discord-Serverboost unterstützt.${premiumLine}`,
          }),
        ],
        allowedMentions: mention ? { users: [userId] } : {},
      });
    } catch (err) {
      this.ctx.log.warn({ err: errInfo(err) }, 'Boost-Danksagung fehlgeschlagen');
      return null;
    }
  }

  private async syncRoleFor(m: MemberInfo, roleId: string): Promise<'added' | 'removed' | 'unchanged'> {
    const has = m.roleIds.includes(roleId);
    if (m.premiumSince !== null && !has) {
      await this.ctx.port.addRole(m.userId, roleId, 'Rollenabgleich: boostet den Server');
      return 'added';
    }
    if (m.premiumSince === null && has) {
      const fresh = await this.ctx.port.fetchMember(m.userId, { force: true });
      if (fresh && fresh.premiumSince === null && fresh.roleIds.includes(roleId)) {
        await this.ctx.port.removeRole(m.userId, roleId, 'Rollenabgleich: Boost beendet (bestätigt)');
        return 'removed';
      }
    }
    return 'unchanged';
  }

  /** /serverboost sync – Rollenabgleich der eigenen kosmetischen Rolle. */
  async syncRoles(actor: Actor): Promise<{ added: number; removed: number; checked: number; mode: string }> {
    assertAllowed(actor, authConfig(this.ctx), 'boost.sync');
    const mode = this.ctx.settings.get('boost.roleMode');
    const roleId = this.customRoleId();
    if (!roleId) return { added: 0, removed: 0, checked: 0, mode };
    const members = await this.ctx.port.fetchAllMembers();
    let added = 0;
    let removed = 0;
    for (const m of members) {
      if (m.isBot) continue;
      try {
        const r = await this.syncRoleFor(m, roleId);
        if (r === 'added') added++;
        if (r === 'removed') removed++;
      } catch (err) {
        this.ctx.log.warn({ err: errInfo(err) }, 'Rollenabgleich für Mitglied fehlgeschlagen');
      }
    }
    this.ctx.audit.record(actor.userId, 'boost.role_sync', undefined, { added, removed });
    return { added, removed, checked: members.length, mode };
  }

  /** /serverboost rollenmodus – nur Founder. Verwaltete Discord-Rollen werden nie verändert. */
  async setRoleMode(actor: Actor, mode: 'managed' | 'custom'): Promise<string> {
    assertAllowed(actor, authConfig(this.ctx), 'boost.roleMode');
    const snap = await this.ctx.port.snapshot();
    if (mode === 'managed') {
      const managed = snap.roles.find((r) => r.isBoosterRole);
      if (!managed) throw new UserError('Discord hat noch keine verwaltete Booster-Rolle angelegt (entsteht in der Regel mit dem ersten Boost).');
      const old = this.ctx.registry.get('role:booster');
      this.ctx.registry.markDone('role:booster', 'role', managed.id, this.ctx.clock.now(), { managedByDiscord: true });
      this.ctx.settings.set('boost.roleMode', 'managed', actor.userId);
      this.ctx.audit.record(actor.userId, 'boost.role_mode', undefined, { mode, previousRole: old?.discord_id ?? null });
      return `Verwaltete Discord-Rolle **${managed.name}** wird jetzt verwendet. ${old && !old.managed_by_discord && old.discord_id ? `Die bisherige eigene Rolle <@&${old.discord_id}> wird nicht mehr synchronisiert und kann manuell gelöscht werden.` : ''}`;
    }
    this.ctx.settings.set('boost.roleMode', 'custom', actor.userId);
    const row = this.ctx.registry.get('role:booster');
    if (row?.managed_by_discord) this.ctx.registry.forget('role:booster');
    this.ctx.audit.record(actor.userId, 'boost.role_mode', undefined, { mode });
    return 'Eigene kosmetische Rolle „Server Booster“ wird verwendet. Falls sie noch nicht existiert, legt `/setup start` sie an; danach `/serverboost sync` ausführen.';
  }

  async diagnose(actor: Actor, intents: { guildMembers: boolean; guildMessages: boolean }): Promise<string[]> {
    assertAllowed(actor, authConfig(this.ctx), 'boost.diagnose');
    const snap = await this.ctx.port.snapshot();
    const lines: string[] = [];
    const premium = await this.ctx.port.fetchGuildPremium().catch(() => null);
    lines.push(`**Boost-Stufe:** ${premium ? premium.tier : snap.premiumTier} · **Boosts:** ${premium && typeof premium.count === 'number' ? premium.count : 'nicht verfügbar'}`);
    lines.push(`**Intent Server Members:** ${intents.guildMembers ? 'aktiv' : 'FEHLT – Beginn/Ende des Boost-Status nicht erkennbar'}`);
    lines.push(`**Intent Guild Messages:** ${intents.guildMessages ? 'aktiv' : 'FEHLT – Boost-Systemnachrichten nicht erkennbar'}`);
    lines.push(`**Systemkanal:** ${snap.systemChannelId ? `<#${snap.systemChannelId}>` : 'nicht gesetzt (keine Boost-Systemnachrichten)'}`);
    lines.push(`**Boost-Systemnachrichten:** ${(snap.systemChannelFlags & 2) === 2 ? 'in den Servereinstellungen deaktiviert' : 'aktiviert'}`);
    const mode = this.ctx.settings.get('boost.roleMode');
    const row = this.ctx.registry.get('role:booster');
    const managed = snap.roles.find((r) => r.isBoosterRole);
    lines.push(`**Rollenmodus:** ${mode === 'managed' ? 'verwaltete Discord-Rolle' : 'eigene kosmetische Rolle'}${row?.discord_id ? ` (<@&${row.discord_id}>)` : ' – noch nicht eingerichtet'}`);
    lines.push(`**Verwaltete Discord-Booster-Rolle:** ${managed ? `vorhanden (<@&${managed.id}>)` : 'noch nicht vorhanden'}`);
    if (mode === 'custom' && managed) lines.push('Hinweis: Empfohlen ist `/serverboost rollenmodus modus:verwaltet`, um doppelte Booster-Rollen zu vermeiden.');
    lines.push(`**Danksagung:** ${this.ctx.settings.get('boost.thanksEnabled') ? 'aktiv' : 'deaktiviert'} · Erwähnung: ${this.ctx.settings.get('boost.mentionBooster') ? 'ja (nur Booster)' : 'nein'}`);
    const stats = this.ctx.db
      .prepare<[string], { status: string; n: number }>('SELECT status, COUNT(*) AS n FROM boost_events WHERE guild_id = ? GROUP BY status')
      .all(this.guildId);
    lines.push(`**Ereignisse:** ${stats.length ? stats.map((s) => `${s.status}: ${s.n}`).join(', ') : 'keine'}`);
    if (this.lastBaseline) {
      lines.push(
        `**Letzter Startabgleich:** ${this.lastBaseline.members} Mitglieder, ${this.lastBaseline.boosting} boosten · während Offline-Zeit begonnen (nicht automatisch bedankt): ${this.lastBaseline.startedWhileOffline.length}`,
      );
    }
    lines.push('Einschränkung: Während der Bot offline ist, gehen Ereignisse verloren und werden nicht nachträglich bedankt. Ein zusätzlicher Boost derselben Person ist nur über die Systemnachricht erkennbar.');
    return lines;
  }
}
