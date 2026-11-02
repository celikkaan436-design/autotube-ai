import type {
  ButtonInteraction,
  ChatInputCommandInteraction,
  MessageContextMenuCommandInteraction,
  ModalSubmitInteraction,
  StringSelectMenuInteraction,
} from 'discord.js';
import { COLORS, PROOF_STATUS_LABEL } from '../../domain/constants.js';
import { argInt, argStr, cid, type ParsedId } from '../../domain/customId.js';
import { assertAllowed, atLeast, resolveLevel } from '../../domain/permissions.js';
import { authConfig } from '../../services/context.js';
import { PROOF_CHECK_NOTICE } from '../../services/proofs.js';
import type { AttachmentInfo, MessageInfo } from '../port.js';
import { toMessageInfo } from '../djsPort.js';
import { UserError } from '../../util/errors.js';
import { truncate } from '../../util/text.js';
import { formatDateTime } from '../../util/time.js';
import { actorOf, deferEphemeral, respond, updateMessage, type HandlerDeps } from '../interactions.js';
import { button, ButtonStyle, embed, row, stringSelect, modal } from '../ui.js';
import type { MessagePayload } from '../port.js';

/** Parst einen Nachrichtenlink (discord.com/ptb/canary, discordapp.com) oder eine reine ID. */
export function parseMessageRef(input: string): { guildId: string | null; channelId: string | null; messageId: string } | null {
  const s = input.trim();
  if (/^\d{17,20}$/.test(s)) return { guildId: null, channelId: null, messageId: s };
  const m = /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/channels\/(\d{17,20})\/(\d{17,20})\/(\d{17,20})\/?$/.exec(s);
  if (!m) return null;
  return { guildId: m[1]!, channelId: m[2]!, messageId: m[3]! };
}

function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`;
}

function selectionPayload(token: string, atts: AttachmentInfo[]): MessagePayload {
  return {
    embeds: [embed({ title: 'Bilder für den Proof auswählen', description: `Wähle die Bilder, die öffentlich erscheinen sollen. Nicht ausgewählte Bilder werden nicht verwendet.\n\n${PROOF_CHECK_NOTICE}`, color: COLORS.warning })],
    components: [
      row(
        stringSelect(
          cid('pf', 'sel', token),
          'Bilder auswählen',
          atts.map((a, n) => ({ label: `Bild ${n + 1}: ${truncate(a.name, 70)}`, value: a.id, description: mb(a.size) })),
          1,
          atts.length,
        ),
      ),
    ],
  };
}

async function startFromMessage(i: MessageContextMenuCommandInteraction | ChatInputCommandInteraction | StringSelectMenuInteraction, d: HandlerDeps, message: MessageInfo): Promise<void> {
  const actor = actorOf(i);
  const { token, attachments } = await d.s.proofs.beginSubmission(actor, i.channelId, message);
  if (attachments.length === 1) {
    const proof = await d.s.proofs.selectImages(actor, token, i.channelId, [attachments[0]!.id]);
    await respond(i, `Proof #${proof.id} (Version ${proof.version}) erstellt. Die Vorschau zur Freigabe steht jetzt im Ticket.`);
    return;
  }
  await respond(i, selectionPayload(token, attachments));
}

export async function proofContextMenu(i: MessageContextMenuCommandInteraction, d: HandlerDeps): Promise<void> {
  await deferEphemeral(i);
  if (i.targetMessage.guildId !== d.ctx.config.guildId) throw new UserError('Die Nachricht stammt nicht von diesem Server.');
  await startFromMessage(i, d, toMessageInfo(i.targetMessage));
}

export async function proofSelect(i: StringSelectMenuInteraction, p: ParsedId, d: HandlerDeps): Promise<void> {
  const token = argStr(p, 0);
  if (!token) throw new UserError('Ungültige Auswahl.');
  await i.deferUpdate();
  const proof = await d.s.proofs.selectImages(actorOf(i), token, i.channelId, [...i.values]);
  await updateMessage(i, `Proof #${proof.id} (Version ${proof.version}) mit ${d.ctx.repo.proofImages(proof.id).length} Bild(ern). Die Vorschau zur Freigabe steht im Ticket.`);
}

