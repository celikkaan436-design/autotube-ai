import type { ButtonInteraction, ChatInputCommandInteraction, ModalSubmitInteraction } from 'discord.js';
import { offerEmbed } from '../../content/views.js';
import { COLORS, CURRENCIES, GAME_SHORT, PAYMENT_STATUS_LABEL, PROCESS_STATUS_LABEL, type OrderStatus, type PaymentStatus } from '../../domain/constants.js';
import { argInt, argStr, cid, type ParsedId } from '../../domain/customId.js';
import { assertAllowed } from '../../domain/permissions.js';
import { authConfig } from '../../services/context.js';
import { ticketLabel } from '../../services/repo.js';
import { UserError } from '../../util/errors.js';
import { formatPrice } from '../../util/money.js';
import { truncate } from '../../util/text.js';
import { actorOf, deferEphemeral, respond, updateMessage, type HandlerDeps } from '../interactions.js';
import { button, ButtonStyle, embed, modal, row } from '../ui.js';

// ------------------------------------------------------------------ Angebote

export async function newOfferButton(i: ButtonInteraction, p: ParsedId, d: HandlerDeps): Promise<void> {
  const ticketId = argInt(p, 0);
  if (!ticketId) throw new UserError('Ungültiges Ticket.');
  const t = d.s.tickets.requireTicketInChannel(ticketId, i.channelId);
  assertAllowed(actorOf(i), authConfig(d.ctx), 'offer.create', d.ctx.repo.scopeOfTicket(t));
  if (t.kind === 'support') throw new UserError('Angebote gibt es nur in Warzone- oder Multiplayer-Tickets.');
  const def = d.ctx.settings.get('offers.defaultCurrency');
  await i.showModal(
    modal(cid('of', 'm1', ticketId), `Angebot – ${GAME_SHORT[t.kind]}`, [
      { id: 'start', label: 'Ausgangsrang', maxLength: 100, value: t.current_rank ?? '' },
      { id: 'target', label: 'Ziel', maxLength: 100, value: t.target_rank ?? '' },
      { id: 'scope', label: 'Leistungsumfang', style: 'paragraph', maxLength: 1000 },
      { id: 'price', label: 'Preis', maxLength: 20, placeholder: 'z. B. 49,99' },
      { id: 'currency', label: 'Währung', options: CURRENCIES.map((c) => ({ label: c, value: c, default: c === def })) },
    ]),
  );
}

function draftView(d: HandlerDeps, offerId: number) {
  const offer = d.ctx.repo.offer(offerId)!;
  const ticket = d.ctx.repo.ticket(offer.ticket_id)!;
  const view = offerEmbed(offer, ticket, d.ctx.config.timezone, false);
  const complete = Boolean(offer.timeframe && offer.cancellation_terms);
  view.content = complete
    ? 'Entwurf vollständig. Prüfe alle Angaben und sende das Angebot an den Kunden.'
    : 'Entwurf gespeichert. Ergänze noch Zeitraum und Abbruchbedingungen.';
  view.components = [
    row(
      button(cid('of', 'm2open', offer.id), 'Zeitraum & Abbruchbedingungen', complete ? ButtonStyle.Secondary : ButtonStyle.Primary),
      button(cid('of', 'send', offer.id), 'An Kunden senden', ButtonStyle.Success, !complete),
      button(cid('of', 'discard', offer.id), 'Verwerfen', ButtonStyle.Danger),
    ),
  ];
  return view;
}

export async function offerModal1(i: ModalSubmitInteraction, p: ParsedId, d: HandlerDeps): Promise<void> {
  const ticketId = argInt(p, 0);
  if (!ticketId) throw new UserError('Ungültiges Ticket.');
  await deferEphemeral(i);
  const t = d.s.tickets.requireTicketInChannel(ticketId, i.channelId);
  const offer = d.s.offers.createDraft(actorOf(i), t, {
    startRank: i.fields.getTextInputValue('start'),
    target: i.fields.getTextInputValue('target'),
    scope: i.fields.getTextInputValue('scope'),
    price: i.fields.getTextInputValue('price'),
    currency: i.fields.getStringSelectValues('currency')[0] ?? d.ctx.settings.get('offers.defaultCurrency'),
  });
  await respond(i, draftView(d, offer.id));
}

