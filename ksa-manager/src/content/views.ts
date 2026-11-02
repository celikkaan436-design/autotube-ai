import type { MessagePayload } from '../discord/port.js';
import { button, ButtonStyle, embed, row } from '../discord/ui.js';
import {
  COLORS,
  GAME_LABEL,
  GAME_SHORT,
  OFFER_STATUS_LABEL,
  PAYMENT_STATUS_LABEL,
  PROCESS_STATUS_LABEL,
  TICKET_KIND_LABEL,
  type ProcessStatus,
} from '../domain/constants.js';
import { cid } from '../domain/customId.js';
import type { OfferRow, OrderRow, ReviewRow, TicketRow } from '../services/repo.js';
import { ticketLabel } from '../services/repo.js';
import { formatPrice } from '../util/money.js';
import { sanitizeUserText } from '../util/text.js';
import { discordTimestamp, formatDate } from '../util/time.js';

/**
 * Ansichten für Tickets, Angebote und Aufträge. Kundenansichten enthalten NIE
 * interne Notizen. Interne Daten werden nur in separaten, ephemeren Teamansichten gezeigt.
 */

export function processStatus(ticket: TicketRow, order: OrderRow | undefined): ProcessStatus {
  return order ? order.status : ticket.phase;
}

export function ticketSummary(ticket: TicketRow, order: OrderRow | undefined): MessagePayload {
  const fields: { name: string; value: string; inline?: boolean }[] = [
    { name: 'Kunde', value: `<@${ticket.customer_id}>${ticket.customer_left ? ' (hat den Server verlassen)' : ''}`, inline: true },
    { name: 'Status', value: PROCESS_STATUS_LABEL[processStatus(ticket, order)], inline: true },
    { name: 'Ticket-Status', value: ticket.status === 'open' ? 'Offen' : ticket.status === 'closed' ? 'Geschlossen' : ticket.status, inline: true },
  ];
  if (ticket.kind === 'support') {
    fields.push({ name: 'Betreff', value: sanitizeUserText(ticket.subject ?? '–', 256) });
    fields.push({ name: 'Beschreibung', value: sanitizeUserText(ticket.details ?? '–', 1000) });
  } else {
    fields.push(
      { name: 'Aktueller Rang', value: sanitizeUserText(ticket.current_rank ?? '–', 200), inline: true },
      { name: 'SR', value: ticket.current_sr !== null ? String(ticket.current_sr) : 'nicht angegeben', inline: true },
      { name: 'Zielrang', value: sanitizeUserText(ticket.target_rank ?? '–', 200), inline: true },
      { name: 'Plattform', value: sanitizeUserText(ticket.platform ?? '–', 100), inline: true },
      { name: 'Gewünschter Zeitraum', value: sanitizeUserText(ticket.timeframe || 'nicht angegeben', 200), inline: true },
      { name: 'Zusätzliche Angaben', value: sanitizeUserText(ticket.details || '–', 1000) },
    );
  }
  fields.push(
    { name: 'Bearbeitet von (Support)', value: ticket.claimed_by ? `<@${ticket.claimed_by}>` : 'noch nicht übernommen', inline: true },
    { name: 'Zugewiesener Operator', value: ticket.assigned_operator_id ? `<@${ticket.assigned_operator_id}>` : 'noch keiner', inline: true },
  );
  if (order) {
    fields.push(
      { name: 'Auftrag', value: `#${order.id} – Fortschritt ${order.progress_percent} %`, inline: true },
      { name: 'Zahlungsstatus', value: PAYMENT_STATUS_LABEL[order.payment_status], inline: true },
    );
  }

  const id = ticket.id;
  const disabled = ticket.status !== 'open';
  const isGameTicket = ticket.kind !== 'support';
  const row1 = row(
    button(cid('tk', 'claim', id), 'Übernehmen', ButtonStyle.Primary, disabled),
    button(cid('tk', 'assign', id), 'Zuweisen', ButtonStyle.Secondary, disabled || !isGameTicket),
    button(cid('tk', 'status', id), 'Status ändern', ButtonStyle.Secondary, disabled || !isGameTicket),
  );
  const row2 = row(
    button(cid('of', 'new', id), 'Angebot erstellen', ButtonStyle.Success, disabled || !isGameTicket),
    button(cid('pf', 'start', id), 'Proof einreichen', ButtonStyle.Secondary, disabled || !isGameTicket),
    button(cid('tk', 'close', id), 'Schließen', ButtonStyle.Danger, disabled),
  );

  return {
    embeds: [
      embed({
        title: `Ticket ${ticketLabel(ticket)} – ${TICKET_KIND_LABEL[ticket.kind]}`,
        fields,
        color: ticket.status === 'open' ? COLORS.accent : COLORS.muted,
        timestamp: ticket.created_at,
      }),
    ],
    components: [row1, row2],
    allowedMentions: {},
  };
}

