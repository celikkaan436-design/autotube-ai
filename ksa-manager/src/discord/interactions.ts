import {
  MessageFlags,
  type Interaction,
  type InteractionEditReplyOptions,
  type InteractionReplyOptions,
  type MessageComponentInteraction,
  type ModalSubmitInteraction,
  type RepliableInteraction,
} from 'discord.js';
import type { Actor } from '../domain/permissions.js';
import { errInfo } from '../logging/logger.js';
import type { AppContext } from '../services/context.js';
import type { Services } from '../services/index.js';
import { isUserFacing } from '../util/errors.js';
import { randomToken } from '../util/hash.js';
import type { MessagePayload } from './port.js';
import { embed } from './ui.js';
import { COLORS } from '../domain/constants.js';

export interface HandlerDeps {
  ctx: AppContext;
  s: Services;
  intents: { guildMembers: boolean; guildMessages: boolean; messageContent: boolean };
  startedAt: number;
  versions: { node: string; discordJs: string; app: string };
  gatewayPing: () => number;
}

export function actorOf(i: Interaction): Actor {
  const m = i.member;
  let roleIds: string[] = [];
  if (m) roleIds = Array.isArray(m.roles) ? [...m.roles] : [...m.roles.cache.keys()];
  return { userId: i.user.id, roleIds };
}

function toReplyOptions(payload: MessagePayload | string): InteractionReplyOptions {
  const p: MessagePayload = typeof payload === 'string' ? { content: payload } : payload;
  const opts: InteractionReplyOptions = {
    allowedMentions: { parse: [], users: p.allowedMentions?.users ?? [], roles: p.allowedMentions?.roles ?? [] },
  };
  if (p.content !== undefined) opts.content = p.content;
  if (p.embeds) opts.embeds = p.embeds;
  if (p.components) opts.components = p.components;
  if (p.files) opts.files = p.files.map((f) => ({ attachment: f.data, name: f.name }));
  return opts;
}

/** Ephemere Antwort – funktioniert vor und nach defer/reply. */
export async function respond(i: RepliableInteraction, payload: MessagePayload | string): Promise<void> {
  const opts = toReplyOptions(payload);
  if (i.deferred && !i.replied) {
    await i.editReply(opts as InteractionEditReplyOptions);
  } else if (i.replied) {
    await i.followUp({ ...opts, flags: MessageFlags.Ephemeral });
  } else {
    await i.reply({ ...opts, flags: MessageFlags.Ephemeral });
  }
}

/** Ersetzt die (ephemere) Nachricht, an der die Komponente hängt. */
export async function updateMessage(i: MessageComponentInteraction | ModalSubmitInteraction, payload: MessagePayload | string): Promise<void> {
  const opts = toReplyOptions(payload);
  if (!opts.components) opts.components = [];
  if (i.deferred || i.replied) {
    await i.editReply(opts as InteractionEditReplyOptions);
  } else if (i.isModalSubmit()) {
    if (i.isFromMessage()) await i.update(opts as Parameters<typeof i.update>[0]);
    else await i.reply({ ...opts, flags: MessageFlags.Ephemeral });
  } else {
    await i.update(opts as Parameters<typeof i.update>[0]);
  }
}

export async function deferEphemeral(i: RepliableInteraction): Promise<void> {
  if (!i.deferred && !i.replied) await i.deferReply({ flags: MessageFlags.Ephemeral });
}

export function infoEmbed(title: string, lines: string[], color: number = COLORS.neutral): MessagePayload {
  return { embeds: [embed({ title, description: lines.join('\n'), color })] };
}

/** Einheitliche Fehlerbehandlung: fachliche Fehler verständlich, technische mit Referenz. */
export async function handleError(i: Interaction, err: unknown, deps: HandlerDeps): Promise<void> {
  if (!i.isRepliable()) return;
  let message: string;
  if (isUserFacing(err)) {
    message = err.message;
  } else {
    const ref = randomToken(4);
    deps.ctx.log.error({ err: errInfo(err), ref, kind: i.type }, 'Interaktion fehlgeschlagen');
    message = `Es ist ein technischer Fehler aufgetreten (Referenz \`${ref}\`). Bitte später erneut versuchen oder das Team informieren.`;
  }
  try {
    await respond(i, { embeds: [embed({ description: message, color: COLORS.warning })] });
  } catch (replyErr) {
    deps.ctx.log.debug({ err: errInfo(replyErr) }, 'Fehlermeldung konnte nicht gesendet werden');
  }
}
