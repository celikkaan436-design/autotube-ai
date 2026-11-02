import { PermissionFlagsBits as P } from 'discord.js';
import { COLORS } from '../domain/constants.js';
import type { OverwriteSpec } from '../discord/port.js';

/**
 * Bauplan des Servers. Schlüssel sind stabil und werden mit den Discord-IDs in
 * setup_resources gespeichert. Namen dürfen sich ändern, Schlüssel nicht.
 */

export const ROLE_KEYS = [
  'founder',
  'admin',
  'support',
  'operator',
  'booster',
  'customer',
  'community',
  'warzone',
  'multiplayer',
] as const;
export type RoleKey = (typeof ROLE_KEYS)[number];

export interface RoleBlueprint {
  key: RoleKey;
  name: string;
  color: number;
  hoist: boolean;
  /** Rollen werden nie erwähnbar gemacht; der Bot pingt gezielt per allowedMentions. */
  mentionable: false;
  description: string;
}

/** Reihenfolge = gewünschte Hierarchie von oben nach unten (unterhalb der Bot-Rolle). */
export const ROLES: readonly RoleBlueprint[] = [
  { key: 'founder', name: 'KSA Founder', color: COLORS.accentDark, hoist: true, mentionable: false, description: 'Gründer – gesamte Bot-Verwaltung (Bot-Rechte nur über OWNER_IDS)' },
  { key: 'admin', name: 'KSA Admin', color: 0xd32f2f, hoist: true, mentionable: false, description: 'Operative Verwaltung' },
  { key: 'support', name: 'KSA Support', color: COLORS.accent, hoist: true, mentionable: false, description: 'Anfragen und Tickets verwalten und zuweisen' },
  { key: 'operator', name: 'KSA Operator', color: 0xef5350, hoist: true, mentionable: false, description: 'Bearbeitet ausschließlich zugewiesene Ranked-Aufträge' },
  { key: 'booster', name: 'Server Booster', color: COLORS.booster, hoist: true, mentionable: false, description: 'Kosmetisch – nur für Mitglieder, die den Discord-Server boosten' },
  { key: 'customer', name: 'Kunde', color: 0x9e9e9e, hoist: false, mentionable: false, description: 'Mitglieder mit mindestens einem angenommenen Auftrag' },
  { key: 'community', name: 'Community', color: 0, hoist: false, mentionable: false, description: 'Regeln akzeptiert – Zugriff auf öffentliche Bereiche' },
  { key: 'warzone', name: 'Warzone', color: 0, hoist: false, mentionable: false, description: 'Interessenrolle ohne Rechte' },
  { key: 'multiplayer', name: 'Multiplayer', color: 0, hoist: false, mentionable: false, description: 'Interessenrolle ohne Rechte' },
];

export const STAFF_ROLE_KEYS = ['founder', 'admin', 'support', 'operator'] as const;

export const CATEGORY_KEYS = [
  'start',
  'ranked',
  'support',
  'boosts',
  'community',
  'voice',
  'team',
  'tickets_open',
  'tickets_archive',
] as const;
export type CategoryKey = (typeof CATEGORY_KEYS)[number];

/** Rechteprofile beschreiben, wer was sehen/schreiben darf. */
export type Profile =
  | 'public_readonly' // START: für alle sichtbar, nur Team schreibt
  | 'gated_readonly' // nach Regelbestätigung sichtbar, nur Team schreibt
  | 'gated_open' // nach Regelbestätigung sichtbar, alle schreiben
  | 'staff_open' // alle Teamrollen inkl. Operator
  | 'staff_readonly' // alle Teamrollen sehen, nur Bot schreibt
  | 'support_open' // Support, Admin, Founder
  | 'support_readonly' // Support, Admin, Founder sehen, nur Bot schreibt
  | 'tickets'; // Ticket-Kategorien: Support, Admin, Founder

export interface CategoryBlueprint {
  key: CategoryKey;
  name: string;
  profile: Profile;
}

