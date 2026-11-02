import {
  ChannelType,
  DiscordAPIError,
  OverwriteType,
  Routes,
  type Client,
  type Guild,
  type GuildBasedChannel,
  type GuildMember,
  type Message,
  type MessageCreateOptions,
  type MessageEditOptions,
} from 'discord.js';
import {
  PortError,
  type AutoModRuleInfo,
  type AutoModRuleSpec,
  type ChannelInfo,
  type ChannelKind,
  type ChannelPatch,
  type CreateChannelSpec,
  type CreateRoleSpec,
  type DiscordPort,
  type GuildSnapshot,
  type MemberInfo,
  type MessageInfo,
  type MessagePayload,
  type OverwriteSpec,
} from './port.js';

const CDN_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net']);

function toPortError(err: unknown): PortError {
  if (err instanceof PortError) return err;
  if (err instanceof DiscordAPIError) {
    return new PortError(err.message, typeof err.code === 'number' ? err.code : null, err.status);
  }
  const e = err as { message?: string; code?: unknown; status?: unknown };
  return new PortError(e?.message ?? String(err), typeof e?.code === 'number' ? e.code : null, typeof e?.status === 'number' ? e.status : null);
}

async function wrap<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toPortError(err);
  }
}

function channelKind(c: GuildBasedChannel): ChannelKind {
  switch (c.type) {
    case ChannelType.GuildCategory:
      return 'category';
    case ChannelType.GuildText:
    case ChannelType.GuildAnnouncement:
      return 'text';
    case ChannelType.GuildVoice:
    case ChannelType.GuildStageVoice:
      return 'voice';
    default:
      return 'other';
  }
}

function toChannelInfo(c: GuildBasedChannel): ChannelInfo {
  const overwrites: OverwriteSpec[] =
    'permissionOverwrites' in c && c.permissionOverwrites
      ? [...c.permissionOverwrites.cache.values()].map((o) => ({
          id: o.id,
          type: o.type === OverwriteType.Role ? 'role' : 'member',
          allow: o.allow.bitfield,
          deny: o.deny.bitfield,
        }))
      : [];
  return {
    id: c.id,
    name: c.name,
    kind: channelKind(c),
    parentId: c.parentId ?? null,
    topic: 'topic' in c && typeof c.topic === 'string' ? c.topic : null,
    overwrites,
  };
}

function toMemberInfo(m: GuildMember): MemberInfo {
  return {
    userId: m.id,
    displayName: m.displayName,
    roleIds: [...m.roles.cache.keys()].filter((id) => id !== m.guild.id),
    premiumSince: m.premiumSinceTimestamp ?? null,
    isBot: m.user.bot,
  };
}

function toMessageInfo(m: Message): MessageInfo {
  return {
    id: m.id,
    channelId: m.channelId,
    authorId: m.author.id,
    authorName: m.member?.displayName ?? m.author.username,
    authorIsBot: m.author.bot,
    createdAt: m.createdTimestamp,
    type: m.type,
    content: m.content ?? '',
    attachments: [...m.attachments.values()].map((a) => ({
      id: a.id,
      name: a.name,
      url: a.url,
      contentType: a.contentType ?? null,
      size: a.size,
    })),
    embeds: m.embeds.map((e) => ({ title: e.title ?? null, description: e.description ?? null, footer: e.footer?.text ?? null })),
  };
}

export { toMessageInfo, toMemberInfo };

function toOverwrite(o: OverwriteSpec) {
  return { id: o.id, type: o.type === 'role' ? OverwriteType.Role : OverwriteType.Member, allow: o.allow, deny: o.deny };
}