export async function offerModal2Open(i: ButtonInteraction, p: ParsedId, d: HandlerDeps): Promise<void> {
  const offerId = argInt(p, 0);
  const offer = offerId ? d.ctx.repo.offer(offerId) : undefined;
  if (!offer || offer.status !== 'draft') throw new UserError('Dieser Entwurf ist nicht mehr verfügbar.');
  const t = d.s.tickets.requireTicketInChannel(offer.ticket_id, i.channelId);
  assertAllowed(actorOf(i), authConfig(d.ctx), 'offer.create', d.ctx.repo.scopeOfTicket(t));
  await i.showModal(
    modal(cid('of', 'm2', offer.id), `Angebot v${offer.version} – Bedingungen`, [
      { id: 'timeframe', label: 'Geschätzter Zeitraum', maxLength: 100, value: offer.timeframe ?? '', placeholder: 'Schätzung, keine Garantie' },
      { id: 'cancel', label: 'Abbruchbedingungen', style: 'paragraph', maxLength: 1000, value: offer.cancellation_terms ?? '' },
    ]),
  );
}

export async function offerModal2(i: ModalSubmitInteraction, p: ParsedId, d: HandlerDeps): Promise<void> {
  const offerId = argInt(p, 0);
  if (!offerId) throw new UserError('Ungültiges Angebot.');
  const offer = d.s.offers.completeDraft(actorOf(i), offerId, i.channelId, {
    timeframe: i.fields.getTextInputValue('timeframe'),
    cancellationTerms: i.fields.getTextInputValue('cancel'),
  });
  await updateMessage(i, draftView(d, offer.id));
}

export async function offerSend(i: ButtonInteraction, p: ParsedId, d: HandlerDeps): Promise<void> {
  const offerId = argInt(p, 0);
  if (!offerId) throw new UserError('Ungültiges Angebot.');
  await i.deferUpdate();
  const offer = await d.s.offers.send(actorOf(i), offerId, i.channelId);
  await updateMessage(i, `Angebot v${offer.version} wurde an den Kunden gesendet.`);
}

export async function offerDiscard(i: ButtonInteraction, p: ParsedId, d: HandlerDeps): Promise<void> {
  const offerId = argInt(p, 0);
  if (!offerId) throw new UserError('Ungültiges Angebot.');
  d.s.offers.discardDraft(actorOf(i), offerId, i.channelId);
  await updateMessage(i, 'Entwurf verworfen.');
}

export async function offerAcceptButton(i: ButtonInteraction, p: ParsedId, d: HandlerDeps): Promise<void> {
  const offerId = argInt(p, 0);
  const hash = argStr(p, 1);
  if (!offerId || !hash) throw new UserError('Ungültiges Angebot.');
  const { offer } = d.s.offers.validateAcceptance(actorOf(i), offerId, hash, i.channelId);
  await respond(i, {
    embeds: [
      embed({
        title: `Angebot v${offer.version} verbindlich annehmen?`,
        description: [
          `**Preis:** ${formatPrice(offer.price_cents, offer.currency)}`,
          `**Ziel:** ${offer.start_rank} → ${offer.target}`,
          `**Zeitraum (Schätzung):** ${offer.timeframe ?? '–'}`,
          `**Abbruchbedingungen:** ${truncate(offer.cancellation_terms ?? '–', 800)}`,
          '',
          'Mit der Bestätigung entsteht ein Auftrag zu genau dieser Angebotsversion.',
        ].join('\n'),
      }),
    ],
    components: [row(button(cid('of', 'acceptok', offer.id, hash), 'Ja, verbindlich annehmen', ButtonStyle.Success))],
  });
}

export async function offerAcceptConfirm(i: ButtonInteraction, p: ParsedId, d: HandlerDeps): Promise<void> {
  const offerId = argInt(p, 0);
  const hash = argStr(p, 1);
  if (!offerId || !hash) throw new UserError('Ungültiges Angebot.');
  await i.deferUpdate();
  const { order, created } = await d.s.offers.accept(actorOf(i), offerId, hash, i.channelId);
  await updateMessage(i, created ? `Angebot angenommen. Dein Auftrag hat die Nummer **#${order.id}**.` : `Die neue Angebotsversion gilt jetzt für Auftrag **#${order.id}**.`);
}

export async function offerDecline(i: ButtonInteraction, p: ParsedId, d: HandlerDeps): Promise<void> {
  const offerId = argInt(p, 0);
  if (!offerId) throw new UserError('Ungültiges Angebot.');
  await deferEphemeral(i);
  await d.s.offers.decline(actorOf(i), offerId, i.channelId);
  await respond(i, 'Angebot abgelehnt. Das Team kann dir eine neue Version schicken.');
}

