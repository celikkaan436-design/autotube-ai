import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Client, Events, GatewayIntentBits, Partials, Routes, version as djsVersion, type GuildMember, type PartialGuildMember } from 'discord.js';
import type { AppConfig } from '../config/env.js';
import { SettingsService } from '../config/settings.js';
import type { Db } from '../db/database.js';
import { COLORS } from '../domain/constants.js';
import { errInfo, type Logger } from '../logging/logger.js';
import { AuditService } from '../services/audit.js';
import { BotState } from '../services/botState.js';
import { BOOST_MESSAGE_TYPES } from '../services/boosts.js';
import type { AppContext } from '../services/context.js';
import { createServices, type Services } from '../services/index.js';
import { ResourceRegistry } from '../services/registry.js';
import { Repo } from '../services/repo.js';
import { RECOMMENDED_PERMISSION_BITS } from '../setup/blueprint.js';
import { hashObject } from '../util/hash.js';
import { KeyedMutex } from '../util/mutex.js';
import { systemClock } from '../util/time.js';
import { commandDefinitions } from './commands.js';
import { DjsPort, toMemberInfo } from './djsPort.js';
import type { HandlerDeps } from './interactions.js';
import type { DiscordPort } from './port.js';
import { InteractionRouter } from './router.js';

function appVersion(): string {
  try {
    return (JSON.parse(readFileSync(path.resolve('package.json'), 'utf8')) as { version?: string }).version ?? 'unbekannt';
  } catch {
    return process.env.npm_package_version ?? 'unbekannt';
  }
}

/**
 * Gateway-Intents – nur was tatsächlich gebraucht wird:
 *  Guilds          – Kanäle, Rollen, Server-Updates (Pflicht)
 *  GuildMembers    – privilegiert: Boost-Status (premium_since), Begrüßung, Austritte, Rollenabgleich
 *  GuildMessages   – Boost-Systemnachrichten und Flood-Schutz (Inhalte werden nicht gespeichert)
 *  MessageContent  – privilegiert, abschaltbar: Ticket-Exporte mit Text, /proof einreichen per Link
 *  Keine Presences.
 */
export function buildIntents(enableMessageContent: boolean): GatewayIntentBits[] {
  const intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages];
  if (enableMessageContent) intents.push(GatewayIntentBits.MessageContent);
  return intents;
}

export function inviteUrl(clientId: string): string {
  return `https://discord.com/oauth2/authorize?client_id=${clientId}&scope=bot%20applications.commands&permissions=${RECOMMENDED_PERMISSION_BITS.toString()}`;
}

export interface Bot {
  client: Client;
  services: Services;
  ctx: AppContext;
  shutdown(reason: string): Promise<void>;
}

