import { PermissionFlagsBits as P } from 'discord.js';
import {
  PortError,
  type AutoModRuleInfo,
  type AutoModRuleSpec,
  type ChannelInfo,
  type ChannelPatch,
  type CreateChannelSpec,
  type CreateRoleSpec,
  type DiscordPort,
  type GuildSnapshot,
  type MemberInfo,
  type MessageInfo,
  type MessagePayload,
  type OverwriteSpec,
  type RoleInfo,
} from '../../src/discord/port.js';
import { REQUIRED_PERMISSION_BITS } from '../../src/setup/blueprint.js';
import type { Clock } from '../../src/util/time.js';

/**
 * In-Memory-Nachbildung des Discord-Zielservers für automatisierte Tests (MOCK –
 * kein Live-Test). Unterstützt Fehlerinjektion und „verlorene Antworten“
 * (Aktion in Discord ausgeführt, Antwort kommt nie an).
 */

const DISCORD_EPOCH = 1420070400000n;

export interface StoredMessage {
  id: string;
  channelId: string;
  authorId: string;
  authorName: string;
  authorIsBot: boolean;
  createdAt: number;
  type: number;
  payload: MessagePayload;
  attachments: MessageInfo['attachments'];
  nonce?: string;
}

type Failure = { method: string; remaining: number; error: PortError; mode: 'before' | 'after' };

export class FakeClock implements Clock {
  constructor(public t = Date.UTC(2026, 10, 2, 12, 0, 0)) {}
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

export class FakePort implements DiscordPort {
  readonly guildId: string;
  readonly botId: string;
  ownerId = '1551640828185940140';
  roles = new Map<string, RoleInfo>();
  channels = new Map<string, ChannelInfo>();
  messages = new Map<string, StoredMessage>();
  members = new Map<string, MemberInfo>();
  automod: AutoModRuleInfo[] = [];
  downloads = new Map<string, Buffer>();
  botPermissions: bigint = REQUIRED_PERMISSION_BITS | P.ManageGuild | P.ModerateMembers | P.ManageMessages;
  botRolePosition = 50;
  premium = { tier: 1, count: 3 as number | null };
  systemChannelFlags = 0;
  systemChannelId: string | null = null;
  afkChannelId: string | null = null;
  calls: { method: string; args: unknown[] }[] = [];
  private failures: Failure[] = [];
  private seq = 0n;
  private nonces = new Map<string, string>();

  constructor(
    private readonly clock: FakeClock,
    guildId = '1530667075536814110',
  ) {
    this.guildId = guildId;
    this.botId = this.newId();
    this.members.set(this.botId, { userId: this.botId, displayName: 'KSA Manager', roleIds: [], premiumSince: null, isBot: true });
  }

  newId(): string {
    this.seq++;
    return (((BigInt(this.clock.now()) - DISCORD_EPOCH) << 22n) | (this.seq & 0x3fffffn)).toString();
  }

  /** Nächste(n) Aufruf(e) von `method` schlagen fehl. mode 'after' = Aktion passiert, Antwort geht verloren. */
  failNext(method: string, opts: { count?: number; code?: number | null; message?: string; mode?: 'before' | 'after' } = {}): void {
    this.failures.push({
      method,
      remaining: opts.count ?? 1,
      error: new PortError(opts.message ?? `Simulierter Fehler in ${method}`, opts.code ?? null, 500),
      mode: opts.mode ?? 'before',
    });
  }

  private hit(method: string, args: unknown[]): Failure | undefined {
    this.calls.push({ method, args });
    const f = this.failures.find((x) => x.method === method && x.remaining > 0);
    if (f) f.remaining--;
    return f;
  }

  private async run<T>(method: string, args: unknown[], fn: () => T): Promise<T> {
    await Promise.resolve();
    const f = this.hit(method, args);
    if (f?.mode === 'before') throw f.error;
    const value = fn();
    if (f?.mode === 'after') throw f.error;
    return value;
  }

  countCalls(method: string): number {
    return this.calls.filter((c) => c.method === method).length;
  }