function messageOptions(p: MessagePayload): MessageCreateOptions {
  const opts: MessageCreateOptions = {
    allowedMentions: { parse: [], users: p.allowedMentions?.users ?? [], roles: p.allowedMentions?.roles ?? [], repliedUser: false },
  };
  if (p.content !== undefined) opts.content = p.content;
  if (p.embeds) opts.embeds = p.embeds;
  if (p.components) opts.components = p.components;
  if (p.files) opts.files = p.files.map((f) => ({ attachment: f.data, name: f.name, ...(f.description ? { description: f.description } : {}) }));
  if (p.nonce) opts.nonce = p.nonce;
  if (p.enforceNonce) opts.enforceNonce = true;
  return opts;
}

/** discord.js-Implementierung des Ports – arbeitet ausschließlich auf dem Zielserver. */
export class DjsPort implements DiscordPort {
  constructor(
    private readonly client: Client<true>,
    readonly guildId: string,
  ) {}

  botUserId(): string {
    return this.client.user.id;
  }

  private async guild(): Promise<Guild> {
    const cached = this.client.guilds.cache.get(this.guildId);
    if (cached) return cached;
    return this.client.guilds.fetch(this.guildId);
  }

  private async textChannel(channelId: string) {
    const g = await this.guild();
    const ch = g.channels.cache.get(channelId) ?? (await g.channels.fetch(channelId));
    if (!ch || !ch.isTextBased() || ch.guildId !== this.guildId) throw new PortError('Unknown Channel', 10003, 404);
    return ch;
  }

  async snapshot(): Promise<GuildSnapshot> {
    return wrap(async () => {
      const g = await this.guild();
      const me = g.members.me ?? (await g.members.fetchMe());
      return {
        id: g.id,
        name: g.name,
        ownerId: g.ownerId,
        roles: [...g.roles.cache.values()]
          .filter((r) => r.id !== g.id)
          .map((r) => ({
            id: r.id,
            name: r.name,
            position: r.position,
            managed: r.managed,
            isBoosterRole: r.tags?.premiumSubscriberRole === true,
            botId: r.tags?.botId ?? null,
            color: r.colors.primaryColor,
            hoist: r.hoist,
            mentionable: r.mentionable,
            permissions: r.permissions.bitfield,
          })),
        channels: [...g.channels.cache.values()].filter((c) => !c.isThread()).map(toChannelInfo),
        bot: {
          userId: me.id,
          permissions: me.permissions.bitfield,
          highestRolePosition: me.roles.highest.position,
          roleIds: [...me.roles.cache.keys()],
        },
        premiumTier: g.premiumTier,
        premiumSubscriptionCount: g.premiumSubscriptionCount ?? null,
        systemChannelId: g.systemChannelId,
        systemChannelFlags: Number(g.systemChannelFlags.bitfield),
        afkChannelId: g.afkChannelId,
      };
    });
  }

  async createRole(spec: CreateRoleSpec): Promise<string> {
    return wrap(async () => {
      const g = await this.guild();
      const role = await g.roles.create({
        name: spec.name,
        colors: { primaryColor: spec.color },
        hoist: spec.hoist,
        mentionable: spec.mentionable,
        permissions: spec.permissions,
        reason: spec.reason,
      });
      return role.id;
    });
  }

  /** Hinweis: Die Discord-API nimmt für Positionsänderungen über discord.js keinen Grund entgegen. */
  async setRolePositions(positions: { id: string; position: number }[]): Promise<void> {
    await wrap(async () => {
      const g = await this.guild();
      await g.roles.setPositions(positions.map((p) => ({ role: p.id, position: p.position })));
    });
  }

  async addRole(userId: string, roleId: string, reason: string): Promise<void> {
    await wrap(async () => {
      const g = await this.guild();
      await g.members.addRole({ user: userId, role: roleId, reason });
    });
  }

  async removeRole(userId: string, roleId: string, reason: string): Promise<void> {
    await wrap(async () => {
      const g = await this.guild();
      await g.members.removeRole({ user: userId, role: roleId, reason });
    });
  }