export async function offerCommand(i: ChatInputCommandInteraction, d: HandlerDeps): Promise<void> {
  const sub = i.options.getSubcommand();
  const actor = actorOf(i);
  await deferEphemeral(i);
  const t = d.s.tickets.requireTicketByChannel(i.channelId);
  if (sub === 'erstellen') {
    const draft = d.s.offers.createDraft(actor, t, {
      startRank: i.options.getString('ausgangsrang', true),
      target: i.options.getString('ziel', true),
      scope: i.options.getString('umfang', true),
      price: i.options.getString('preis', true),
      currency: i.options.getString('waehrung') ?? d.ctx.settings.get('offers.defaultCurrency'),
    });
    d.s.offers.completeDraft(actor, draft.id, i.channelId, {
      timeframe: i.options.getString('zeitraum', true),
      cancellationTerms: i.options.getString('abbruchbedingungen', true),
    });
    const sent = await d.s.offers.send(actor, draft.id, i.channelId);
    await respond(i, `Angebot v${sent.version} wurde gesendet.`);
    return;
  }
  if (sub === 'ansehen') {
    const offers = d.s.offers.list(actor, t);
    if (!offers.length) {
      await respond(i, 'Für dieses Ticket gibt es noch kein Angebot.');
      return;
    }
    const embeds = offers.slice(-10).flatMap((o) => offerEmbed(o, t, d.ctx.config.timezone, false).embeds ?? []);
    await respond(i, { embeds });
    return;
  }
  if (sub === 'zurueckziehen') {
    const o = await d.s.offers.withdraw(actor, t);
    await respond(i, `Angebot v${o.version} zurückgezogen.`);
    return;
  }
  throw new UserError('Unbekannter Unterbefehl.');
}

// ------------------------------------------------------------------ Aufträge

function resolveOrderId(i: ChatInputCommandInteraction, d: HandlerDeps): number {
  const id = i.options.getInteger('id');
  if (id) return id;
  return d.s.orders.requireByChannel(i.channelId).order.id;
}

export async function orderCommand(i: ChatInputCommandInteraction, d: HandlerDeps): Promise<void> {
  const sub = i.options.getSubcommand();
  const actor = actorOf(i);
  await deferEphemeral(i);
  switch (sub) {
    case 'ansehen':
      await respond(i, d.s.orders.view(actor, resolveOrderId(i, d)));
      return;
    case 'status': {
      const o = await d.s.orders.setStatus(actor, resolveOrderId(i, d), i.options.getString('status', true) as OrderStatus);
      await respond(i, `Auftrag #${o.id}: **${PROCESS_STATUS_LABEL[o.status]}**.`);
      return;
    }
    case 'fortschritt': {
      const o = await d.s.orders.setProgress(actor, resolveOrderId(i, d), i.options.getInteger('prozent', true), i.options.getString('text'));
      await respond(i, `Auftrag #${o.id}: Fortschritt ${o.progress_percent} % gemeldet.`);
      return;
    }
    case 'zahlung': {
      const o = await d.s.orders.setPayment(actor, resolveOrderId(i, d), i.options.getString('status', true) as PaymentStatus);
      await respond(i, `Auftrag #${o.id}: Zahlungsstatus **${PAYMENT_STATUS_LABEL[o.payment_status]}**.`);
      return;
    }
    case 'notiz': {
      d.s.orders.addNote(actor, resolveOrderId(i, d), i.options.getString('text', true));
      await respond(i, 'Interne Notiz gespeichert. Sie ist nur für das Team sichtbar.');
      return;
    }
    case 'liste': {
      const orders = d.s.orders.listActive(actor);
      const lines = orders.map((o) => {
        const t = d.ctx.repo.ticket(o.ticket_id)!;
        return `${d.s.orders.label(o)} · ${ticketLabel(t)} · ${o.progress_percent} %${t.channel_id && t.status === 'open' ? ` · <#${t.channel_id}>` : ''}`;
      });
      await respond(i, { embeds: [embed({ title: `Aktive Aufträge (${orders.length})`, description: truncate(lines.join('\n') || 'Keine.', 4000), color: COLORS.neutral })] });
      return;
    }
    default:
      throw new UserError('Unbekannter Unterbefehl.');
  }
}