export function ticketWelcomeText(ticket: TicketRow, maxOpen: number): string {
  if (ticket.kind === 'support') {
    return [
      `Hallo <@${ticket.customer_id}>, danke für deine Nachricht. Das Support-Team meldet sich hier im Ticket.`,
      'Gib niemals Passwörter, Session-Tokens, 2FA-Codes oder Zahlungsdaten ein.',
    ].join('\n');
  }
  return [
    `Hallo <@${ticket.customer_id}>, deine Anfrage ist eingegangen.`,
    '',
    '**So geht es weiter**',
    '1. Das Team prüft deine Angaben und stellt ggf. Rückfragen.',
    '2. Du erhältst hier ein konkretes Angebot (Umfang, Preis, Zeitraum, Abbruchbedingungen).',
    '3. Erst wenn du das Angebot annimmst, entsteht ein Auftrag.',
    '',
    'Gib niemals Passwörter, Session-Tokens, 2FA-Codes oder Zahlungsdaten ein – der Bot fragt nie danach.',
    `-# Hinweis: Pro Person sind höchstens ${maxOpen} offene Tickets möglich.`,
  ].join('\n');
}

export function offerEmbed(offer: OfferRow, ticket: TicketRow, timeZone: string, forCustomer = true): MessagePayload {
  const fields = [
    { name: 'Spiel', value: GAME_LABEL[offer.game] },
    { name: 'Ausgangsrang', value: sanitizeUserText(offer.start_rank, 200), inline: true },
    { name: 'Ziel', value: sanitizeUserText(offer.target, 200), inline: true },
    { name: 'Leistungsumfang', value: sanitizeUserText(offer.scope, 1000) },
    { name: 'Preis', value: formatPrice(offer.price_cents, offer.currency), inline: true },
    { name: 'Geschätzter Zeitraum', value: sanitizeUserText(offer.timeframe ?? '–', 200), inline: true },
    { name: 'Abbruchbedingungen', value: sanitizeUserText(offer.cancellation_terms ?? '–', 1000) },
    { name: 'Status', value: OFFER_STATUS_LABEL[offer.status] ?? offer.status, inline: true },
  ];
  const sent = offer.sent_at ? ` · gesendet am ${formatDate(offer.sent_at, timeZone)}` : '';
  const payload: MessagePayload = {
    embeds: [
      embed({
        title: `Angebot v${offer.version} – Ticket ${ticketLabel(ticket)}`,
        description:
          offer.status === 'sent'
            ? 'Bitte prüfe das Angebot. Mit **Angebot annehmen** entsteht ein verbindlicher Auftrag zu genau diesen Bedingungen. Bei Änderungen erhältst du eine neue Version.'
            : undefined,
        fields,
        color: offer.status === 'accepted' ? COLORS.success : offer.status === 'sent' ? COLORS.accent : COLORS.muted,
        footer: `KSA Boosting · Angebot #${offer.id}${sent}`,
      }),
    ],
    allowedMentions: {},
  };
  if (forCustomer && offer.status === 'sent') {
    payload.components = [
      row(
        button(cid('of', 'accept', offer.id, offer.content_hash.slice(0, 16)), 'Angebot annehmen', ButtonStyle.Success),
        button(cid('of', 'decline', offer.id), 'Ablehnen', ButtonStyle.Secondary),
      ),
    ];
  } else {
    payload.components = [];
  }
  return payload;
}

/** Kundensicht auf einen Auftrag – ohne interne Notizen. */
export function orderCustomerView(order: OrderRow, ticket: TicketRow, timeZone: string): MessagePayload {
  return {
    embeds: [
      embed({
        title: `Auftrag #${order.id} – ${GAME_SHORT[order.game]}`,
        fields: [
          { name: 'Ticket', value: ticketLabel(ticket), inline: true },
          { name: 'Status', value: PROCESS_STATUS_LABEL[order.status], inline: true },
          { name: 'Fortschritt', value: `${order.progress_percent} %`, inline: true },
          { name: 'Start → Ziel', value: `${sanitizeUserText(order.start_rank, 200)} → ${sanitizeUserText(order.target, 200)}` },
          { name: 'Angenommenes Angebot', value: `Version ${order.accepted_offer_version}`, inline: true },
          { name: 'Zahlungsstatus', value: PAYMENT_STATUS_LABEL[order.payment_status], inline: true },
          { name: 'Bearbeiter', value: order.operator_id ? `<@${order.operator_id}>` : 'noch nicht zugewiesen', inline: true },
          ...(order.progress_note ? [{ name: 'Letzte Fortschrittsmeldung', value: sanitizeUserText(order.progress_note, 1000) }] : []),
          { name: 'Erstellt', value: discordTimestamp(order.created_at), inline: true },
          ...(order.completed_at ? [{ name: 'Abgeschlossen', value: formatDate(order.completed_at, timeZone), inline: true }] : []),
        ],
      }),
    ],
    allowedMentions: {},
  };
}

export function reviewPublicEmbed(review: ReviewRow, order: OrderRow, timeZone: string): MessagePayload {
  const stars = '★'.repeat(review.stars) + '☆'.repeat(5 - review.stars);
  const author = review.display_mode === 'display_name' && review.display_name ? sanitizeUserText(review.display_name, 80) : 'Verifizierter Kunde';
  let text: string | undefined;
  if (review.text_hidden) text = '*Der Text wurde von der Moderation ausgeblendet.*';
  else if (review.text) text = sanitizeUserText(review.text, 1500);
  return {
    embeds: [
      embed({
        title: `${stars}  (${review.stars}/5)`,
        description: text,
        fields: [
          { name: 'Von', value: author, inline: true },
          { name: 'Leistung', value: GAME_SHORT[order.game], inline: true },
          { name: 'Datum', value: formatDate(review.created_at, timeZone), inline: true },
        ],
        footer: `KSA Boosting · Bewertung #${review.id} · verifizierter Auftrag`,
      }),
    ],
    allowedMentions: {},
  };
}