  async createChannel(spec: CreateChannelSpec): Promise<string> {
    return wrap(async () => {
      const g = await this.guild();
      const type = spec.kind === 'category' ? ChannelType.GuildCategory : spec.kind === 'voice' ? ChannelType.GuildVoice : ChannelType.GuildText;
      const ch = await g.channels.create({
        name: spec.name,
        type,
        parent: spec.parentId,
        ...(spec.topic && spec.kind === 'text' ? { topic: spec.topic } : {}),
        permissionOverwrites: spec.overwrites.map(toOverwrite),
        reason: spec.reason,
      } as Parameters<typeof g.channels.create>[0]);
      return ch.id;
    });
  }

  async editChannel(channelId: string, patch: ChannelPatch): Promise<void> {
    await wrap(async () => {
      const g = await this.guild();
      const ch = g.channels.cache.get(channelId) ?? (await g.channels.fetch(channelId));
      if (!ch || ch.isThread()) throw new PortError('Unknown Channel', 10003, 404);
      await ch.edit({
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.topic !== undefined ? { topic: patch.topic } : {}),
        ...(patch.parentId !== undefined ? { parent: patch.parentId, lockPermissions: false } : {}),
        ...(patch.overwrites ? { permissionOverwrites: patch.overwrites.map(toOverwrite) } : {}),
        reason: patch.reason,
      });
    });
  }

  async setOverwrite(channelId: string, o: OverwriteSpec, reason: string): Promise<void> {
    await wrap(async () => {
      await this.client.rest.put(Routes.channelPermission(channelId, o.id), {
        body: { allow: o.allow.toString(), deny: o.deny.toString(), type: o.type === 'role' ? 0 : 1 },
        reason,
      });
    });
  }

  async removeOverwrite(channelId: string, targetId: string, reason: string): Promise<void> {
    await wrap(async () => {
      await this.client.rest.delete(Routes.channelPermission(channelId, targetId), { reason });
    });
  }

  async deleteChannel(channelId: string, reason: string): Promise<boolean> {
    try {
      const g = await this.guild();
      const ch = g.channels.cache.get(channelId) ?? (await g.channels.fetch(channelId));
      if (!ch) return false;
      await ch.delete(reason);
      return true;
    } catch (err) {
      const e = toPortError(err);
      if (e.code === 10003) return false;
      throw e;
    }
  }

  async getChannel(channelId: string): Promise<ChannelInfo | null> {
    try {
      const g = await this.guild();
      const ch = g.channels.cache.get(channelId) ?? (await g.channels.fetch(channelId));
      return ch && !ch.isThread() ? toChannelInfo(ch) : null;
    } catch (err) {
      const e = toPortError(err);
      if (e.code === 10003) return null;
      throw e;
    }
  }

  async sendMessage(channelId: string, payload: MessagePayload): Promise<string> {
    return wrap(async () => {
      const ch = await this.textChannel(channelId);
      const msg = await ch.send(messageOptions(payload));
      return msg.id;
    });
  }

  async editMessage(channelId: string, messageId: string, payload: MessagePayload): Promise<void> {
    await wrap(async () => {
      const ch = await this.textChannel(channelId);
      const base = messageOptions(payload);
      const opts: MessageEditOptions = { allowedMentions: base.allowedMentions };
      if (base.content !== undefined) opts.content = base.content;
      if (base.embeds) opts.embeds = base.embeds;
      if (base.components) opts.components = base.components as MessageEditOptions['components'];
      if (base.files) opts.files = base.files;
      await ch.messages.edit(messageId, opts);
    });
  }

  async deleteMessage(channelId: string, messageId: string): Promise<boolean> {
    try {
      const ch = await this.textChannel(channelId);
      await ch.messages.delete(messageId);
      return true;
    } catch (err) {
      const e = toPortError(err);
      if (e.code === 10008 || e.code === 10003) return false;
      throw e;
    }
  }

  async fetchMessage(channelId: string, messageId: string): Promise<MessageInfo | null> {
    try {
      const ch = await this.textChannel(channelId);
      const m = await ch.messages.fetch({ message: messageId, force: true });
      return toMessageInfo(m);
    } catch (err) {
      const e = toPortError(err);
      if (e.code === 10008 || e.code === 10003) return null;
      throw e;
    }
  }

  async fetchMessages(channelId: string, opts: { limit: number; before?: string }): Promise<MessageInfo[]> {
    return wrap(async () => {
      const ch = await this.textChannel(channelId);
      const coll = await ch.messages.fetch({ limit: Math.min(100, opts.limit), ...(opts.before ? { before: opts.before } : {}), cache: false });
      return [...coll.values()].map(toMessageInfo);
    });
  }

  async fetchMember(userId: string, opts: { force?: boolean } = {}): Promise<MemberInfo | null> {
    try {
      const g = await this.guild();
      const m = await g.members.fetch({ user: userId, force: opts.force ?? false });
      return toMemberInfo(m);
    } catch (err) {
      const e = toPortError(err);
      if (e.code === 10007 || e.code === 10013) return null;
      throw e;
    }
  }

  async fetchAllMembers(): Promise<MemberInfo[]> {
    return wrap(async () => {
      const g = await this.guild();
      const all = await g.members.fetch({ time: 120_000 });
      return [...all.values()].map(toMemberInfo);
    });
  }

  async timeoutMember(userId: string, durationMs: number, reason: string): Promise<void> {
    await wrap(async () => {
      const g = await this.guild();
      const m = await g.members.fetch(userId);
      await m.timeout(durationMs, reason);
    });
  }

  async download(url: string, maxBytes: number): Promise<Buffer> {
    const u = new URL(url);
    if (u.protocol !== 'https:' || !CDN_HOSTS.has(u.hostname)) throw new PortError('Nur Discord-CDN-URLs sind erlaubt', null);
    const res = await fetch(u, { redirect: 'error', signal: AbortSignal.timeout(20_000) });
    if (!res.ok || !res.body) throw new PortError(`Download fehlgeschlagen (${res.status})`, null, res.status);
    const declared = Number(res.headers.get('content-length') ?? '0');
    if (declared > maxBytes) throw new PortError('Datei zu groß', null);
    const chunks: Buffer[] = [];
    let total = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new PortError('Datei zu groß', null);
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  }

  async listAutoModRules(): Promise<AutoModRuleInfo[]> {
    return wrap(async () => {
      const rules = (await this.client.rest.get(Routes.guildAutoModerationRules(this.guildId))) as {
        id: string;
        name: string;
        trigger_type: number;
        creator_id: string;
      }[];
      return rules.map((r) => ({ id: r.id, name: r.name, triggerType: r.trigger_type, creatorId: r.creator_id }));
    });
  }

  async createAutoModRule(spec: AutoModRuleSpec): Promise<string> {
    return wrap(async () => {
      const res = (await this.client.rest.post(Routes.guildAutoModerationRules(this.guildId), {
        body: {
          name: spec.name,
          event_type: spec.eventType,
          trigger_type: spec.triggerType,
          trigger_metadata: spec.triggerMetadata,
          actions: spec.actions,
          enabled: true,
          exempt_roles: spec.exemptRoles.slice(0, 20),
        },
        reason: spec.reason,
      })) as { id: string };
      return res.id;
    });
  }

  async setAfkChannel(channelId: string, timeoutSeconds: number, reason: string): Promise<void> {
    await wrap(async () => {
      const g = await this.guild();
      await g.edit({ afkChannel: channelId, afkTimeout: timeoutSeconds as 60 | 300 | 900 | 1800 | 3600, reason });
    });
  }

  async fetchGuildPremium(): Promise<{ tier: number; count: number | null }> {
    return wrap(async () => {
      const raw = (await this.client.rest.get(Routes.guild(this.guildId))) as { premium_tier: number; premium_subscription_count?: number };
      return { tier: raw.premium_tier, count: typeof raw.premium_subscription_count === 'number' ? raw.premium_subscription_count : null };
    });
  }
}
