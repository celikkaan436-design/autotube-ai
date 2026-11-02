import type { APIActionRowComponent, APIComponentInMessageActionRow, APIEmbed } from 'discord.js';

/**
 * Discord-Port: alle Seiteneffekte gegenüber Discord laufen über dieses Interface.
 * Produktion: discord.js-Implementierung (djsPort.ts). Tests: In-Memory-Fake.
 * Der Port arbeitet ausschließlich auf dem konfigurierten Zielserver.
 */

export type ChannelKind = 'category' | 'text' | 'voice' | 'other';

export interface OverwriteSpec {
  id: string;
  type: 'role' | 'member';
  allow: bigint;
  deny: bigint;
}

export interface RoleInfo {
  id: string;
  name: string;
  position: number;
  managed: boolean;
  /** Von Discord verwaltete Server-Booster-Rolle (role.tags.premium_subscriber). */
  isBoosterRole: boolean;
  /** Integrationsrolle eines Bots. */
  botId: string | null;
  color: number;
  hoist: boolean;
  mentionable: boolean;
  permissions: bigint;
}

export interface ChannelInfo {
  id: string;
  name: string;
  kind: ChannelKind;
  parentId: string | null;
  topic: string | null;
  overwrites: OverwriteSpec[];
}

export interface GuildSnapshot {
  id: string;
  name: string;
  ownerId: string;
  roles: RoleInfo[];
  channels: ChannelInfo[];
  bot: {
    userId: string;
    /** Effektive Server-Rechte des Bots. */
    permissions: bigint;
    highestRolePosition: number;
    roleIds: string[];
  };
  premiumTier: number;
  premiumSubscriptionCount: number | null;
  systemChannelId: string | null;
  systemChannelFlags: number;
  afkChannelId: string | null;
}

export interface MemberInfo {
  userId: string;
  displayName: string;
  roleIds: string[];
  /** Zeitpunkt (ms), seit dem das Mitglied boostet – null, wenn nicht. */
  premiumSince: number | null;
  isBot: boolean;
}

export interface AttachmentInfo {
  id: string;
  name: string;
  url: string;
  contentType: string | null;
  size: number;
}

export interface MessageInfo {
  id: string;
  channelId: string;
  authorId: string;
  authorName: string;
  authorIsBot: boolean;
  createdAt: number;
  type: number;
  content: string;
  attachments: AttachmentInfo[];
  embeds: { title: string | null; description: string | null; footer: string | null }[];
}

export interface FileData {
  name: string;
  data: Buffer;
  description?: string;
}

export interface MessagePayload {
  content?: string;
  embeds?: APIEmbed[];
  components?: APIActionRowComponent<APIComponentInMessageActionRow>[];
  files?: FileData[];
  /** Standard: keinerlei Erwähnungen. Nur ausdrücklich gelistete IDs pingen. */
  allowedMentions?: { users?: string[]; roles?: string[] };
  nonce?: string;
  enforceNonce?: boolean;
}

export interface CreateRoleSpec {
  name: string;
  color: number;
  hoist: boolean;
  mentionable: boolean;
  permissions: bigint;
  reason: string;
}

export interface CreateChannelSpec {
  name: string;
  kind: 'category' | 'text' | 'voice';
  parentId: string | null;
  topic?: string;
  overwrites: OverwriteSpec[];
  reason: string;
}

export interface ChannelPatch {
  name?: string;
  topic?: string | null;
  /** Kategorie wechseln OHNE Rechte zu synchronisieren (lockPermissions: false). */
  parentId?: string | null;
  overwrites?: OverwriteSpec[];
  reason: string;
}

export interface AutoModRuleInfo {
  id: string;
  name: string;
  triggerType: number;
  creatorId: string;
}

export interface AutoModRuleSpec {
  name: string;
  /** 1 = MESSAGE_SEND */
  eventType: number;
  triggerType: number;
  triggerMetadata: Record<string, unknown>;
  actions: { type: number; metadata?: Record<string, unknown> }[];
  exemptRoles: string[];
  reason: string;
}

export interface DiscordPort {
  readonly guildId: string;
  /** Nutzer-ID des Bots (nach dem Login bekannt). */
  botUserId(): string;
  snapshot(): Promise<GuildSnapshot>;

  createRole(spec: CreateRoleSpec): Promise<string>;
  setRolePositions(positions: { id: string; position: number }[], reason: string): Promise<void>;
  addRole(userId: string, roleId: string, reason: string): Promise<void>;
  removeRole(userId: string, roleId: string, reason: string): Promise<void>;

  createChannel(spec: CreateChannelSpec): Promise<string>;
  editChannel(channelId: string, patch: ChannelPatch): Promise<void>;
  setOverwrite(channelId: string, overwrite: OverwriteSpec, reason: string): Promise<void>;
  removeOverwrite(channelId: string, targetId: string, reason: string): Promise<void>;
  deleteChannel(channelId: string, reason: string): Promise<boolean>;
  getChannel(channelId: string): Promise<ChannelInfo | null>;

  sendMessage(channelId: string, payload: MessagePayload): Promise<string>;
  editMessage(channelId: string, messageId: string, payload: MessagePayload): Promise<void>;
  /** true = gelöscht, false = existierte nicht mehr. */
  deleteMessage(channelId: string, messageId: string): Promise<boolean>;
  fetchMessage(channelId: string, messageId: string): Promise<MessageInfo | null>;
  fetchMessages(channelId: string, opts: { limit: number; before?: string }): Promise<MessageInfo[]>;

  fetchMember(userId: string, opts?: { force?: boolean }): Promise<MemberInfo | null>;
  fetchAllMembers(): Promise<MemberInfo[]>;
  timeoutMember(userId: string, durationMs: number, reason: string): Promise<void>;

  /** Lädt eine Datei ausschließlich von Discord-CDN-Hosts (mit Größenlimit). */
  download(url: string, maxBytes: number): Promise<Buffer>;

  listAutoModRules(): Promise<AutoModRuleInfo[]>;
  createAutoModRule(spec: AutoModRuleSpec): Promise<string>;
  setAfkChannel(channelId: string, timeoutSeconds: number, reason: string): Promise<void>;
  /** Aktuelle Boost-Stufe und -Anzahl direkt per REST (nicht aus evtl. veraltetem Cache). */
  fetchGuildPremium(): Promise<{ tier: number; count: number | null }>;
}

/** Fehler eines Discord-Aufrufs mit Discord-JSON-Fehlercode (falls vorhanden). */
export class PortError extends Error {
  constructor(
    message: string,
    public readonly code: number | null,
    public readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'PortError';
  }
}

export const DiscordErrorCode = {
  UnknownChannel: 10003,
  UnknownMember: 10007,
  UnknownMessage: 10008,
  UnknownRole: 10011,
  UnknownUser: 10013,
  MaxRoles: 30005,
  MaxChannels: 30013,
  MissingAccess: 50001,
  MissingPermissions: 50013,
  InvalidFormBody: 50035,
} as const;

export function errorCode(err: unknown): number | null {
  if (err instanceof PortError) return err.code;
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? code : null;
}

export function isUnknownResource(err: unknown): boolean {
  const c = errorCode(err);
  return (
    c === DiscordErrorCode.UnknownChannel ||
    c === DiscordErrorCode.UnknownMessage ||
    c === DiscordErrorCode.UnknownMember ||
    c === DiscordErrorCode.UnknownRole ||
    c === DiscordErrorCode.UnknownUser
  );
}