/** Ticket-Button „Proof einreichen“: zeigt Team-Nachrichten mit Bildern zur Auswahl. */
export async function proofStartButton(i: ButtonInteraction, p: ParsedId, d: HandlerDeps): Promise<void> {
  const ticketId = argInt(p, 0);
  if (!ticketId) throw new UserError('Ungültiges Ticket.');
  const t = d.s.tickets.requireTicketInChannel(ticketId, i.channelId);
  const order = d.ctx.repo.orderByTicket(t.id);
  if (!order) throw new UserError('Dieses Ticket ist mit keinem Auftrag verknüpft.');
  assertAllowed(actorOf(i), authConfig(d.ctx), 'proof.submit', d.ctx.repo.scopeOfOrder(order));
  const howTo = 'Rechtsklick (am Handy: lange drücken) auf die Nachricht mit den Ergebnisbildern → **Apps** → **Als Proof einreichen**. Alternativ: `/proof einreichen nachricht:<Link>`.';
  if (!d.intents.messageContent) {
    await respond(i, { embeds: [embed({ title: 'Proof einreichen', description: howTo })] });
    return;
  }
  await deferEphemeral(i);
  const recent = await d.ctx.port.fetchMessages(t.channel_id!, { limit: 50 });
  const authorLevel = new Map<string, boolean>();
  const candidates: MessageInfo[] = [];
  for (const m of recent) {
    if (m.authorIsBot || d.s.proofs.supportedAttachments(m).length === 0) continue;
    if (!authorLevel.has(m.authorId)) {
      const member = await d.ctx.port.fetchMember(m.authorId);
      authorLevel.set(m.authorId, member ? atLeast(resolveLevel({ userId: member.userId, roleIds: member.roleIds }, authConfig(d.ctx)), 'operator') : false);
    }
    if (authorLevel.get(m.authorId)) candidates.push(m);
  }
  if (!candidates.length) {
    await respond(i, { embeds: [embed({ title: 'Keine passenden Nachrichten gefunden', description: `In den letzten 50 Nachrichten gibt es keine Team-Nachricht mit unterstützten Bildern.\n\n${howTo}` })] });
    return;
  }
  await respond(i, {
    content: 'Welche Nachricht enthält die Ergebnisbilder?',
    components: [
      row(
        stringSelect(
          cid('pf', 'msg', t.id),
          'Nachricht wählen',
          candidates.slice(0, 25).map((m) => ({
            label: truncate(`${m.authorName} · ${d.s.proofs.supportedAttachments(m).length} Bild(er)`, 100),
            value: m.id,
            description: formatDateTime(m.createdAt, d.ctx.config.timezone),
          })),
        ),
      ),
    ],
  });
}

export async function proofMessageSelect(i: StringSelectMenuInteraction, p: ParsedId, d: HandlerDeps): Promise<void> {
  const ticketId = argInt(p, 0);
  const messageId = i.values[0];
  if (!ticketId || !messageId || !/^\d{17,20}$/.test(messageId)) throw new UserError('Ungültige Auswahl.');
  const t = d.s.tickets.requireTicketInChannel(ticketId, i.channelId);
  await i.deferUpdate();
  const msg = await d.ctx.port.fetchMessage(t.channel_id!, messageId);
  if (!msg) throw new UserError('Die Nachricht existiert nicht mehr.');
  await startFromMessage(i, d, msg);
}

const idOf = (p: ParsedId) => ({ id: argInt(p, 0), version: argInt(p, 1), hash: argStr(p, 2) });

export async function customerDecisionButton(i: ButtonInteraction, p: ParsedId, d: HandlerDeps, decision: 'approved' | 'declined'): Promise<void> {
  const { id, version, hash } = idOf(p);
  if (!id || !version || !hash) throw new UserError('Ungültige Vorschau.');
  await deferEphemeral(i);
  const proof = await d.s.proofs.customerDecision(actorOf(i), id, version, hash, i.channelId, decision);
  const r = d.s.proofs.readiness(proof);
  await respond(
    i,
    decision === 'approved'
      ? proof.status === 'published'
        ? 'Danke! Der Proof wurde veröffentlicht.'
        : `Danke für deine Zustimmung zu Version ${version}. ${r.missing.length ? `Noch offen: ${r.missing.join(', ')}.` : ''}`
      : 'Du hast die Veröffentlichung abgelehnt. Es wird nichts veröffentlicht.',
  );
}

export async function customerNameButton(i: ButtonInteraction, p: ParsedId, d: HandlerDeps): Promise<void> {
  const { id, version } = idOf(p);
  if (!id || !version) throw new UserError('Ungültige Vorschau.');
  await deferEphemeral(i);
  const proof = await d.s.proofs.toggleCustomerDisplay(actorOf(i), id, i.channelId, version);
  await respond(i, `Neue Version ${proof.version} erstellt (${proof.customer_display === 'anonymous' ? 'anonym' : 'mit Anzeigename'}). Bitte die neue Vorschau prüfen und erneut zustimmen.`);
}

