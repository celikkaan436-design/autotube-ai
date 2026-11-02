import { PermissionFlagsBits as P } from 'discord.js';
import { PANELS, type PanelKey } from '../content/panels.js';
import { isUnknownResource } from '../discord/port.js';
import { hashObject } from '../util/hash.js';
import { buildPanelContext } from './panelContext.js';
import type { AppContext, Actor } from '../services/context.js';
import { authConfig } from '../services/context.js';
import { assertAllowed } from '../domain/permissions.js';
import { UserError } from '../util/errors.js';
import { randomToken } from '../util/hash.js';
import { MINUTE } from '../util/time.js';
import { categoryResKey, panelResKey, roleResKey } from '../services/registry.js';
import {
  CATEGORIES,
  CHANNELS,
  OPTIONAL_BOT_PERMISSIONS,
  overwritesEqual,
  overwritesFor,
  REQUIRED_BOT_PERMISSIONS,
  ROLES,
  normalizeChannelName,
  type OverwriteContext,
  type RoleKey,
} from './blueprint.js';
import { computePlan, type SetupOptions, type SetupPlan } from './planner.js';
import { executePlan, type SetupResult } from './executor.js';

export const PLAN_TTL_MS = 10 * MINUTE;

interface PlanRow {
  id: string;
  guild_id: string;
  user_id: string;
  plan_hash: string;
  plan_json: string;
  options_json: string;
  status: string;
  created_at: number;
  expires_at: number;
}

export class SetupService {
  private running = false;

  constructor(
    private readonly ctx: AppContext,
    private readonly paceMs = 350,
  ) {}