export const CATEGORIES: readonly CategoryBlueprint[] = [
  { key: 'start', name: 'START', profile: 'public_readonly' },
  { key: 'ranked', name: 'RANKED-SERVICE', profile: 'gated_readonly' },
  { key: 'support', name: 'SUPPORT', profile: 'gated_readonly' },
  { key: 'boosts', name: 'DISCORD-BOOSTS', profile: 'gated_readonly' },
  { key: 'community', name: 'COMMUNITY', profile: 'gated_open' },
  { key: 'voice', name: 'SPRACHKANÄLE', profile: 'gated_open' },
  { key: 'team', name: 'TEAM INTERN', profile: 'staff_open' },
  { key: 'tickets_open', name: 'OFFENE TICKETS', profile: 'tickets' },
  { key: 'tickets_archive', name: 'ARCHIVIERTE TICKETS', profile: 'tickets' },
];

export const CHANNEL_KEYS = [
  'willkommen',
  'regeln',
  'ankuendigungen',
  'rollen',
  'faq',
  'warzone',
  'multiplayer',
  'preise',
  'ablauf',
  'proofs',
  'bewertungen',
  'ticket_erstellen',
  'server_boosten',
  'boost_danke',
  'allgemein',
  'mitspieler',
  'clips',
  'bot_befehle',
  'v_community',
  'v_warzone1',
  'v_warzone2',
  'v_multiplayer1',
  'v_multiplayer2',
  'v_afk',
  'auftraege',
  'teamchat',
  'teamlog',
  'proofpruefung',
  'botstatus',
  'v_team',
] as const;
export type ChannelKey = (typeof CHANNEL_KEYS)[number];

export interface ChannelBlueprint {
  key: ChannelKey;
  name: string;
  kind: 'text' | 'voice';
  parent: CategoryKey;
  topic?: string;
  profile: Profile;
}