export async function teamApproveButton(i: ButtonInteraction, p: ParsedId, d: HandlerDeps): Promise<void> {
  const { id, version, hash } = idOf(p);
  if (!id || !version || !hash) throw new UserError('Ungültige Vorschau.');
  const proof = d.ctx.repo.proof(id);
  if (!proof) throw new UserError('Dieser Proof existiert nicht.');
  const order = d.ctx.repo.order(proof.order_id)!;
  assertAllowed(actorOf(i), authConfig(d.ctx), 'proof.teamApprove', d.ctx.repo.scopeOfOrder(order));
  await respond(i, teamConfirmPayload(id, version, hash));
}

function teamConfirmPayload(id: number, version: number, hash: string): MessagePayload {
  return {
    embeds: [embed({ title: `Proof #${id} Version ${version} freigeben?`, description: `${PROOF_CHECK_NOTICE}\n\nBestätige nur, wenn du **jedes Bild** geprüft hast.`, color: COLORS.warning })],
    components: [row(button(cid('pf', 'tokc', id, version, hash), 'Ich habe alle Bilder geprüft – freigeben', ButtonStyle.Success))],
  };
}

export async function teamApproveConfirm(i: ButtonInteraction, p: ParsedId, d: HandlerDeps): Promise<void> {
  const { id, version, hash } = idOf(p);
  if (!id || !version || !hash) throw new UserError('Ungültige Vorschau.');
  await i.deferUpdate();
  const proof = await d.s.proofs.teamApprove(actorOf(i), id, version, hash);
  const r = d.s.proofs.readiness(proof);
  await updateMessage(i, proof.status === 'published' ? `Freigegeben und veröffentlicht (Proof #${proof.id}).` : `Team-Freigabe gespeichert. ${r.missing.length ? `Noch offen: ${r.missing.join(', ')}.` : ''}`);
}

export async function editTextButton(i: ButtonInteraction, p: ParsedId, d: HandlerDeps): Promise<void> {
  const { id, version } = idOf(p);
  const proof = id ? d.ctx.repo.proof(id) : undefined;
  if (!proof || !version) throw new UserError('Ungültige Vorschau.');
  assertAllowed(actorOf(i), authConfig(d.ctx), 'proof.edit', d.ctx.repo.scopeOfOrder(d.ctx.repo.order(proof.order_id)!));
  await i.showModal(modal(cid('pf', 'textm', proof.id, version), `Proof #${proof.id} – öffentlicher Text`, [{ id: 'text', label: 'Öffentlicher Text', style: 'paragraph', maxLength: 500, value: proof.public_text, description: 'Keine Preise, Ticket-Links, Namen oder internen Infos.' }]));
}

export async function editTextModal(i: ModalSubmitInteraction, p: ParsedId, d: HandlerDeps): Promise<void> {
  const { id, version } = idOf(p);
  if (!id || !version) throw new UserError('Ungültige Vorschau.');
  await deferEphemeral(i);
  const proof = await d.s.proofs.editText(actorOf(i), id, i.channelId, version, i.fields.getTextInputValue('text'));
  await respond(i, `Text geändert – neue Version ${proof.version}. Der Kunde muss erneut zustimmen.`);
}

export async function toggleOperatorButton(i: ButtonInteraction, p: ParsedId, d: HandlerDeps): Promise<void> {
  const { id, version } = idOf(p);
  if (!id || !version) throw new UserError('Ungültige Vorschau.');
  await deferEphemeral(i);
  const proof = await d.s.proofs.toggleOperator(actorOf(i), id, i.channelId, version);
  await respond(i, `Neue Version ${proof.version}: Bearbeiter ${proof.show_operator ? 'wird angezeigt' : 'wird nicht angezeigt'}. Der Kunde muss erneut zustimmen.`);
}

export async function removeImageButton(i: ButtonInteraction, p: ParsedId, d: HandlerDeps): Promise<void> {
  const { id, version } = idOf(p);
  const proof = id ? d.ctx.repo.proof(id) : undefined;
  if (!proof || !version) throw new UserError('Ungültige Vorschau.');
  assertAllowed(actorOf(i), authConfig(d.ctx), 'proof.edit', d.ctx.repo.scopeOfOrder(d.ctx.repo.order(proof.order_id)!));
  const images = d.ctx.repo.proofImages(proof.id);
  await respond(i, {
    content: 'Welches Bild soll entfernt werden?',
    components: [row(stringSelect(cid('pf', 'rmsel', proof.id, version), 'Bild wählen', images.map((img, n) => ({ label: `Bild ${n + 1}: ${truncate(img.original_name, 70)}`, value: String(img.id) }))))],
  });
}