export async function startBot(config: AppConfig, db: Db, log: Logger): Promise<Bot> {
  const client = new Client({
    intents: buildIntents(config.enableMessageContent),
    partials: [Partials.GuildMember],
    allowedMentions: { parse: [], repliedUser: false },
  });

  let port: DiscordPort | null = null;
  const getPort = (): DiscordPort => {
    if (!port) throw new Error('Discord-Verbindung noch nicht bereit');
    return port;
  };
  const registry = new ResourceRegistry(db, config.guildId);
  const portProxy = new Proxy({} as DiscordPort, {
    get: (_t, prop) => {
      if (prop === 'guildId') return config.guildId;
      const p = getPort() as unknown as Record<string | symbol, unknown>;
      const v = p[prop];
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(p) : v;
    },
  });
  const ctx: AppContext = {
    config,
    db,
    log,
    port: portProxy,
    clock: systemClock,
    settings: new SettingsService(db, config.guildId),
    registry,
    locks: new KeyedMutex(),
    audit: new AuditService(db, config.guildId, systemClock, log, getPort, registry),
    repo: new Repo(db, config.guildId),
  };
  const services = createServices(ctx);
  const state = new BotState(db);
  const startedAt = Date.now();
  const deps: HandlerDeps = {
    ctx,
    s: services,
    intents: { guildMembers: true, guildMessages: true, messageContent: config.enableMessageContent },
    startedAt,
    versions: { node: process.version, discordJs: djsVersion, app: appVersion() },
    gatewayPing: () => client.ws.ping,
  };
  const router = new InteractionRouter(deps);
  let heartbeat: NodeJS.Timeout | null = null;
  let ready = false;

  client.on(Events.InteractionCreate, (i) => {
    if (!ready) return;
    router.handle(i);
  });

  client.once(Events.ClientReady, (c) => {
    port = new DjsPort(c, config.guildId);
    void onReady(c).catch((err: unknown) => log.error({ err: errInfo(err) }, 'Startphase fehlgeschlagen'));
  });

  async function onReady(c: Client<true>): Promise<void> {
    log.info({ user: c.user.tag, guilds: c.guilds.cache.size }, 'Mit Discord verbunden');
    if (config.leaveForeignGuilds) {
      for (const g of c.guilds.cache.values()) {
        if (g.id !== config.guildId) {
          log.warn({ guildId: g.id }, 'Verlasse fremden Server');
          await g.leave().catch(() => undefined);
        }
      }
    }
    const guild = c.guilds.cache.get(config.guildId);
    if (!guild) {
      log.error({ invite: inviteUrl(config.clientId) }, 'Der Bot ist nicht auf dem Zielserver. Bitte mit dem Einladungslink hinzufügen und neu starten.');
    }
    if (config.registerCommandsOnStart) await registerCommands(c, config, state, log);
    ready = true;
    if (!guild) return;

    const lastSeen = state.getNumber('last_heartbeat');
    const warnings: string[] = [];
    try {
      const report = await services.boosts.baseline(lastSeen);
      if (report.startedWhileOffline.length) {
        warnings.push(
          `Während der Offline-Zeit haben ${report.startedWhileOffline.length} Mitglied(er) mit dem Boosten begonnen (nicht automatisch bedankt): ${report.startedWhileOffline
            .slice(0, 20)
            .map((u) => `<@${u}>`)
            .join(', ')}`,
        );
      }
      if (report.roleAdded || report.roleRemoved) warnings.push(`Booster-Rolle abgeglichen: +${report.roleAdded} / −${report.roleRemoved}.`);
    } catch (err) {
      deps.intents.guildMembers = false;
      log.error({ err: errInfo(err) }, 'Boost-Startabgleich fehlgeschlagen – ist der Intent „Server Members“ im Developer Portal aktiviert?');
      warnings.push('Boost-Startabgleich fehlgeschlagen. Bitte den Intent „Server Members“ im Developer Portal prüfen.');
    }
    services.boosts.schedule();
    await services.boosts.processDue().catch(() => 0);
    const resumed = await services.proofs.resumePending().catch(() => 0);
    if (resumed) warnings.push(`${resumed} ausstehende Proof-Veröffentlichung(en) nach dem Neustart abgeschlossen.`);
    await services.overview.refresh();
    services.retention.start();
    setTimeout(() => void services.retention.run().catch(() => undefined), 60_000).unref();

    state.set('last_heartbeat', Date.now());
    heartbeat = setInterval(() => state.set('last_heartbeat', Date.now()), 60_000);
    heartbeat.unref();
    await ctx.audit.botStatus('KSA Manager gestartet', [`Version ${deps.versions.app} · discord.js ${djsVersion} · ${process.version}`, ...warnings], warnings.length ? COLORS.warning : COLORS.success);
  }

  client.on(Events.GuildCreate, (g) => {
    if (g.id !== config.guildId && config.leaveForeignGuilds) {
      log.warn({ guildId: g.id }, 'Bot wurde zu fremdem Server hinzugefügt – verlasse ihn');
      void g.leave().catch(() => undefined);
    }
  });

  client.on(Events.MessageCreate, (m) => {
    if (!ready || m.guildId !== config.guildId) return;
    if (BOOST_MESSAGE_TYPES.has(m.type)) {
      void services.boosts.onSystemBoostMessage(m.id, m.author.id, m.createdTimestamp).catch((err: unknown) => log.warn({ err: errInfo(err) }, 'Boost-Systemnachricht nicht verarbeitet'));
      return;
    }
    if (m.author.bot || m.system) return;
    const roleIds = m.member ? [...m.member.roles.cache.keys()] : [];
    void services.community
      .onMessage({ channelId: m.channelId, messageId: m.id, authorId: m.author.id, roleIds, isBot: m.author.bot })
      .catch((err: unknown) => log.debug({ err: errInfo(err) }, 'Flood-Schutz übersprungen'));
  });

  client.on(Events.GuildMemberAdd, (m) => {
    if (!ready || m.guild.id !== config.guildId) return;
    const info = toMemberInfo(m);
    services.boosts.onMemberJoin(info);
    void services.community.welcome(info);
    void services.tickets.handleMemberRejoined(m.id).catch(() => undefined);
  });

  client.on(Events.GuildMemberRemove, (m: GuildMember | PartialGuildMember) => {
    if (!ready || m.guild.id !== config.guildId) return;
    services.boosts.onMemberLeave(m.id);
    void services.tickets.handleMemberLeft(m.id).catch((err: unknown) => log.warn({ err: errInfo(err) }, 'Austritt nicht verarbeitet'));
  });

  client.on(Events.GuildMemberUpdate, (_old, m) => {
    if (!ready || m.guild.id !== config.guildId || !services.boosts.baselineDone) return;
    void services.boosts.onMemberUpdate(toMemberInfo(m)).catch((err: unknown) => log.warn({ err: errInfo(err) }, 'Member-Update nicht verarbeitet'));
  });

  client.on(Events.ChannelDelete, (ch) => {
    if (!ready || !('guildId' in ch) || ch.guildId !== config.guildId) return;
    services.tickets.markChannelDeleted(ch.id);
    const res = registry.findByDiscordId(ch.id);
    if (res) void ctx.audit.botStatus('Verwalteter Kanal gelöscht', [`${res.key} wurde gelöscht. \`/setup diagnose\` zeigt Details, \`/setup start\` legt ihn neu an.`], COLORS.warning);
  });

  client.on(Events.GuildRoleCreate, (r) => {
    if (!ready || r.guild.id !== config.guildId) return;
    if (r.tags?.premiumSubscriberRole && ctx.settings.get('boost.roleMode') === 'custom') {
      void ctx.audit.botStatus('Discord-Booster-Rolle erkannt', [`Discord hat die verwaltete Booster-Rolle <@&${r.id}> angelegt. Empfehlung: \`/serverboost rollenmodus modus:verwaltet\`.`]);
    }
  });

  client.on(Events.Error, (err) => log.error({ err: errInfo(err) }, 'Discord-Client-Fehler'));
  client.on(Events.Warn, (msg) => log.warn({ msg }, 'Discord-Client-Warnung'));
  client.rest.on('rateLimited', (info) => log.warn({ route: info.route, retryAfter: info.retryAfter, global: info.global }, 'Discord-Rate-Limit'));

  await client.login(config.token);

  return {
    client,
    services,
    ctx,
    async shutdown(reason: string) {
      log.info({ reason }, 'Fahre herunter');
      router.accepting = false;
      await router.drain(10_000);
      if (heartbeat) clearInterval(heartbeat);
      services.boosts.stop();
      services.retention.stop();
      await services.overview.flush().catch(() => undefined);
      state.set('last_heartbeat', Date.now());
      state.set('last_shutdown', Date.now());
      await client.destroy();
    },
  };
}

async function registerCommands(c: Client<true>, config: AppConfig, state: BotState, log: Logger): Promise<void> {
  const body = commandDefinitions();
  const hash = hashObject({ body, guild: config.guildId, app: config.clientId });
  if (state.get('commands_hash') === hash) {
    log.info('Slash-Befehle unverändert – keine Registrierung nötig');
    return;
  }
  try {
    await c.rest.put(Routes.applicationGuildCommands(config.clientId, config.guildId), { body });
    state.set('commands_hash', hash);
    log.info({ count: body.length }, 'Slash-Befehle auf dem Zielserver registriert');
  } catch (err) {
    log.error({ err: errInfo(err) }, 'Slash-Befehle konnten nicht registriert werden');
  }
}

export { registerCommands };