export const CHANNELS: readonly ChannelBlueprint[] = [
  { key: 'willkommen', name: '👋・willkommen', kind: 'text', parent: 'start', profile: 'public_readonly', topic: 'Willkommen bei KSA Boosting – hier geht es los.' },
  { key: 'regeln', name: '📜・regeln', kind: 'text', parent: 'start', profile: 'public_readonly', topic: 'Serverregeln. Bitte lesen und bestätigen.' },
  { key: 'ankuendigungen', name: '📢・ankündigungen', kind: 'text', parent: 'start', profile: 'public_readonly', topic: 'Offizielle Ankündigungen des KSA-Teams.' },
  { key: 'rollen', name: '🎭・rollen', kind: 'text', parent: 'start', profile: 'public_readonly', topic: 'Interessenrollen per Button wählen.' },
  { key: 'faq', name: '❓・faq', kind: 'text', parent: 'start', profile: 'public_readonly', topic: 'Antworten auf häufige Fragen.' },

  { key: 'warzone', name: '🪂・warzone-ranked', kind: 'text', parent: 'ranked', profile: 'gated_readonly', topic: 'Angebot: Call of Duty Warzone Ranked – Preise auf Anfrage.' },
  { key: 'multiplayer', name: '🎯・multiplayer-ranked', kind: 'text', parent: 'ranked', profile: 'gated_readonly', topic: 'Angebot: Call of Duty Multiplayer Ranked – Preise auf Anfrage.' },
  { key: 'preise', name: '💶・preise-und-anfragen', kind: 'text', parent: 'ranked', profile: 'gated_readonly', topic: 'Preise auf Anfrage – so bekommst du ein Angebot.' },
  { key: 'ablauf', name: '📌・ablauf', kind: 'text', parent: 'ranked', profile: 'gated_readonly', topic: 'So läuft ein Auftrag ab – von der Anfrage bis zum Abschluss.' },
  { key: 'proofs', name: '📸・proofs', kind: 'text', parent: 'ranked', profile: 'gated_readonly', topic: 'Freigegebene Ergebnisse abgeschlossener Aufträge.' },
  { key: 'bewertungen', name: '⭐・bewertungen', kind: 'text', parent: 'ranked', profile: 'gated_readonly', topic: 'Bewertungen verifizierter Kunden.' },

  { key: 'ticket_erstellen', name: '🎫・ticket-erstellen', kind: 'text', parent: 'support', profile: 'gated_readonly', topic: 'Hier öffnest du ein privates Ticket.' },

  { key: 'server_boosten', name: '💎・server-boosten', kind: 'text', parent: 'boosts', profile: 'gated_readonly', topic: 'Discord-Serverboosts – getrennt von Ranked-Aufträgen.' },
  { key: 'boost_danke', name: '🎉・boost-danke', kind: 'text', parent: 'boosts', profile: 'gated_readonly', topic: 'Danke an alle, die den Server boosten.' },

  { key: 'allgemein', name: '💬・allgemein', kind: 'text', parent: 'community', profile: 'gated_open', topic: 'Allgemeiner Chat der Community.' },
  { key: 'mitspieler', name: '🔎・mitspieler-suche', kind: 'text', parent: 'community', profile: 'gated_open', topic: 'Mitspieler für Warzone und Multiplayer finden.' },
  { key: 'clips', name: '🎬・clips', kind: 'text', parent: 'community', profile: 'gated_open', topic: 'Eure besten Clips.' },
  { key: 'bot_befehle', name: '🤖・bot-befehle', kind: 'text', parent: 'community', profile: 'gated_open', topic: 'Bot-Befehle wie /help nutzen.' },

  { key: 'v_community', name: '🔊 Community', kind: 'voice', parent: 'voice', profile: 'gated_open' },
  { key: 'v_warzone1', name: '🪂 Warzone 1', kind: 'voice', parent: 'voice', profile: 'gated_open' },
  { key: 'v_warzone2', name: '🪂 Warzone 2', kind: 'voice', parent: 'voice', profile: 'gated_open' },
  { key: 'v_multiplayer1', name: '🎯 Multiplayer 1', kind: 'voice', parent: 'voice', profile: 'gated_open' },
  { key: 'v_multiplayer2', name: '🎯 Multiplayer 2', kind: 'voice', parent: 'voice', profile: 'gated_open' },
  { key: 'v_afk', name: '💤 AFK', kind: 'voice', parent: 'voice', profile: 'gated_open' },

  { key: 'auftraege', name: '📋・auftragsübersicht', kind: 'text', parent: 'team', profile: 'staff_readonly', topic: 'Automatische Übersicht aktiver Aufträge (ohne Kundendaten).' },
  { key: 'teamchat', name: '💬・teamchat', kind: 'text', parent: 'team', profile: 'staff_open', topic: 'Interner Austausch des Teams.' },
  { key: 'teamlog', name: '🧾・team-log', kind: 'text', parent: 'team', profile: 'support_readonly', topic: 'Protokoll wichtiger Bot-Aktionen.' },
  { key: 'proofpruefung', name: '🔍・proof-prüfung', kind: 'text', parent: 'team', profile: 'support_open', topic: 'Proofs prüfen und freigeben.' },
  { key: 'botstatus', name: '⚙️・bot-status', kind: 'text', parent: 'team', profile: 'support_readonly', topic: 'Start, Diagnose und Hinweise des Bots.' },
  { key: 'v_team', name: '🔒 Team Voice', kind: 'voice', parent: 'team', profile: 'staff_open' },
];

// ---------------------------------------------------------------------------
// Rechte
// ---------------------------------------------------------------------------

