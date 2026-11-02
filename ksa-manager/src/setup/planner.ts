import { PermissionFlagsBits as P } from 'discord.js';
import { PANELS, type PanelKey } from '../content/panels.js';
import type { ChannelInfo, GuildSnapshot, RoleInfo } from '../discord/port.js';
import type { AppContext } from '../services/context.js';
import { automodResKey, categoryResKey, channelResKey, panelResKey, roleResKey, type ResourceRow } from '../services/registry.js';
import { hashObject } from '../util/hash.js';
import { snowflakeTime } from '../util/time.js';
import { AUTOMOD_RULES } from './automod.js';
import {
  CATEGORIES,
  CHANNELS,
  OPTIONAL_BOT_PERMISSIONS,
  overwritesEqual,
  overwritesFor,
  REQUIRED_BOT_PERMISSIONS,
  ROLES,
  normalizeChannelName,
  type CategoryKey,
  type ChannelKey,
  type OverwriteContext,
  type RoleKey,
} from './blueprint.js';
import { buildPanelContext } from './panelContext.js';

export interface SetupOptions {
  /** Verschobene/umbenannte Kanäle und abweichende Rechte bot-eigener Ressourcen korrigieren. */
  correct: boolean;
  /** Gleichnamige, nicht vom Bot erstellte Ressourcen nach Bestätigung übernehmen. */
  adoptForeign: boolean;
}

export type PlanItem =
  | { op: 'create_role'; key: RoleKey; name: string; recreate: boolean }
  | { op: 'adopt_role'; key: RoleKey; name: string; roleId: string; reason: 'orphan' | 'foreign' }
  | { op: 'link_managed_booster'; key: 'booster'; name: string; roleId: string }
  | { op: 'reorder_roles' }
  | { op: 'create_category'; key: CategoryKey; name: string; recreate: boolean }
  | { op: 'adopt_category'; key: CategoryKey; name: string; channelId: string; reason: 'orphan' | 'foreign' }
  | { op: 'create_channel'; key: ChannelKey; name: string; parent: CategoryKey; recreate: boolean }
  | { op: 'adopt_channel'; key: ChannelKey; name: string; channelId: string; reason: 'orphan' | 'foreign' }
  | { op: 'fix_channel'; key: ChannelKey | CategoryKey; isCategory: boolean; channelId: string; changes: ('parent' | 'name' | 'overwrites')[] }
  | { op: 'assign_founder_role'; userIds: string[] }
  | { op: 'post_panel'; key: PanelKey; channel: ChannelKey; repost: boolean }
  | { op: 'update_panel'; key: PanelKey; channel: ChannelKey; messageId: string }
  | { op: 'create_automod'; key: string; name: string }
  | { op: 'adopt_automod'; key: string; name: string; ruleId: string }
  | { op: 'set_afk' };

export interface SetupPlan {
  guildId: string;
  options: SetupOptions;
  items: PlanItem[];
  warnings: string[];
  blockers: string[];
  missingOptional: string[];
  hash: string;
}

const RESOURCE_MARGIN_MS = 5_000;

function isRegisteredId(rows: ResourceRow[], id: string): boolean {
  return rows.some((r) => r.discord_id === id);
}

/** Findet eine beim letzten, abgebrochenen Versuch bereits angelegte Ressource. */
function findOrphan<T extends { id: string; name: string }>(
  candidates: T[],
  row: ResourceRow | undefined,
  rows: ResourceRow[],
  match: (c: T) => boolean,
): T | undefined {
  // 'in_progress' = Absturz während des Aufrufs, 'failed' = Fehler, evtl. nach erfolgter Erstellung (verlorene Antwort)
  if (!row || row.status === 'done' || row.attempt_started_at === null) return undefined;
  const since = row.attempt_started_at - RESOURCE_MARGIN_MS;
  return candidates.find((c) => match(c) && !isRegisteredId(rows, c.id) && snowflakeTime(c.id) >= since);
}