  botUserId(): string {
    return this.botId;
  }

  addMember(userId: string, displayName: string, roleIds: string[] = [], premiumSince: number | null = null): MemberInfo {
    const m = { userId, displayName, roleIds, premiumSince, isBot: false };
    this.members.set(userId, m);
    return m;
  }

  addForeignChannel(name: string, kind: 'category' | 'text' | 'voice', parentId: string | null = null): string {
    const id = this.newId();
    this.channels.set(id, { id, name, kind, parentId, topic: null, overwrites: [] });
    return id;
  }

  channelByName(name: string): ChannelInfo | undefined {
    return [...this.channels.values()].find((c) => c.name === name);
  }

  messagesIn(channelId: string): StoredMessage[] {
    return [...this.messages.values()].filter((m) => m.channelId === channelId).sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
  }

  /** Simuliert eine von einem Mitglied gepostete Nachricht mit Anhängen. */
  postUserMessage(channelId: string, authorId: string, attachments: { name: string; contentType: string; data: Buffer; host?: string }[]): StoredMessage {
    const id = this.newId();
    const atts = attachments.map((a) => {
      const attId = this.newId();
      const url = `https://${a.host ?? 'cdn.discordapp.com'}/attachments/${channelId}/${attId}/${a.name}?ex=abc&is=def&hm=123`;
      this.downloads.set(url, a.data);
      return { id: attId, name: a.name, url, contentType: a.contentType, size: a.data.length };
    });
    const msg: StoredMessage = {
      id,
      channelId,
      authorId,
      authorName: this.members.get(authorId)?.displayName ?? 'unbekannt',
      authorIsBot: false,
      createdAt: this.clock.now(),
      type: 0,
      payload: { content: '' },
      attachments: atts,
    };
    this.messages.set(id, msg);
    return msg;
  }

  toInfo(m: StoredMessage): MessageInfo {
    return {
      id: m.id,
      channelId: m.channelId,
      authorId: m.authorId,
      authorName: m.authorName,
      authorIsBot: m.authorIsBot,
      createdAt: m.createdAt,
      type: m.type,
      content: m.payload.content ?? '',
      attachments: m.attachments,
      embeds: (m.payload.embeds ?? []).map((e) => ({ title: e.title ?? null, description: e.description ?? null, footer: e.footer?.text ?? null })),
    };
  }

  // ------------------------------------------------------------------ Port

  snapshot(): Promise<GuildSnapshot> {
    return this.run('snapshot', [], () => ({
      id: this.guildId,
      name: 'KSA Boosting',
      ownerId: this.ownerId,
      roles: [...this.roles.values()].map((r) => ({ ...r })),
      channels: [...this.channels.values()].map((c) => ({ ...c, overwrites: c.overwrites.map((o) => ({ ...o })) })),
      bot: { userId: this.botId, permissions: this.botPermissions, highestRolePosition: this.botRolePosition, roleIds: [] },
      premiumTier: this.premium.tier,
      premiumSubscriptionCount: this.premium.count,
      systemChannelId: this.systemChannelId,
      systemChannelFlags: this.systemChannelFlags,
      afkChannelId: this.afkChannelId,
    }));
  }

  createRole(spec: CreateRoleSpec): Promise<string> {
    return this.run('createRole', [spec], () => {
      const id = this.newId();
      this.roles.set(id, { id, name: spec.name, position: 1, managed: false, isBoosterRole: false, botId: null, color: spec.color, hoist: spec.hoist, mentionable: spec.mentionable, permissions: spec.permissions });
      return id;
    });
  }

  setRolePositions(positions: { id: string; position: number }[]): Promise<void> {
    return this.run('setRolePositions', [positions], () => {
      for (const p of positions) {
        const r = this.roles.get(p.id);
        if (r) r.position = p.position;
      }
    });
  }