/** Rechte, die der Bot zwingend braucht. Kein Administrator. */
export const REQUIRED_BOT_PERMISSIONS: readonly { flag: bigint; name: string; why: string }[] = [
  { flag: P.ViewChannel, name: 'Kanäle ansehen', why: 'Kanäle lesen und Panels posten' },
  { flag: P.ManageChannels, name: 'Kanäle verwalten', why: 'Kategorien, Kanäle und Ticketkanäle anlegen/verschieben' },
  { flag: P.ManageRoles, name: 'Rollen verwalten', why: 'Rollen anlegen/vergeben und Kanalrechte setzen' },
  { flag: P.SendMessages, name: 'Nachrichten senden', why: 'Panels, Tickets, Proofs, Danksagungen' },
  { flag: P.SendMessagesInThreads, name: 'Nachrichten in Threads senden', why: 'nötig, um es in schreibgeschützten Kanälen zu entziehen' },
  { flag: P.CreatePublicThreads, name: 'Öffentliche Threads erstellen', why: 'nötig, um es in schreibgeschützten Kanälen zu entziehen' },
  { flag: P.CreatePrivateThreads, name: 'Private Threads erstellen', why: 'nötig, um es in schreibgeschützten Kanälen zu entziehen' },
  { flag: P.EmbedLinks, name: 'Links einbetten', why: 'Embeds für Panels und Zusammenfassungen' },
  { flag: P.AttachFiles, name: 'Dateien anhängen', why: 'Proof-Bilder erneut hochladen, Exporte' },
  { flag: P.ReadMessageHistory, name: 'Nachrichtenverlauf lesen', why: 'Panels aktualisieren, Ticket-Exporte' },
  { flag: P.MentionEveryone, name: 'Alle Rollen erwähnen', why: 'gezielter Ping von @KSA Support in neuen Tickets (Rollen bleiben nicht erwähnbar; @everyone/@here technisch gesperrt)' },
];

/** Optionale Rechte – fehlen sie, wird die jeweilige Funktion übersprungen. */
export const OPTIONAL_BOT_PERMISSIONS: readonly { flag: bigint; name: string; why: string }[] = [
  { flag: P.ManageGuild, name: 'Server verwalten', why: 'AutoMod-Regeln anlegen und AFK-Kanal setzen' },
  { flag: P.ModerateMembers, name: 'Mitglieder im Timeout', why: 'Flood-Schutz: kurzer Timeout bei Spam' },
  { flag: P.ManageMessages, name: 'Nachrichten verwalten', why: 'Flood-Schutz: Spam-Nachrichten löschen' },
];

export const REQUIRED_PERMISSION_BITS = REQUIRED_BOT_PERMISSIONS.reduce((a, p) => a | p.flag, 0n);
export const RECOMMENDED_PERMISSION_BITS = OPTIONAL_BOT_PERMISSIONS.reduce((a, p) => a | p.flag, REQUIRED_PERMISSION_BITS);

const VIEW = P.ViewChannel;
const WRITE = P.SendMessages | P.EmbedLinks | P.AttachFiles | P.ReadMessageHistory;
const READONLY_DENY = P.SendMessages | P.SendMessagesInThreads | P.CreatePublicThreads | P.CreatePrivateThreads;
export const BOT_CHANNEL_ALLOW = VIEW | WRITE;
export const TICKET_MEMBER_ALLOW = VIEW | WRITE;

export interface OverwriteContext {
  guildId: string;
  botUserId: string;
  roles: Partial<Record<RoleKey, string>>;
  requireRulesAcceptance: boolean;
}

function roleOw(id: string | undefined, allow: bigint, deny = 0n): OverwriteSpec[] {
  return id ? [{ id, type: 'role', allow, deny }] : [];
}