  /** Schritt 1–3: Server prüfen, Rechte prüfen, Vorschau erstellen und speichern. */
  async preview(actor: Actor, guildId: string, options: SetupOptions): Promise<{ planId: string; plan: SetupPlan; expiresAt: number }> {
    if (guildId !== this.ctx.config.guildId) throw new UserError('Dieser Server ist nicht der konfigurierte Zielserver.');
    assertAllowed(actor, authConfig(this.ctx), 'setup.run');
    const snapshot = await this.ctx.port.snapshot();
    const plan = await computePlan(this.ctx, snapshot, options);
    const now = this.ctx.clock.now();
    const planId = randomToken(9);
    // Ältere, offene Vorschauen desselben Nutzers verfallen.
    this.ctx.db
      .prepare("UPDATE setup_plans SET status = 'expired' WHERE guild_id = ? AND user_id = ? AND status = 'pending'")
      .run(guildId, actor.userId);
    this.ctx.db
      .prepare(
        `INSERT INTO setup_plans (id, guild_id, user_id, plan_hash, plan_json, options_json, status, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(planId, guildId, actor.userId, plan.hash, JSON.stringify(plan.items), JSON.stringify(options), now, now + PLAN_TTL_MS);
    return { planId, plan, expiresAt: now + PLAN_TTL_MS };
  }

  cancel(actor: Actor, planId: string): void {
    const row = this.getPlan(planId);
    if (!row || row.user_id !== actor.userId) throw new UserError('Diese Vorschau gehört nicht dir.');
    this.ctx.db.prepare("UPDATE setup_plans SET status = 'cancelled' WHERE id = ? AND status = 'pending'").run(planId);
  }

  /**
   * Schritt 4–6: Bestätigung prüfen (gebunden an Nutzer, Server, Plan-Hash und
   * Ablaufzeit), Plan neu berechnen und nur bei identischem Hash ausführen.
   */
  async confirm(actor: Actor, guildId: string, planId: string, hashPrefix: string): Promise<{ plan: SetupPlan; result: SetupResult }> {
    assertAllowed(actor, authConfig(this.ctx), 'setup.run');
    const row = this.getPlan(planId);
    const now = this.ctx.clock.now();
    if (!row) throw new UserError('Diese Vorschau existiert nicht (mehr).');
    if (row.guild_id !== guildId || guildId !== this.ctx.config.guildId) throw new UserError('Die Vorschau gehört zu einem anderen Server.');
    if (row.user_id !== actor.userId) throw new UserError('Nur der Founder, der die Vorschau erstellt hat, kann sie bestätigen.');
    if (!row.plan_hash.startsWith(hashPrefix) || hashPrefix.length < 12) throw new UserError('Die Bestätigung passt nicht zu dieser Vorschau.');
    if (row.status !== 'pending') throw new UserError('Diese Vorschau wurde bereits verwendet oder abgebrochen.');
    if (row.expires_at < now) {
      this.ctx.db.prepare("UPDATE setup_plans SET status = 'expired' WHERE id = ?").run(planId);
      throw new UserError('Die Vorschau ist abgelaufen. Bitte /setup start erneut ausführen.');
    }
    if (this.running) throw new UserError('Ein Setup läuft bereits.');
    // Atomar beanspruchen – verhindert Doppelausführung durch Doppelklick.
    const claimed = this.ctx.db
      .prepare("UPDATE setup_plans SET status = 'running' WHERE id = ? AND status = 'pending'")
      .run(planId).changes;
    if (claimed !== 1) throw new UserError('Diese Vorschau wird bereits ausgeführt.');
    this.running = true;
    try {
      const options = JSON.parse(row.options_json) as SetupOptions;
      const snapshot = await this.ctx.port.snapshot();
      const plan = await computePlan(this.ctx, snapshot, options);
      if (plan.hash !== row.plan_hash) {
        this.ctx.db.prepare("UPDATE setup_plans SET status = 'stale', finished_at = ? WHERE id = ?").run(now, planId);
        throw new UserError('Der Server hat sich seit der Vorschau verändert. Bitte /setup start erneut ausführen und die neue Vorschau prüfen.');
      }
      if (plan.blockers.length) {
        this.ctx.db.prepare("UPDATE setup_plans SET status = 'failed', finished_at = ? WHERE id = ?").run(now, planId);
        throw new UserError(`Setup blockiert:\n${plan.blockers.join('\n')}`);
      }
      const result = await executePlan(this.ctx, plan, { paceMs: this.paceMs });
      this.ctx.db
        .prepare('UPDATE setup_plans SET status = ?, finished_at = ?, result_json = ? WHERE id = ?')
        .run(result.failed.length ? 'failed' : 'done', this.ctx.clock.now(), JSON.stringify(result), planId);
      this.ctx.audit.record(actor.userId, 'setup.executed', { type: 'setup_plan', id: planId }, {
        done: result.done.length,
        failed: result.failed.length,
        skipped: result.skipped.length,
      });
      return { plan, result };
    } finally {
      this.running = false;
    }
  }

  /** /panel aktualisieren: Panels neu rendern; fehlende Nachrichten werden neu gepostet. */
  async refreshPanels(actor: Actor, keys: PanelKey[] | 'all'): Promise<string[]> {
    assertAllowed(actor, authConfig(this.ctx), 'panel.manage');
    const snap = await this.ctx.port.snapshot();
    const panelCtx = buildPanelContext(this.ctx, snap);
    const now = () => this.ctx.clock.now();
    const out: string[] = [];
    for (const def of PANELS) {
      if (keys !== 'all' && !keys.includes(def.key)) continue;
      const channelId = this.ctx.registry.channelId(def.channel);
      if (!channelId || !snap.channels.some((c) => c.id === channelId)) {
        out.push(`${def.title}: Zielkanal fehlt – bitte /setup start ausführen.`);
        continue;
      }
      if (def.live) {
        const row = this.ctx.registry.get(panelResKey(def.key));
        const exists = row?.discord_id && row.channel_id ? await this.ctx.port.fetchMessage(row.channel_id, row.discord_id) : null;
        if (exists) {
          out.push(`${def.title}: vorhanden (wird automatisch aktualisiert).`);
          continue;
        }
      }
      const payload = def.render(panelCtx);
      const contentHash = hashObject(payload);
      const row = this.ctx.registry.get(panelResKey(def.key));
      try {
        if (row?.status === 'done' && row.discord_id && row.channel_id === channelId) {
          try {
            await this.ctx.port.editMessage(channelId, row.discord_id, payload);
            this.ctx.registry.markDone(panelResKey(def.key), 'panel', row.discord_id, now(), { channelId, contentHash });
            out.push(`${def.title}: aktualisiert.`);
            continue;
          } catch (err) {
            if (!isUnknownResource(err)) throw err;
          }
        }
        const id = await this.ctx.port.sendMessage(channelId, payload);
        this.ctx.registry.markDone(panelResKey(def.key), 'panel', id, now(), { channelId, contentHash });
        out.push(`${def.title}: neu gepostet.`);
      } catch (err) {
        out.push(`${def.title}: Fehler – ${(err as Error).message}`);
      }
    }
    this.ctx.audit.record(actor.userId, 'panel.refresh', undefined, { keys });
    return out;
  }

  private getPlan(planId: string): PlanRow | undefined {
    return this.ctx.db.prepare<[string], PlanRow>('SELECT * FROM setup_plans WHERE id = ?').get(planId);
  }

  /** Diagnose: fehlende Rechte, gelöschte/verschobene Ressourcen, Rechteabweichungen, Panels. */
  async diagnose(actor: Actor, guildId: string): Promise<{ ok: string[]; problems: string[]; hints: string[] }> {
    if (guildId !== this.ctx.config.guildId) throw new UserError('Dieser Server ist nicht der konfigurierte Zielserver.');
    assertAllowed(actor, authConfig(this.ctx), 'setup.diagnose');
    const ok: string[] = [];
    const problems: string[] = [];
    const hints: string[] = [];
    const snap = await this.ctx.port.snapshot();
    const reg = this.ctx.registry;
    const isAdmin = (snap.bot.permissions & P.Administrator) === P.Administrator;

    for (const perm of REQUIRED_BOT_PERMISSIONS) {
      if (!isAdmin && (snap.bot.permissions & perm.flag) !== perm.flag) problems.push(`Bot-Recht fehlt: ${perm.name} – ${perm.why}`);
    }
    for (const perm of OPTIONAL_BOT_PERMISSIONS) {
      if (!isAdmin && (snap.bot.permissions & perm.flag) !== perm.flag) hints.push(`Optionales Recht fehlt: ${perm.name} – ${perm.why}`);
    }
    if (isAdmin) hints.push('Der Bot hat „Administrator“ – nicht nötig, bitte entfernen.');
    if (!problems.length) ok.push('Alle benötigten Bot-Rechte vorhanden.');

    const roleIds: Partial<Record<RoleKey, string>> = {};
    let rolesMissing = 0;
    for (const bp of ROLES) {
      const row = reg.get(roleResKey(bp.key));
      const role = row?.discord_id ? snap.roles.find((r) => r.id === row.discord_id) : undefined;
      if (!row || row.status !== 'done') {
        problems.push(`Rolle ${bp.name}: noch nicht eingerichtet${row?.last_error ? ` (letzter Fehler: ${row.last_error})` : ''}.`);
        rolesMissing++;
      } else if (!role) {
        problems.push(`Rolle ${bp.name}: wurde in Discord gelöscht – /setup start erstellt sie neu.`);
        rolesMissing++;
      } else {
        roleIds[bp.key] = role.id;
        if (!role.managed && role.position >= snap.bot.highestRolePosition) {
          problems.push(`Rolle ${role.name} steht über der Bot-Rolle – Bot-Rolle in den Servereinstellungen nach oben ziehen.`);
        }
        if (role.name !== bp.name && !role.managed) hints.push(`Rolle „${bp.name}“ wurde in „${role.name}“ umbenannt (funktioniert weiter, da über ID verknüpft).`);
        if ((role.permissions & P.Administrator) === P.Administrator) hints.push(`Rolle ${role.name} hat Administrator-Rechte – bewusst so gewollt?`);
      }
    }
    if (!rolesMissing) ok.push(`Alle ${ROLES.length} Rollen vorhanden.`);

    const owCtx: OverwriteContext = {
      guildId: snap.id,
      botUserId: snap.bot.userId,
      roles: roleIds,
      requireRulesAcceptance: this.ctx.settings.get('community.requireRulesAcceptance'),
    };
    let channelProblems = 0;
    for (const bp of CATEGORIES) {
      const id = reg.categoryId(bp.key);
      const c = id ? snap.channels.find((x) => x.id === id) : undefined;
      if (!c) {
        problems.push(`Kategorie ${bp.name}: ${id ? 'wurde gelöscht' : 'fehlt'}.`);
        channelProblems++;
      } else if (!rolesMissing && !overwritesEqual(c.overwrites, overwritesFor(bp.profile, owCtx))) {
        problems.push(`Kategorie ${c.name}: Rechte weichen vom Bauplan ab – /setup start korrigieren:true.`);
        channelProblems++;
      }
    }
    for (const bp of CHANNELS) {
      const id = reg.channelId(bp.key);
      const c = id ? snap.channels.find((x) => x.id === id) : undefined;
      if (!c) {
        problems.push(`Kanal ${bp.name}: ${id ? 'wurde gelöscht' : 'fehlt'}.`);
        channelProblems++;
        continue;
      }
      const parentId = reg.categoryId(bp.parent);
      if (parentId && c.parentId !== parentId) {
        problems.push(`Kanal <#${c.id}> wurde in eine andere Kategorie verschoben.`);
        channelProblems++;
      }
      if (normalizeChannelName(c.name, bp.kind) !== normalizeChannelName(bp.name, bp.kind)) hints.push(`Kanal <#${c.id}> wurde umbenannt.`);
      if (!rolesMissing && !overwritesEqual(c.overwrites, overwritesFor(bp.profile, owCtx))) {
        problems.push(`Kanal <#${c.id}>: Rechte weichen vom Bauplan ab.`);
        channelProblems++;
      }
    }
    if (!channelProblems) ok.push('Alle Kategorien und Kanäle vorhanden, an ihrem Platz und mit korrekten Rechten.');