  addRole(userId: string, roleId: string): Promise<void> {
    return this.run('addRole', [userId, roleId], () => {
      const m = this.members.get(userId);
      if (!m) throw new PortError('Unknown Member', 10007, 404);
      const r = this.roles.get(roleId);
      if (!r) throw new PortError('Unknown Role', 10011, 404);
      if (r.managed) throw new PortError('Managed role', 50013, 403);
      if (!m.roleIds.includes(roleId)) m.roleIds.push(roleId);
    });
  }

  removeRole(userId: string, roleId: string): Promise<void> {
    return this.run('removeRole', [userId, roleId], () => {
      const m = this.members.get(userId);
      if (!m) throw new PortError('Unknown Member', 10007, 404);
      const r = this.roles.get(roleId);
      if (r?.managed) throw new PortError('Managed role', 50013, 403);
      m.roleIds = m.roleIds.filter((x) => x !== roleId);
    });
  }

  createChannel(spec: CreateChannelSpec): Promise<string> {
    return this.run('createChannel', [spec], () => {
      if (spec.parentId && [...this.channels.values()].filter((c) => c.parentId === spec.parentId).length >= 50) {
        throw new PortError('Maximum number of channels in category reached (50)', 50035, 400);
      }
      for (const o of spec.overwrites) this.assertCanGrant(o);
      const id = this.newId();
      const name = spec.kind === 'text' ? spec.name.toLowerCase().replace(/\s+/g, '-') : spec.name;
      this.channels.set(id, { id, name, kind: spec.kind, parentId: spec.parentId, topic: spec.topic ?? null, overwrites: spec.overwrites.map((o) => ({ ...o })) });
      return id;
    });
  }

  /** Discord: Overwrites dürfen nur Rechte enthalten, die der Bot selbst hat. */
  private assertCanGrant(o: OverwriteSpec): void {
    const bits = o.allow | o.deny;
    if ((bits & ~this.botPermissions) !== 0n) throw new PortError('Missing Permissions (overwrite)', 50013, 403);
  }

  editChannel(channelId: string, patch: ChannelPatch): Promise<void> {
    return this.run('editChannel', [channelId, patch], () => {
      const c = this.channels.get(channelId);
      if (!c) throw new PortError('Unknown Channel', 10003, 404);
      if (patch.name !== undefined) c.name = patch.name;
      if (patch.topic !== undefined) c.topic = patch.topic;
      if (patch.parentId !== undefined) c.parentId = patch.parentId; // lockPermissions: false → Overwrites bleiben
      if (patch.overwrites) {
        for (const o of patch.overwrites) this.assertCanGrant(o);
        c.overwrites = patch.overwrites.map((o) => ({ ...o }));
      }
    });
  }

  setOverwrite(channelId: string, o: OverwriteSpec): Promise<void> {
    return this.run('setOverwrite', [channelId, o], () => {
      const c = this.channels.get(channelId);
      if (!c) throw new PortError('Unknown Channel', 10003, 404);
      this.assertCanGrant(o);
      c.overwrites = [...c.overwrites.filter((x) => x.id !== o.id), { ...o }];
    });
  }

  removeOverwrite(channelId: string, targetId: string): Promise<void> {
    return this.run('removeOverwrite', [channelId, targetId], () => {
      const c = this.channels.get(channelId);
      if (!c) throw new PortError('Unknown Channel', 10003, 404);
      c.overwrites = c.overwrites.filter((x) => x.id !== targetId);
    });
  }

  deleteChannel(channelId: string): Promise<boolean> {
    return this.run('deleteChannel', [channelId], () => this.channels.delete(channelId));
  }

  getChannel(channelId: string): Promise<ChannelInfo | null> {
    return this.run('getChannel', [channelId], () => this.channels.get(channelId) ?? null);
  }