export async function computePlan(ctx: AppContext, snapshot: GuildSnapshot, options: SetupOptions): Promise<SetupPlan> {
  const items: PlanItem[] = [];
  const warnings: string[] = [];
  const blockers: string[] = [];
  const rows = ctx.registry.all();
  const rowOf = (key: string) => rows.find((r) => r.key === key);

  // 1) Zielserver und Rechte
  if (snapshot.id !== ctx.config.guildId) {
    blockers.push('Der Bot ist nicht mit dem konfigurierten Zielserver verbunden.');
  }
  const isAdmin = (snapshot.bot.permissions & P.Administrator) === P.Administrator;
  if (isAdmin) {
    warnings.push('Der Bot besitzt „Administrator“. Das ist nicht nötig – empfohlen ist, das Recht zu entfernen und nur die dokumentierten Rechte zu vergeben.');
  }
  for (const perm of REQUIRED_BOT_PERMISSIONS) {
    if (!isAdmin && (snapshot.bot.permissions & perm.flag) !== perm.flag) {
      blockers.push(`Fehlendes Bot-Recht: **${perm.name}** (${perm.why})`);
    }
  }
  const missingOptional: string[] = [];
  for (const perm of OPTIONAL_BOT_PERMISSIONS) {
    if (!isAdmin && (snapshot.bot.permissions & perm.flag) !== perm.flag) missingOptional.push(perm.name);
  }
  const hasManageGuild = isAdmin || (snapshot.bot.permissions & P.ManageGuild) === P.ManageGuild;

  // 2) Rollen
  const botTop = snapshot.bot.highestRolePosition;
  const roleById = (id: string | null | undefined) => (id ? snapshot.roles.find((r) => r.id === id) : undefined);
  let anyRoleCreated = false;
  for (const bp of ROLES) {
    const key = roleResKey(bp.key);
    const row = rowOf(key);
    const existing = row?.status === 'done' ? roleById(row.discord_id) : undefined;
    if (existing) {
      if (!existing.managed && existing.position >= botTop) {
        warnings.push(`Rolle **${existing.name}** steht über oder auf Höhe der Bot-Rolle – der Bot kann sie nicht vergeben. Bitte die Bot-Rolle höher ziehen.`);
      }
      if (bp.key === 'booster' && !existing.managed) {
        const managed = snapshot.roles.find((r) => r.isBoosterRole);
        if (managed) {
          warnings.push(`Discord hat inzwischen die verwaltete Booster-Rolle **${managed.name}** angelegt. Empfehlung: \`/serverboost rollenmodus modus:verwaltet\`.`);
        }
      }
      continue;
    }
    const recreate = row?.status === 'done';
    if (bp.key === 'booster') {
      const managed = snapshot.roles.find((r) => r.isBoosterRole);
      if (managed) {
        items.push({ op: 'link_managed_booster', key: 'booster', name: managed.name, roleId: managed.id });
        continue;
      }
    }
    const nameMatch = (r: RoleInfo) => r.name === bp.name && !r.managed;
    const orphan = findOrphan(snapshot.roles, row, rows, nameMatch);
    if (orphan) {
      items.push({ op: 'adopt_role', key: bp.key, name: bp.name, roleId: orphan.id, reason: 'orphan' });
      continue;
    }
    const foreign = snapshot.roles.find((r) => nameMatch(r) && !isRegisteredId(rows, r.id));
    if (foreign) {
      if (options.adoptForeign && foreign.position < botTop) {
        items.push({ op: 'adopt_role', key: bp.key, name: bp.name, roleId: foreign.id, reason: 'foreign' });
        continue;
      }
      warnings.push(
        options.adoptForeign
          ? `Rolle **${bp.name}** existiert bereits, steht aber über der Bot-Rolle und wird daher nicht übernommen. Es wird eine neue Rolle erstellt.`
          : `Rolle **${bp.name}** existiert bereits (nicht vom Bot). Sie wird **nicht** übernommen; es wird eine eigene Rolle erstellt. Zum Übernehmen: \`/setup start fremde_uebernehmen:true\`.`,
      );
    }
    items.push({ op: 'create_role', key: bp.key, name: bp.name, recreate });
    anyRoleCreated = true;
  }

  // Rollenreihenfolge
  const ourRoles = ROLES.map((bp) => {
    const row = rowOf(roleResKey(bp.key));
    return row?.status === 'done' ? roleById(row.discord_id) : undefined;
  });
  const orderable = ourRoles.filter((r): r is RoleInfo => r !== undefined && !r.managed);
  const inOrder = orderable.every((r, i) => i === 0 || (orderable[i - 1]?.position ?? 0) > r.position);
  if (anyRoleCreated || (!inOrder && options.correct) || items.some((i) => i.op === 'adopt_role')) {
    items.push({ op: 'reorder_roles' });
  } else if (!inOrder) {
    warnings.push('Die Reihenfolge der KSA-Rollen weicht vom Bauplan ab (Korrektur mit `korrigieren:true`).');
  }

  // 3) Kategorien und Kanäle
  const roleIdsForOw: Partial<Record<RoleKey, string>> = {};
  for (const bp of ROLES) {
    const id = ctx.registry.roleId(bp.key);
    if (id) roleIdsForOw[bp.key] = id;
  }
  const owCtx: OverwriteContext = {
    guildId: snapshot.id,
    botUserId: snapshot.bot.userId,
    roles: roleIdsForOw,
    requireRulesAcceptance: ctx.settings.get('community.requireRulesAcceptance'),
  };
  // Overwrite-Vergleiche sind nur aussagekräftig, wenn alle Rollen existieren.
  const rolesComplete = !items.some((i) => i.op === 'create_role' || i.op === 'adopt_role');
  const channelById = (id: string | null | undefined) => (id ? snapshot.channels.find((c) => c.id === id) : undefined);

  const categoryIdNow: Partial<Record<CategoryKey, string>> = {};
  for (const bp of CATEGORIES) {
    const key = categoryResKey(bp.key);
    const row = rowOf(key);
    const existing = row?.status === 'done' ? channelById(row.discord_id) : undefined;
    if (existing && existing.kind === 'category') {
      categoryIdNow[bp.key] = existing.id;
      const changes: ('name' | 'overwrites')[] = [];
      if (existing.name !== bp.name) changes.push('name');
      if (rolesComplete && !overwritesEqual(existing.overwrites, overwritesFor(bp.profile, owCtx))) changes.push('overwrites');
      if (changes.length) {
        if (options.correct) items.push({ op: 'fix_channel', key: bp.key, isCategory: true, channelId: existing.id, changes });
        else warnings.push(`Kategorie **${existing.name}** weicht ab (${changes.map(changeLabel).join(', ')}).`);
      }
      continue;
    }
    const match = (c: ChannelInfo) => c.kind === 'category' && c.name.toLowerCase() === bp.name.toLowerCase();
    const orphan = findOrphan(snapshot.channels, row, rows, match);
    if (orphan) {
      items.push({ op: 'adopt_category', key: bp.key, name: bp.name, channelId: orphan.id, reason: 'orphan' });
      categoryIdNow[bp.key] = orphan.id;
      continue;
    }
    const foreign = snapshot.channels.find((c) => match(c) && !isRegisteredId(rows, c.id));
    if (foreign) {
      if (options.adoptForeign) {
        items.push({ op: 'adopt_category', key: bp.key, name: bp.name, channelId: foreign.id, reason: 'foreign' });
        categoryIdNow[bp.key] = foreign.id;
        continue;
      }
      warnings.push(`Kategorie **${bp.name}** existiert bereits (nicht vom Bot) und wird nicht übernommen. Es wird eine eigene Kategorie erstellt.`);
    }
    items.push({ op: 'create_category', key: bp.key, name: bp.name, recreate: row?.status === 'done' });
  }

  for (const bp of CHANNELS) {
    const key = channelResKey(bp.key);
    const row = rowOf(key);
    const existing = row?.status === 'done' ? channelById(row.discord_id) : undefined;
    const parentId = categoryIdNow[bp.parent];
    if (existing && existing.kind === bp.kind) {
      const changes: ('parent' | 'name' | 'overwrites')[] = [];
      if (parentId && existing.parentId !== parentId) changes.push('parent');
      if (normalizeChannelName(existing.name, bp.kind) !== normalizeChannelName(bp.name, bp.kind)) changes.push('name');
      if (rolesComplete && !overwritesEqual(existing.overwrites, overwritesFor(bp.profile, owCtx))) changes.push('overwrites');
      if (changes.length) {
        if (options.correct) items.push({ op: 'fix_channel', key: bp.key, isCategory: false, channelId: existing.id, changes });
        else warnings.push(`Kanal **${existing.name}** weicht ab (${changes.map(changeLabel).join(', ')}).`);
      }
      continue;
    }
    const match = (c: ChannelInfo) =>
      c.kind === bp.kind && normalizeChannelName(c.name, bp.kind) === normalizeChannelName(bp.name, bp.kind);
    const orphan = findOrphan(snapshot.channels, row, rows, (c) => match(c) && (!parentId || c.parentId === parentId));
    if (orphan) {
      items.push({ op: 'adopt_channel', key: bp.key, name: bp.name, channelId: orphan.id, reason: 'orphan' });
      continue;
    }
    const foreign = snapshot.channels.find((c) => match(c) && !isRegisteredId(rows, c.id));
    if (foreign) {
      if (options.adoptForeign) {
        items.push({ op: 'adopt_channel', key: bp.key, name: bp.name, channelId: foreign.id, reason: 'foreign' });
        continue;
      }
      warnings.push(`Kanal **${foreign.name}** existiert bereits (nicht vom Bot) und wird nicht übernommen. Es wird ein eigener Kanal erstellt.`);
    }
    items.push({ op: 'create_channel', key: bp.key, name: bp.name, parent: bp.parent, recreate: row?.status === 'done' });
  }

  // 4) Founder-Rolle an die konfigurierten Founder vergeben
  const founderRoleId = ctx.registry.roleId('founder');
  const toAssign: string[] = [];
  for (const userId of ctx.config.ownerIds) {
    const member = await ctx.port.fetchMember(userId);
    if (!member) {
      warnings.push(`Founder <@${userId}> ist (noch) kein Mitglied des Servers – Rolle wird später beim nächsten Setup vergeben.`);
      continue;
    }
    if (!founderRoleId || !member.roleIds.includes(founderRoleId)) toAssign.push(userId);
  }
  if (toAssign.length) items.push({ op: 'assign_founder_role', userIds: toAssign });

  // 5) Panels
  const panelCtx = buildPanelContext(ctx, snapshot);
  for (const panel of PANELS) {
    const row = rowOf(panelResKey(panel.key));
    const channelRow = rowOf(channelResKey(panel.channel));
    const channelExists = channelRow?.status === 'done' && channelById(channelRow.discord_id);
    if (row?.status === 'done' && row.discord_id && row.channel_id && channelExists && row.channel_id === channelRow?.discord_id) {
      const msg = await ctx.port.fetchMessage(row.channel_id, row.discord_id);
      if (msg) {
        if (!panel.live && row.content_hash !== hashObject(panel.render(panelCtx))) {
          items.push({ op: 'update_panel', key: panel.key, channel: panel.channel, messageId: row.discord_id });
        }
        continue;
      }
      items.push({ op: 'post_panel', key: panel.key, channel: panel.channel, repost: true });
      continue;
    }
    items.push({ op: 'post_panel', key: panel.key, channel: panel.channel, repost: row?.status === 'done' });
  }

  // 6) AutoMod
  if (hasManageGuild) {
    const rules = await ctx.port.listAutoModRules().catch(() => null);
    if (rules === null) {
      warnings.push('AutoMod-Regeln konnten nicht gelesen werden – AutoMod wird übersprungen.');
    } else {
      for (const bp of AUTOMOD_RULES) {
        const row = rowOf(automodResKey(bp.key));
        if (row?.status === 'done' && rules.some((r) => r.id === row.discord_id)) continue;
        const own = rules.find((r) => r.name === bp.name && r.creatorId === snapshot.bot.userId);
        if (own) {
          items.push({ op: 'adopt_automod', key: bp.key, name: bp.name, ruleId: own.id });
          continue;
        }
        if (bp.singleton && rules.some((r) => r.triggerType === bp.triggerType)) {
          warnings.push(`AutoMod: Es existiert bereits eine Regel dieses Typs (${bp.name}). Discord erlaubt nur eine – übersprungen.`);
          continue;
        }
        items.push({ op: 'create_automod', key: bp.key, name: bp.name });
      }
    }
    const afkRow = rowOf(channelResKey('v_afk'));
    if (!afkRow || afkRow.status !== 'done' || snapshot.afkChannelId !== afkRow.discord_id) {
      items.push({ op: 'set_afk' });
    }
  } else {
    warnings.push('Ohne das Recht „Server verwalten“ werden AutoMod-Regeln und der AFK-Kanal nicht eingerichtet (optional).');
  }

  if (missingOptional.length) {
    warnings.push(`Optionale Rechte fehlen: ${missingOptional.join(', ')}. Die zugehörigen Funktionen werden übersprungen.`);
  }
  if ((snapshot.systemChannelFlags & 2) === 2) {
    warnings.push('In den Servereinstellungen sind Boost-Systemnachrichten deaktiviert. Danksagungen erfolgen dann nur beim Beginn eines Boost-Status (siehe /serverboost status).');
  }

  // Die Bestätigung gilt genau für das, was angezeigt wurde – inkl. Hinweisen.
  const hash = hashObject({ guild: snapshot.id, options, items, blockers, warnings });
  return { guildId: snapshot.id, options, items, warnings, blockers, missingOptional, hash };
}

