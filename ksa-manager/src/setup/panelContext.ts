import type { PanelContext } from '../content/panels.js';
import type { GuildSnapshot } from '../discord/port.js';
import type { AppContext } from '../services/context.js';
import { CHANNEL_KEYS, ROLE_KEYS, type ChannelKey, type RoleKey } from './blueprint.js';

/** Baut den Kontext zum Rendern der Panels aus gespeicherten IDs und Einstellungen. */
export function buildPanelContext(ctx: AppContext, snapshot: GuildSnapshot | null): PanelContext {
  const channels: Partial<Record<ChannelKey, string>> = {};
  for (const k of CHANNEL_KEYS) {
    const id = ctx.registry.channelId(k);
    if (id) channels[k] = id;
  }
  const roles: Partial<Record<RoleKey, string>> = {};
  for (const k of ROLE_KEYS) {
    const id = ctx.registry.roleId(k);
    if (id) roles[k] = id;
  }
  const boosterId = roles.booster ?? null;
  const boosterInfo = boosterId && snapshot ? snapshot.roles.find((r) => r.id === boosterId) : undefined;
  const s = ctx.settings;
  return {
    guildId: ctx.config.guildId,
    channels,
    roles,
    booster: {
      roleId: boosterId && (!snapshot || boosterInfo) ? boosterId : null,
      hoist: boosterInfo?.hoist ?? false,
      managed: ctx.registry.get('role:booster')?.managed_by_discord === 1,
    },
    settings: {
      maxOpenTickets: s.get('tickets.maxOpenPerUser'),
      requireRulesAcceptance: s.get('community.requireRulesAcceptance'),
      warzoneRanks: s.get('games.warzone.ranks'),
      multiplayerRanks: s.get('games.multiplayer.ranks'),
      season: s.get('games.season'),
      extraBoostPerks: s.get('boost.extraPerks'),
    },
    logoUrl: ctx.config.logoUrl,
  };
}