  sendMessage(channelId: string, payload: MessagePayload): Promise<string> {
    return this.run('sendMessage', [channelId, payload], () => {
      const c = this.channels.get(channelId);
      if (!c) throw new PortError('Unknown Channel', 10003, 404);
      if ((payload.files?.length ?? 0) > 10) throw new PortError('Too many attachments', 50035, 400);
      if (payload.nonce && payload.enforceNonce && this.nonces.has(payload.nonce)) return this.nonces.get(payload.nonce)!;
      const id = this.newId();
      const attachments = (payload.files ?? []).map((f) => ({ id: this.newId(), name: f.name, url: `https://cdn.discordapp.com/attachments/${channelId}/${id}/${f.name}`, contentType: null, size: f.data.length }));
      const msg: StoredMessage = { id, channelId, authorId: this.botId, authorName: 'KSA Manager', authorIsBot: true, createdAt: this.clock.now(), type: 0, payload, attachments };
      if (payload.nonce) msg.nonce = payload.nonce;
      this.messages.set(id, msg);
      if (payload.nonce && payload.enforceNonce) this.nonces.set(payload.nonce, id);
      return id;
    });
  }

  editMessage(channelId: string, messageId: string, payload: MessagePayload): Promise<void> {
    return this.run('editMessage', [channelId, messageId, payload], () => {
      const m = this.messages.get(messageId);
      if (!m || m.channelId !== channelId) throw new PortError('Unknown Message', 10008, 404);
      m.payload = { ...m.payload, ...payload };
    });
  }

  deleteMessage(channelId: string, messageId: string): Promise<boolean> {
    return this.run('deleteMessage', [channelId, messageId], () => {
      const m = this.messages.get(messageId);
      if (!m || m.channelId !== channelId) return false;
      this.messages.delete(messageId);
      return true;
    });
  }

  fetchMessage(channelId: string, messageId: string): Promise<MessageInfo | null> {
    return this.run('fetchMessage', [channelId, messageId], () => {
      const m = this.messages.get(messageId);
      return m && m.channelId === channelId ? this.toInfo(m) : null;
    });
  }

  fetchMessages(channelId: string, opts: { limit: number; before?: string }): Promise<MessageInfo[]> {
    return this.run('fetchMessages', [channelId, opts], () => {
      let list = this.messagesIn(channelId).reverse();
      if (opts.before) list = list.filter((m) => BigInt(m.id) < BigInt(opts.before!));
      return list.slice(0, opts.limit).map((m) => this.toInfo(m));
    });
  }

  fetchMember(userId: string): Promise<MemberInfo | null> {
    return this.run('fetchMember', [userId], () => {
      const m = this.members.get(userId);
      return m ? { ...m, roleIds: [...m.roleIds] } : null;
    });
  }

  fetchAllMembers(): Promise<MemberInfo[]> {
    return this.run('fetchAllMembers', [], () => [...this.members.values()].map((m) => ({ ...m, roleIds: [...m.roleIds] })));
  }

  timeoutMember(userId: string, durationMs: number): Promise<void> {
    return this.run('timeoutMember', [userId, durationMs], () => undefined);
  }

  download(url: string, maxBytes: number): Promise<Buffer> {
    return this.run('download', [url], () => {
      const host = new URL(url).hostname;
      if (host !== 'cdn.discordapp.com' && host !== 'media.discordapp.net') throw new PortError('Nur Discord-CDN', null);
      const b = this.downloads.get(url);
      if (!b) throw new PortError('Not found', null, 404);
      if (b.length > maxBytes) throw new PortError('Datei zu groß', null);
      return b;
    });
  }

  listAutoModRules(): Promise<AutoModRuleInfo[]> {
    return this.run('listAutoModRules', [], () => [...this.automod]);
  }

  createAutoModRule(spec: AutoModRuleSpec): Promise<string> {
    return this.run('createAutoModRule', [spec], () => {
      const id = this.newId();
      this.automod.push({ id, name: spec.name, triggerType: spec.triggerType, creatorId: this.botId });
      return id;
    });
  }

  setAfkChannel(channelId: string): Promise<void> {
    return this.run('setAfkChannel', [channelId], () => {
      this.afkChannelId = channelId;
    });
  }

  fetchGuildPremium(): Promise<{ tier: number; count: number | null }> {
    return this.run('fetchGuildPremium', [], () => ({ ...this.premium }));
  }
}