function changeLabel(c: 'parent' | 'name' | 'overwrites'): string {
  return c === 'parent' ? 'verschoben' : c === 'name' ? 'umbenannt' : 'Rechte geändert';
}

/** Menschlich lesbare Zeilen für die Vorschau. */
export function describePlanItem(item: PlanItem): string {
  switch (item.op) {
    case 'create_role':
      return `Rolle erstellen: **${item.name}**${item.recreate ? ' (wurde gelöscht – neu)' : ''}`;
    case 'adopt_role':
      return `Rolle übernehmen: **${item.name}** (${item.reason === 'orphan' ? 'aus abgebrochenem Lauf' : 'bestehende, gleichnamige Rolle'})`;
    case 'link_managed_booster':
      return `Discord-verwaltete Booster-Rolle **${item.name}** verknüpfen (wird nicht verändert)`;
    case 'reorder_roles':
      return 'Rollenreihenfolge unterhalb der Bot-Rolle anordnen';
    case 'create_category':
      return `Kategorie erstellen: **${item.name}**${item.recreate ? ' (wurde gelöscht – neu)' : ''}`;
    case 'adopt_category':
      return `Kategorie übernehmen: **${item.name}** (${item.reason === 'orphan' ? 'aus abgebrochenem Lauf' : 'bestehend'}) – Rechte werden gesetzt`;
    case 'create_channel':
      return `Kanal erstellen: **${item.name}**${item.recreate ? ' (wurde gelöscht – neu)' : ''}`;
    case 'adopt_channel':
      return `Kanal übernehmen: **${item.name}** (${item.reason === 'orphan' ? 'aus abgebrochenem Lauf' : 'bestehend'}) – Kategorie und Rechte werden gesetzt`;
    case 'fix_channel':
      return `${item.isCategory ? 'Kategorie' : 'Kanal'} korrigieren: <#${item.channelId}> (${item.changes.map(changeLabel).join(', ')})`;
    case 'assign_founder_role':
      return `Rolle KSA Founder vergeben an: ${item.userIds.map((u) => `<@${u}>`).join(', ')}`;
    case 'post_panel':
      return `Panel posten: **${item.key}**${item.repost ? ' (fehlte – neu)' : ''}`;
    case 'update_panel':
      return `Panel aktualisieren: **${item.key}** (Inhalt geändert)`;
    case 'create_automod':
      return `AutoMod-Regel erstellen: **${item.name}**`;
    case 'adopt_automod':
      return `AutoMod-Regel übernehmen: **${item.name}** (vom Bot erstellt)`;
    case 'set_afk':
      return 'AFK-Kanal in den Servereinstellungen setzen (💤 AFK, 5 Minuten)';
  }
}
