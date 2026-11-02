import type { ButtonInteraction, ChatInputCommandInteraction, ModalSubmitInteraction, StringSelectMenuInteraction, UserSelectMenuInteraction } from 'discord.js';
import { orderCustomerView, ticketSummary } from '../../content/views.js';
import { COLORS, PLATFORMS, PROCESS_STATUS_LABEL, TICKET_KIND_LABEL, TICKET_KINDS, type OrderStatus, type TicketKind } from '../../domain/constants.js';
import { argInt, argStr, cid, type ParsedId } from '../../domain/customId.js';
import { assertAllowed, atLeast, resolveLevel } from '../../domain/permissions.js';
import { authConfig } from '../../services/context.js';
import { ticketLabel } from '../../services/repo.js';
import { UserError } from '../../util/errors.js';
import { truncate } from '../../util/text.js';
import { actorOf, deferEphemeral, respond, updateMessage, type HandlerDeps } from '../interactions.js';
import { button, ButtonStyle, embed, modal, row, stringSelect, userSelect } from '../ui.js';

function rankPlaceholder(ranks: string[]): string {
  return ranks.length ? truncate(`z. B. ${ranks.slice(0, 4).join(', ')}`, 100) : 'Rang wie im Spiel angezeigt';
}

/** Ticket-Button → Formular. Vorabprüfung (Limit, Cooldown) vor dem Modal. */
export async function openTicketButton(i: ButtonInteraction, p: ParsedId, d: HandlerDeps): Promise<void> {
  const kind = argStr(p, 0) as TicketKind | null;
  if (!kind || !(TICKET_KINDS as readonly string[]).includes(kind)) throw new UserError('Unbekannte Ticketart.');
  d.s.tickets.precheck(actorOf(i));
  if (kind === 'support') {
    await i.showModal(
      modal(cid('tk', 'req', 'support'), 'Allgemeiner Support', [
        { id: 'subject', label: 'Betreff', maxLength: 100, placeholder: 'Worum geht es?' },
        { id: 'description', label: 'Beschreibung', style: 'paragraph', maxLength: 1500, description: 'Keine Passwörter, Tokens, 2FA-Codes oder Zahlungsdaten.' },
      ]),
    );
    return;
  }
  const ranks = d.ctx.settings.get(kind === 'warzone' ? 'games.warzone.ranks' : 'games.multiplayer.ranks');
  await i.showModal(
    modal(cid('tk', 'req', kind), `Anfrage ${TICKET_KIND_LABEL[kind]}`, [
      { id: 'current', label: 'Aktueller Rang (optional mit SR)', maxLength: 100, placeholder: rankPlaceholder(ranks) },
      { id: 'target', label: 'Zielrang', maxLength: 100, placeholder: rankPlaceholder(ranks) },
      { id: 'platform', label: 'Plattform', options: PLATFORMS.map((pl) => ({ label: pl, value: pl })) },
      { id: 'timeframe', label: 'Gewünschter Zeitraum', required: false, maxLength: 100, placeholder: 'z. B. bis Saisonende' },
      { id: 'details', label: 'Zusätzliche Angaben', style: 'paragraph', required: false, maxLength: 1000, description: 'Keine Passwörter, Tokens, 2FA-Codes oder Zahlungsdaten.' },
    ]),
  );
}

export async function submitTicketModal(i: ModalSubmitInteraction, p: ParsedId, d: HandlerDeps): Promise<void> {
  const kind = argStr(p, 0) as TicketKind | null;
  if (!kind || !(TICKET_KINDS as readonly string[]).includes(kind)) throw new UserError('Unbekannte Ticketart.');
  await deferEphemeral(i);
  const actor = actorOf(i);
  const ticket =
    kind === 'support'
      ? await d.s.tickets.create(actor, kind, {
          subject: i.fields.getTextInputValue('subject'),
          description: i.fields.getTextInputValue('description'),
        })
      : await d.s.tickets.create(actor, kind, {
          currentRank: i.fields.getTextInputValue('current'),
          targetRank: i.fields.getTextInputValue('target'),
          platform: i.fields.getStringSelectValues('platform')[0] ?? '',
          timeframe: i.fields.getTextInputValue('timeframe') ?? '',
          details: i.fields.getTextInputValue('details') ?? '',
        });
  await respond(i, { embeds: [embed({ title: `Ticket ${ticketLabel(ticket)} erstellt`, description: `Dein privates Ticket: <#${ticket.channel_id}>`, color: COLORS.success })] });
}