export async function removeImageSelect(i: StringSelectMenuInteraction, p: ParsedId, d: HandlerDeps): Promise<void> {
  const { id, version } = idOf(p);
  const imageId = Number(i.values[0]);
  if (!id || !version || !Number.isSafeInteger(imageId)) throw new UserError('Ungültige Auswahl.');
  await i.deferUpdate();
  const proof = await d.s.proofs.removeImage(actorOf(i), id, i.channelId, version, imageId);
  await updateMessage(i, `Bild entfernt – neue Version ${proof.version}. Der Kunde muss erneut zustimmen.`);
}

export async function discardButton(i: ButtonInteraction, p: ParsedId): Promise<void> {
  const id = argInt(p, 0);
  if (!id) throw new UserError('Ungültiger Proof.');
  await respond(i, { content: `Proof #${id} wirklich verwerfen? Die gespeicherten Bilddateien werden gelöscht.`, components: [row(button(cid('pf', 'delok', id), 'Verwerfen', ButtonStyle.Danger))] });
}

export async function discardConfirm(i: ButtonInteraction, p: ParsedId, d: HandlerDeps): Promise<void> {
  const id = argInt(p, 0);
  if (!id) throw new UserError('Ungültiger Proof.');
  await i.deferUpdate();
  await d.s.proofs.cancel(actorOf(i), id, i.channelId);
  await updateMessage(i, `Proof #${id} verworfen.`);
}

export async function proofCommand(i: ChatInputCommandInteraction, d: HandlerDeps): Promise<void> {
  const sub = i.options.getSubcommand();
  const actor = actorOf(i);
  if (sub === 'freigeben') {
    const id = i.options.getInteger('id', true);
    const proof = d.ctx.repo.proof(id);
    if (!proof) throw new UserError('Dieser Proof existiert nicht.');
    assertAllowed(actor, authConfig(d.ctx), 'proof.teamApprove', d.ctx.repo.scopeOfOrder(d.ctx.repo.order(proof.order_id)!));
    if (proof.status !== 'pending' && proof.status !== 'declined') throw new UserError(`Keine Freigabe möglich (${PROOF_STATUS_LABEL[proof.status]}).`);
    await respond(i, teamConfirmPayload(proof.id, proof.version, proof.version_hash.slice(0, 16)));
    return;
  }
  await deferEphemeral(i);
  switch (sub) {
    case 'einreichen': {
      const ref = parseMessageRef(i.options.getString('nachricht', true));
      if (!ref) throw new UserError('Bitte einen Nachrichtenlink oder eine Nachrichten-ID angeben.');
      if (ref.guildId && ref.guildId !== d.ctx.config.guildId) throw new UserError('Die Nachricht stammt nicht von diesem Server.');
      const ticket = d.s.tickets.requireTicketByChannel(i.channelId);
      if (ref.channelId && ref.channelId !== ticket.channel_id) throw new UserError('Die Nachricht gehört nicht zu diesem Ticket.');
      const msg = await d.ctx.port.fetchMessage(ticket.channel_id!, ref.messageId);
      if (!msg) throw new UserError('Nachricht nicht gefunden.');
      if (!d.intents.messageContent && msg.attachments.length === 0) {
        throw new UserError('Ohne den Intent „Message Content“ liefert Discord hier keine Anhänge. Bitte das Kontextmenü **Apps → Als Proof einreichen** verwenden.');
      }
      await startFromMessage(i, d, msg);
      return;
    }
    case 'pruefen':
      await respond(i, d.s.proofs.describe(actor, i.options.getInteger('id', true)));
      return;
    case 'veroeffentlichen': {
      const id = i.options.getInteger('id', true);
      assertAllowed(actor, authConfig(d.ctx), 'proof.teamApprove');
      const r = await d.s.proofs.tryPublish(id);
      await respond(i, r.published ? `Proof #${id} ist veröffentlicht.` : `Noch nicht veröffentlicht. Offen: ${r.missing.join(', ')}.`);
      return;
    }
    case 'zuruecknehmen': {
      const proof = await d.s.proofs.withdraw(actor, i.options.getInteger('id', true), i.options.getString('grund', true));
      await respond(i, `Proof #${proof.id} wurde entfernt und protokolliert. Bereits von Dritten gespeicherte Kopien lassen sich dadurch nicht löschen.`);
      return;
    }
    case 'widerrufen': {
      const proof = await d.s.proofs.customerRevoke(actor, i.options.getInteger('id', true));
      await respond(
        i,
        proof.status === 'withdrawn'
          ? 'Deine Freigabe wurde widerrufen und der Beitrag entfernt. Hinweis: Bereits von Dritten gespeicherte Kopien können wir nicht löschen.'
          : 'Deine Freigabe wurde widerrufen. Ohne neue Zustimmung wird nichts veröffentlicht.',
      );
      return;
    }
    default:
      throw new UserError('Unbekannter Unterbefehl.');
  }
}