    let panelProblems = 0;
    for (const p of PANELS) {
      const row = reg.get(panelResKey(p.key));
      if (!row || row.status !== 'done' || !row.discord_id || !row.channel_id) {
        problems.push(`Panel ${p.title}: fehlt.`);
        panelProblems++;
        continue;
      }
      const msg = await this.ctx.port.fetchMessage(row.channel_id, row.discord_id);
      if (!msg) {
        problems.push(`Panel ${p.title}: Nachricht wurde gelöscht.`);
        panelProblems++;
      }
    }
    if (!panelProblems) ok.push(`Alle ${PANELS.length} Panels vorhanden.`);

    for (const row of reg.byPrefix('category:tickets_')) {
      if (!CATEGORIES.some((c) => categoryResKey(c.key) === row.key) && row.discord_id && !snap.channels.some((c) => c.id === row.discord_id)) {
        hints.push(`Zusätzliche Ticket-Kategorie (${row.key}) wurde gelöscht und wird bei Bedarf neu angelegt.`);
      }
    }
    if ((snap.systemChannelFlags & 2) === 2) {
      hints.push('Boost-Systemnachrichten sind in den Servereinstellungen deaktiviert – zusätzliche Boosts derselben Person sind dann nicht erkennbar.');
    }
    if (!snap.systemChannelId) hints.push('Kein Systemkanal gesetzt – Discord postet dann keine Boost-Systemnachrichten.');
    return { ok, problems, hints };
  }
}