export async function claimButton(i: ButtonInteraction, p: ParsedId, d: HandlerDeps): Promise<void> {
  const id = argInt(p, 0);
  if (!id) throw new UserError('Ungültiges Ticket.');
  await deferEphemeral(i);
  await d.s.tickets.claim(actorOf(i), id, i.channelId);
  await respond(i, 'Du hast das Ticket übernommen.');
}

export async function assignButton(i: ButtonInteraction, p: ParsedId, d: HandlerDeps): Promise<void> {
  const id = argInt(p, 0);
  if (!id) throw new UserError('Ungültiges Ticket.');
  const t = d.s.tickets.requireTicketInChannel(id, i.channelId);
  assertAllowed(actorOf(i), authConfig(d.ctx), 'ticket.assign', d.ctx.repo.scopeOfTicket(t));
  await respond(i, { content: 'Wähle den Operator für dieses Ticket:', components: [row(userSelect(cid('tk', 'assignsel', id), 'Mitglied mit Rolle KSA Operator'))] });
}

export async function assignSelect(i: UserSelectMenuInteraction, p: ParsedId, d: HandlerDeps): Promise<void> {
  const id = argInt(p, 0);
  const userId = i.values[0];
  if (!id || !userId) throw new UserError('Ungültige Auswahl.');
  await i.deferUpdate();
  await d.s.tickets.assignOperator(actorOf(i), id, i.channelId, userId);
  await updateMessage(i, `<@${userId}> wurde zugewiesen.`);
}

export async function statusButton(i: ButtonInteraction, p: ParsedId, d: HandlerDeps): Promise<void> {
  const id = argInt(p, 0);
  if (!id) throw new UserError('Ungültiges Ticket.');
  const t = d.s.tickets.requireTicketInChannel(id, i.channelId);
  const order = d.ctx.repo.orderByTicket(t.id);
  if (!order) {
    assertAllowed(actorOf(i), authConfig(d.ctx), 'ticket.view', d.ctx.repo.scopeOfTicket(t));
    await respond(i, `Aktueller Status: **${PROCESS_STATUS_LABEL[t.phase]}**. Ein Auftrag entsteht erst nach Annahme eines Angebots.`);
    return;
  }
  assertAllowed(actorOf(i), authConfig(d.ctx), 'order.status', d.ctx.repo.scopeOfOrder(order));
  const targets = d.s.orders.allowedTargets(actorOf(i), order);
  if (!targets.length) {
    await respond(i, `Aktueller Status: **${PROCESS_STATUS_LABEL[order.status]}**. Für dich ist kein weiterer Wechsel möglich.`);
    return;
  }
  await respond(i, {
    content: `Auftrag #${order.id} – aktuell **${PROCESS_STATUS_LABEL[order.status]}**. Neuer Status:`,
    components: [row(stringSelect(cid('od', 'statussel', order.id), 'Status wählen', targets.map((s) => ({ label: PROCESS_STATUS_LABEL[s], value: s }))))],
  });
}

export async function statusSelect(i: StringSelectMenuInteraction, p: ParsedId, d: HandlerDeps): Promise<void> {
  const orderId = argInt(p, 0);
  const to = i.values[0] as OrderStatus | undefined;
  if (!orderId || !to) throw new UserError('Ungültige Auswahl.');
  const { ticket } = d.s.orders.requireById(orderId);
  if (ticket.channel_id !== i.channelId) throw new UserError('Dieser Auftrag gehört nicht zu diesem Kanal.');
  await i.deferUpdate();
  const updated = await d.s.orders.setStatus(actorOf(i), orderId, to);
  await updateMessage(i, `Status geändert: **${PROCESS_STATUS_LABEL[updated.status]}**.`);
}

export async function closeButton(i: ButtonInteraction, p: ParsedId, d: HandlerDeps): Promise<void> {
  const id = argInt(p, 0);
  if (!id) throw new UserError('Ungültiges Ticket.');
  const t = d.s.tickets.requireTicketInChannel(id, i.channelId);
  assertAllowed(actorOf(i), authConfig(d.ctx), 'ticket.close', d.ctx.repo.scopeOfTicket(t));
  await respond(i, {
    content: `Ticket ${ticketLabel(t)} wirklich schließen? Der Kunde verliert danach den Zugriff; das Team kann es wiedereröffnen. Auftrag und Proofs bleiben davon unberührt.`,
    components: [row(button(cid('tk', 'closeok', id), 'Ticket schließen', ButtonStyle.Danger), button(cid('tk', 'closeno', id), 'Abbrechen', ButtonStyle.Secondary))],
  });
}