/** Berechnet die vollständigen Overwrites für ein Profil. Werden explizit gesetzt, nie synchronisiert. */
export function overwritesFor(profile: Profile, ctx: OverwriteContext): OverwriteSpec[] {
  const r = ctx.roles;
  const bot: OverwriteSpec = { id: ctx.botUserId, type: 'member', allow: BOT_CHANNEL_ALLOW, deny: 0n };
  const everyone = (allow: bigint, deny: bigint): OverwriteSpec => ({ id: ctx.guildId, type: 'role', allow, deny });
  const staffAll = [r.founder, r.admin, r.support, r.operator];
  const staffSupport = [r.founder, r.admin, r.support];

  switch (profile) {
    case 'public_readonly':
      return [
        everyone(0n, READONLY_DENY),
        ...roleOw(r.founder, P.SendMessages),
        ...roleOw(r.admin, P.SendMessages),
        bot,
      ];
    case 'gated_readonly':
      if (ctx.requireRulesAcceptance) {
        return [
          everyone(0n, VIEW | READONLY_DENY),
          ...roleOw(r.community, VIEW),
          ...roleOw(r.founder, VIEW | P.SendMessages),
          ...roleOw(r.admin, VIEW | P.SendMessages),
          ...roleOw(r.support, VIEW),
          ...roleOw(r.operator, VIEW),
          bot,
        ];
      }
      return [
        everyone(0n, READONLY_DENY),
        ...roleOw(r.founder, P.SendMessages),
        ...roleOw(r.admin, P.SendMessages),
        bot,
      ];
    case 'gated_open':
      if (ctx.requireRulesAcceptance) {
        return [
          everyone(0n, VIEW),
          ...roleOw(r.community, VIEW),
          ...staffAll.flatMap((id) => roleOw(id, VIEW)),
          bot,
        ];
      }
      return [bot];
    case 'staff_open':
      return [everyone(0n, VIEW), ...staffAll.flatMap((id) => roleOw(id, VIEW)), bot];
    case 'staff_readonly':
      return [everyone(0n, VIEW | READONLY_DENY), ...staffAll.flatMap((id) => roleOw(id, VIEW)), bot];
    case 'support_open':
      return [everyone(0n, VIEW), ...staffSupport.flatMap((id) => roleOw(id, VIEW)), bot];
    case 'support_readonly':
      return [everyone(0n, VIEW | READONLY_DENY), ...staffSupport.flatMap((id) => roleOw(id, VIEW)), bot];
    case 'tickets':
      return [everyone(0n, VIEW), ...staffSupport.flatMap((id) => roleOw(id, VIEW | WRITE)), bot];
  }
}

/** Overwrites eines Ticketkanals – vollständig explizit, ohne Kategorie-Synchronisierung. */
export function ticketOverwrites(
  ctx: Omit<OverwriteContext, 'requireRulesAcceptance'>,
  customerId: string | null,
  operatorId: string | null,
): OverwriteSpec[] {
  const r = ctx.roles;
  const list: OverwriteSpec[] = [
    { id: ctx.guildId, type: 'role', allow: 0n, deny: VIEW },
    { id: ctx.botUserId, type: 'member', allow: BOT_CHANNEL_ALLOW, deny: 0n },
    ...[r.founder, r.admin, r.support].flatMap((id) => roleOw(id, VIEW | WRITE)),
  ];
  if (customerId) list.push({ id: customerId, type: 'member', allow: TICKET_MEMBER_ALLOW, deny: 0n });
  if (operatorId && operatorId !== customerId) {
    list.push({ id: operatorId, type: 'member', allow: TICKET_MEMBER_ALLOW, deny: 0n });
  }
  return list;
}

/** Vergleicht Overwrites inhaltlich (Reihenfolge egal). */
export function overwritesEqual(a: readonly OverwriteSpec[], b: readonly OverwriteSpec[]): boolean {
  const norm = (l: readonly OverwriteSpec[]) =>
    l
      .filter((o) => o.allow !== 0n || o.deny !== 0n)
      .map((o) => `${o.type}:${o.id}:${o.allow.toString()}:${o.deny.toString()}`)
      .sort()
      .join('|');
  return norm(a) === norm(b);
}

/** Text-Kanalnamen normalisiert Discord (Kleinschreibung, Leerzeichen → Bindestrich). */
export function normalizeChannelName(name: string, kind: 'text' | 'voice' | 'category'): string {
  if (kind !== 'text') return name.trim().toLowerCase();
  return name.trim().toLowerCase().replace(/\s+/g, '-');
}

export function categoryBlueprint(key: CategoryKey): CategoryBlueprint {
  const c = CATEGORIES.find((x) => x.key === key);
  if (!c) throw new Error(`Unbekannte Kategorie ${key}`);
  return c;
}

export function channelBlueprint(key: ChannelKey): ChannelBlueprint {
  const c = CHANNELS.find((x) => x.key === key);
  if (!c) throw new Error(`Unbekannter Kanal ${key}`);
  return c;
}
