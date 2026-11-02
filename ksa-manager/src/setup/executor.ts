import { panelDefinition } from '../content/panels.js';
import type { GuildSnapshot } from '../discord/port.js';
import { isUnknownResource } from '../discord/port.js';
import { errInfo } from '../logging/logger.js';
import type { AppContext } from '../services/context.js';
import { automodResKey, categoryResKey, channelResKey, panelResKey, roleResKey } from '../services/registry.js';
import { hashObject } from '../util/hash.js';
import { AUTOMOD_RULES } from './automod.js';
import {
  categoryBlueprint,
  CATEGORIES,
  channelBlueprint,
  overwritesFor,
  ROLES,
  type OverwriteContext,
  type RoleKey,
} from './blueprint.js';
import { buildPanelContext } from './panelContext.js';
import { describePlanItem, type PlanItem, type SetupPlan } from './planner.js';

export interface SetupResult {
  done: string[];
  failed: { item: string; error: string }[];
  skipped: string[];
}

export interface ExecutorOptions {
  /** Pause zwischen schreibenden Discord-Aufrufen (Schonung der Rate-Limits). */
  paceMs: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function errorMessage(err: unknown): string {
  const info = errInfo(err);
  return String(info.message ?? 'Unbekannter Fehler').slice(0, 300);
}

/**
 * Führt einen bestätigten Plan aus. Jede erstellte Ressource wird sofort mit
 * ihrer ID gespeichert; vor dem Discord-Aufruf wird der Versuch markiert, damit
 * ein Abbruch beim nächsten Lauf erkannt und die Ressource übernommen wird.
 */
export async function executePlan(ctx: AppContext, plan: SetupPlan, opts: ExecutorOptions): Promise<SetupResult> {
  const result: SetupResult = { done: [], failed: [], skipped: [] };
  const now = () => ctx.clock.now();
  const reg = ctx.registry;
  const snapshot0 = await ctx.port.snapshot();

  const run = async (item: PlanItem, fn: () => Promise<void>) => {
    const label = describePlanItem(item);
    try {
      await fn();
      result.done.push(label);
    } catch (err) {
      ctx.log.warn({ err: errInfo(err), op: item.op }, 'Setup-Schritt fehlgeschlagen');
      result.failed.push({ item: label, error: errorMessage(err) });
    }
    if (opts.paceMs > 0) await sleep(opts.paceMs);
  };
  const skip = (item: PlanItem, why: string) => result.skipped.push(`${describePlanItem(item)} – ${why}`);

  const byOp = <K extends PlanItem['op']>(op: K) => plan.items.filter((i): i is Extract<PlanItem, { op: K }> => i.op === op);

  // 1) Rollen
  for (const item of plan.items) {
    if (item.op === 'create_role') {
      const bp = ROLES.find((r) => r.key === item.key)!;
      await run(item, async () => {
        reg.markInProgress(roleResKey(bp.key), 'role', now());
        try {
          const id = await ctx.port.createRole({
            name: bp.name,
            color: bp.color,
            hoist: bp.hoist,
            mentionable: false,
            permissions: 0n,
            reason: 'KSA Manager Setup',
          });
          reg.markDone(roleResKey(bp.key), 'role', id, now());
          if (bp.key === 'booster') ctx.settings.set('boost.roleMode', 'custom', 'setup', now());
        } catch (err) {
          reg.markFailed(roleResKey(bp.key), 'role', errorMessage(err), now());
          throw err;
        }
      });
    } else if (item.op === 'adopt_role') {
      await run(item, async () => {
        reg.markDone(roleResKey(item.key), 'role', item.roleId, now(), { adopted: true });
        if (item.key === 'booster') ctx.settings.set('boost.roleMode', 'custom', 'setup', now());
      });
    } else if (item.op === 'link_managed_booster') {
      await run(item, async () => {
        reg.markDone(roleResKey('booster'), 'role', item.roleId, now(), { managedByDiscord: true });
        ctx.settings.set('boost.roleMode', 'managed', 'setup', now());
      });
    }
  }

  if (byOp('reorder_roles').length) {
    const item = byOp('reorder_roles')[0]!;
    await run(item, async () => {
      const snap = await ctx.port.snapshot();
      const top = snap.bot.highestRolePosition;
      const ours = ROLES.map((bp) => ({ bp, id: reg.roleId(bp.key) }))
        .map(({ bp, id }) => ({ bp, role: id ? snap.roles.find((r) => r.id === id) : undefined }))
        .filter((x) => x.role && !x.role.managed && x.role.position < top);
      const positions = ours.map((x, i) => ({ id: x.role!.id, position: Math.max(1, top - 1 - i) }));
      if (positions.length) await ctx.port.setRolePositions(positions, 'KSA Manager Setup: Rollenreihenfolge');
    });
  }

  // Overwrite-Kontext nach dem Anlegen der Rollen
  const roleIds: Partial<Record<RoleKey, string>> = {};
  for (const bp of ROLES) {
    const id = reg.roleId(bp.key);
    if (id) roleIds[bp.key] = id;
  }
  const owCtx: OverwriteContext = {
    guildId: snapshot0.id,
    botUserId: snapshot0.bot.userId,
    roles: roleIds,
    requireRulesAcceptance: ctx.settings.get('community.requireRulesAcceptance'),
  };

  // 2) Kategorien
  for (const item of plan.items) {
    if (item.op === 'create_category') {
      const bp = categoryBlueprint(item.key);
      await run(item, async () => {
        const key = categoryResKey(bp.key);
        reg.markInProgress(key, 'category', now());
        try {
          const id = await ctx.port.createChannel({
            name: bp.name,
            kind: 'category',
            parentId: null,
            overwrites: overwritesFor(bp.profile, owCtx),
            reason: 'KSA Manager Setup',
          });
          reg.markDone(key, 'category', id, now());
        } catch (err) {
          reg.markFailed(key, 'category', errorMessage(err), now());
          throw err;
        }
      });
    } else if (item.op === 'adopt_category') {
      const bp = categoryBlueprint(item.key);
      await run(item, async () => {
        await ctx.port.editChannel(item.channelId, { overwrites: overwritesFor(bp.profile, owCtx), reason: 'KSA Manager Setup: Übernahme' });
        reg.markDone(categoryResKey(bp.key), 'category', item.channelId, now(), { adopted: item.reason === 'foreign' });
      });
    }
  }

  // 3) Kanäle
  for (const item of plan.items) {
    if (item.op === 'create_channel') {
      const bp = channelBlueprint(item.key);
      const parentId = reg.categoryId(bp.parent);
      if (!parentId) {
        skip(item, 'Kategorie fehlt (siehe Fehler oben)');
        continue;
      }
      await run(item, async () => {
        const key = channelResKey(bp.key);
        reg.markInProgress(key, bp.kind, now());
        try {
          const spec = {
            name: bp.name,
            kind: bp.kind,
            parentId,
            overwrites: overwritesFor(bp.profile, owCtx),
            reason: 'KSA Manager Setup',
            ...(bp.topic ? { topic: bp.topic } : {}),
          };
          const id = await ctx.port.createChannel(spec);
          reg.markDone(key, bp.kind, id, now());
        } catch (err) {
          reg.markFailed(key, bp.kind, errorMessage(err), now());
          throw err;
        }
      });
    } else if (item.op === 'adopt_channel') {
      const bp = channelBlueprint(item.key);
      const parentId = reg.categoryId(bp.parent);
      await run(item, async () => {
        await ctx.port.editChannel(item.channelId, {
          ...(parentId ? { parentId } : {}),
          overwrites: overwritesFor(bp.profile, owCtx),
          reason: 'KSA Manager Setup: Übernahme',
        });
        reg.markDone(channelResKey(bp.key), bp.kind, item.channelId, now(), { adopted: item.reason === 'foreign' });
      });
    }
  }

  // 4) Korrekturen bestehender, bot-eigener Ressourcen
  for (const item of byOp('fix_channel')) {
    await run(item, async () => {
      if (item.isCategory) {
        const bp = CATEGORIES.find((c) => c.key === item.key)!;
        await ctx.port.editChannel(item.channelId, {
          ...(item.changes.includes('name') ? { name: bp.name } : {}),
          ...(item.changes.includes('overwrites') ? { overwrites: overwritesFor(bp.profile, owCtx) } : {}),
          reason: 'KSA Manager Setup: Korrektur',
        });
        return;
      }
      const bp = channelBlueprint(item.key as Parameters<typeof channelBlueprint>[0]);
      const parentId = reg.categoryId(bp.parent);
      await ctx.port.editChannel(item.channelId, {
        ...(item.changes.includes('name') ? { name: bp.name } : {}),
        ...(item.changes.includes('parent') && parentId ? { parentId } : {}),
        ...(item.changes.includes('overwrites') ? { overwrites: overwritesFor(bp.profile, owCtx) } : {}),
        reason: 'KSA Manager Setup: Korrektur',
      });
    });
  }

  // 5) Founder-Rolle
  for (const item of byOp('assign_founder_role')) {
    const roleId = reg.roleId('founder');
    if (!roleId) {
      skip(item, 'Rolle KSA Founder fehlt');
      continue;
    }
    await run(item, async () => {
      for (const userId of item.userIds) {
        await ctx.port.addRole(userId, roleId, 'KSA Manager Setup: Founder laut OWNER_IDS');
      }
    });
  }

  // 6) Panels (nach den Kanälen, damit Kanal-Erwähnungen aufgelöst werden)
  const snapAfter: GuildSnapshot = await ctx.port.snapshot().catch(() => snapshot0);
  const panelCtx = buildPanelContext(ctx, snapAfter);
  for (const item of plan.items) {
    if (item.op !== 'post_panel' && item.op !== 'update_panel') continue;
    const def = panelDefinition(item.key);
    const channelId = reg.channelId(def.channel);
    if (!channelId) {
      skip(item, 'Zielkanal fehlt');
      continue;
    }
    const payload = def.render(panelCtx);
    const contentHash = hashObject(payload);
    await run(item, async () => {
      const key = panelResKey(def.key);
      if (item.op === 'update_panel') {
        try {
          await ctx.port.editMessage(channelId, item.messageId, payload);
          reg.markDone(key, 'panel', item.messageId, now(), { channelId, contentHash });
          return;
        } catch (err) {
          if (!isUnknownResource(err)) throw err;
        }
      }
      reg.markInProgress(key, 'panel', now());
      const messageId = await ctx.port.sendMessage(channelId, payload);
      reg.markDone(key, 'panel', messageId, now(), { channelId, contentHash });
    });
  }

  // 7) AutoMod
  const exemptRoleIds = (['founder', 'admin', 'support', 'operator'] as const)
    .map((k) => reg.roleId(k))
    .filter((x): x is string => Boolean(x));
  for (const item of plan.items) {
    if (item.op === 'adopt_automod') {
      await run(item, async () => reg.markDone(automodResKey(item.key), 'automod', item.ruleId, now()));
    } else if (item.op === 'create_automod') {
      const bp = AUTOMOD_RULES.find((r) => r.key === item.key)!;
      await run(item, async () => {
        const key = automodResKey(bp.key);
        reg.markInProgress(key, 'automod', now());
        try {
          const spec = bp.build({ teamLogChannelId: reg.channelId('teamlog'), exemptRoleIds });
          const id = await ctx.port.createAutoModRule({ ...spec, reason: 'KSA Manager Setup' });
          reg.markDone(key, 'automod', id, now());
        } catch (err) {
          reg.markFailed(key, 'automod', errorMessage(err), now());
          throw err;
        }
      });
    }
  }

  // 8) AFK-Kanal
  for (const item of byOp('set_afk')) {
    const afk = reg.channelId('v_afk');
    if (!afk) {
      skip(item, 'AFK-Kanal fehlt');
      continue;
    }
    await run(item, () => ctx.port.setAfkChannel(afk, 300, 'KSA Manager Setup'));
  }

  return result;
}