export async function closeConfirm(i: ButtonInteraction, p: ParsedId, d: HandlerDeps): Promise<void> {
  const id = argInt(p, 0);
  if (!id) throw new UserError('Ungültiges Ticket.');
  await i.deferUpdate();
  await d.s.tickets.close(actorOf(i), id, i.channelId, null);
  await updateMessage(i, 'Ticket geschlossen.');
}

export async function closeCancel(i: ButtonInteraction): Promise<void> {
  await updateMessage(i, 'Abgebrochen.');
}

export async function ticketCommand(i: ChatInputCommandInteraction, d: HandlerDeps): Promise<void> {
  const sub = i.options.getSubcommand();
  const actor = actorOf(i);
  await deferEphemeral(i);
  switch (sub) {
    case 'info': {
      const number = i.options.getInteger('nummer');
      const t = number ? d.ctx.repo.ticketByNumber(number) : d.ctx.repo.ticketByChannel(i.channelId);
      if (!t) throw new UserError('Ticket nicht gefunden.');
      assertAllowed(actor, authConfig(d.ctx), 'ticket.view', d.ctx.repo.scopeOfTicket(t));
      const order = d.ctx.repo.orderByTicket(t.id);
      const summary = ticketSummary(t, order);
      const embeds = [...(summary.embeds ?? []), ...(order ? (orderCustomerView(order, t, d.ctx.config.timezone).embeds ?? []) : [])];
      await respond(i, { embeds });
      return;
    }
    case 'uebernehmen': {
      const t = d.s.tickets.requireTicketByChannel(i.channelId);
      await d.s.tickets.claim(actor, t.id, i.channelId);
      await respond(i, 'Du hast das Ticket übernommen.');
      return;
    }
    case 'zuweisen': {
      const t = d.s.tickets.requireTicketByChannel(i.channelId);
      const user = i.options.getUser('operator', true);
      await d.s.tickets.assignOperator(actor, t.id, i.channelId, user.id);
      await respond(i, `<@${user.id}> wurde zugewiesen.`);
      return;
    }
    case 'schliessen': {
      const t = d.s.tickets.requireTicketByChannel(i.channelId);
      await d.s.tickets.close(actor, t.id, i.channelId, i.options.getString('grund'));
      await respond(i, 'Ticket geschlossen.');
      return;
    }
    case 'wiedereroeffnen': {
      const t = await d.s.tickets.reopen(actor, i.options.getInteger('nummer', true));
      await respond(i, `Ticket ${ticketLabel(t)} ist wieder offen: <#${t.channel_id}>`);
      return;
    }
    case 'export': {
      const t = d.s.exports.findTicketForExport(i.options.getInteger('nummer'), i.channelId);
      const kind = (i.options.getString('art') ?? 'customer') as 'customer' | 'internal';
      const file = await d.s.exports.exportTicket(actor, t, kind);
      await respond(i, { content: `Privater Export für Ticket ${ticketLabel(t)} (${kind === 'internal' ? 'intern – nicht an Kunden weitergeben' : 'Kundenexport'}). Die Datei wird nicht auf dem Server gespeichert.`, files: [file] });
      return;
    }
    case 'liste': {
      const level = resolveLevel(actor, authConfig(d.ctx));
      const rows = atLeast(level, 'support')
        ? d.ctx.db.prepare<[string], import('../../services/repo.js').TicketRow>("SELECT * FROM tickets WHERE guild_id = ? AND status = 'open' ORDER BY id").all(d.ctx.config.guildId)
        : level === 'operator'
          ? d.ctx.db
              .prepare<[string, string], import('../../services/repo.js').TicketRow>("SELECT * FROM tickets WHERE guild_id = ? AND status = 'open' AND assigned_operator_id = ? ORDER BY id")
              .all(d.ctx.config.guildId, actor.userId)
          : d.ctx.repo.ticketsOfCustomer(actor.userId, ['open', 'closed']);
      const lines = rows.map(
        (t) => `${ticketLabel(t)} · ${TICKET_KIND_LABEL[t.kind]} · ${t.status === 'open' ? 'offen' : 'geschlossen'}${t.channel_id && t.status === 'open' ? ` · <#${t.channel_id}>` : ''}${atLeast(level, 'support') ? ` · ${t.claimed_by ? `<@${t.claimed_by}>` : 'nicht übernommen'}` : ''}`,
      );
      await respond(i, { embeds: [embed({ title: atLeast(level, 'support') ? `Offene Tickets (${rows.length})` : 'Deine Tickets', description: truncate(lines.join('\n') || 'Keine.', 4000) })] });
      return;
    }
    default:
      throw new UserError('Unbekannter Unterbefehl.');
  }
}

