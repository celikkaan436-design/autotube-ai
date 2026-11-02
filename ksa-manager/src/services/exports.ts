import { GAME_LABEL, OFFER_STATUS_LABEL, PAYMENT_STATUS_LABEL, PROCESS_STATUS_LABEL, PROOF_STATUS_LABEL, TICKET_KIND_LABEL } from '../domain/constants.js';
import { assertAllowed, type Actor } from '../domain/permissions.js';
import type { MessageInfo } from '../discord/port.js';
import { errInfo } from '../logging/logger.js';
import { UserError } from '../util/errors.js';
import { formatPrice } from '../util/money.js';
import { formatDateTime } from '../util/time.js';
import { authConfig, type AppContext } from './context.js';
import type { Services } from './index.js';
import { ticketLabel, type ProofRow, type TicketRow } from './repo.js';

const MAX_EXPORT_MESSAGES = 5000;

/**
 * Private Ticket-Exporte (.txt). Werden nur ephemer an die anfragende Person
 * gesendet und nicht auf dem Server gespeichert. Kundenexporte enthalten
 * niemals interne Notizen, Änderungsverläufe oder Team-Freigabedetails.
 */
export class ExportService {
  constructor(
    private readonly ctx: AppContext,
    private readonly s: Services,
  ) {}

  async exportTicket(actor: Actor, ticket: TicketRow, kind: 'customer' | 'internal'): Promise<{ name: string; data: Buffer }> {
    assertAllowed(actor, authConfig(this.ctx), kind === 'internal' ? 'ticket.export.internal' : 'ticket.export.customer', this.ctx.repo.scopeOfTicket(ticket));
    const tz = this.ctx.config.timezone;
    const lines: string[] = [];
    const repo = this.ctx.repo;
    lines.push(`KSA Boosting – Ticket-Export (${kind === 'internal' ? 'INTERN – nicht an Kunden weitergeben' : 'Kundenexport'})`);
    lines.push(`Erstellt: ${formatDateTime(this.ctx.clock.now(), tz)} (${tz})`);
    lines.push('='.repeat(72));
    lines.push(`Ticket ${ticketLabel(ticket)} – ${TICKET_KIND_LABEL[ticket.kind]}`);
    lines.push(`Kunde: ${ticket.customer_id}`);
    lines.push(`Eröffnet: ${formatDateTime(ticket.created_at, tz)}`);
    if (ticket.closed_at) lines.push(`Geschlossen: ${formatDateTime(ticket.closed_at, tz)}`);
    lines.push(`Status: ${ticket.status}`);
    if (ticket.kind !== 'support') {
      lines.push(`Anfrage: ${ticket.current_rank ?? '–'} → ${ticket.target_rank ?? '–'} | Plattform: ${ticket.platform ?? '–'} | Zeitraum: ${ticket.timeframe || '–'}`);
      if (ticket.details) lines.push(`Zusätzliche Angaben: ${ticket.details}`);
    } else {
      lines.push(`Betreff: ${ticket.subject ?? '–'}`);
      lines.push(`Beschreibung: ${ticket.details ?? '–'}`);
    }

    const offers = repo.offersOfTicket(ticket.id).filter((o) => o.status !== 'draft');
    if (offers.length) {
      lines.push('', '--- Angebote ---');
      for (const o of offers) {
        lines.push(
          `v${o.version} [${OFFER_STATUS_LABEL[o.status] ?? o.status}] ${GAME_LABEL[o.game]}: ${o.start_rank} → ${o.target} | ${formatPrice(o.price_cents, o.currency)} | Zeitraum: ${o.timeframe ?? '–'}`,
          `   Umfang: ${o.scope}`,
          `   Abbruchbedingungen: ${o.cancellation_terms ?? '–'}`,
        );
      }
    }
    const order = repo.orderByTicket(ticket.id);
    if (order) {
      lines.push('', '--- Auftrag ---');
      lines.push(`Auftrag #${order.id}: ${PROCESS_STATUS_LABEL[order.status]} | ${order.progress_percent} % | Zahlung: ${PAYMENT_STATUS_LABEL[order.payment_status]}`);
      lines.push(`Angenommene Angebotsversion: v${order.accepted_offer_version}`);
      if (order.completed_at) lines.push(`Abgeschlossen: ${formatDateTime(order.completed_at, tz)}`);
      const proofs = this.ctx.db.prepare<[number], ProofRow>('SELECT * FROM proofs WHERE order_id = ? ORDER BY id').all(order.id);
      for (const p of proofs) lines.push(`Proof #${p.id}: ${PROOF_STATUS_LABEL[p.status]} (Version ${p.version})`);
      if (kind === 'internal') {
        lines.push('', '--- INTERN: Notizen ---');
        for (const n of this.s.orders.notes(actor, order)) lines.push(`${formatDateTime(n.created_at, tz)} ${n.author_id}: ${n.body}`);
        lines.push('', '--- INTERN: Änderungsverlauf ---');
        for (const e of this.s.orders.events(actor, order)) lines.push(`${formatDateTime(e.created_at, tz)} ${e.actor_id} ${e.type}: ${e.from_value ?? '–'} → ${e.to_value ?? '–'}`);
      }
    }

    lines.push('', '--- Nachrichtenverlauf ---');
    if (!this.ctx.config.enableMessageContent) {
      lines.push('(Nicht verfügbar: Der privilegierte Intent „Message Content“ ist deaktiviert.)');
    } else if (!ticket.channel_id || ticket.status === 'channel_deleted') {
      lines.push('(Nicht verfügbar: Der Ticketkanal wurde gelöscht.)');
    } else {
      const messages = await this.collectMessages(ticket.channel_id);
      if (messages === null) lines.push('(Nicht verfügbar: Der Kanal konnte nicht gelesen werden.)');
      else {
        for (const m of messages) {
          const att = m.attachments.length ? ` [Anhänge: ${m.attachments.map((a) => a.name).join(', ')}]` : '';
          const emb = m.embeds.length ? ` [Embeds: ${m.embeds.map((e) => e.title ?? 'ohne Titel').join(' | ')}]` : '';
          lines.push(`[${formatDateTime(m.createdAt, tz)}] ${m.authorName} (${m.authorId}): ${m.content}${att}${emb}`);
        }
        if (messages.length >= MAX_EXPORT_MESSAGES) lines.push(`(Gekürzt auf die letzten ${MAX_EXPORT_MESSAGES} Nachrichten.)`);
      }
    }
    this.ctx.audit.record(actor.userId, kind === 'internal' ? 'ticket.export_internal' : 'ticket.export_customer', { type: 'ticket', id: ticket.id });
    const suffix = kind === 'internal' ? 'intern' : 'kunde';
    return { name: `ticket-${String(ticket.number).padStart(4, '0')}-${suffix}.txt`, data: Buffer.from(`${lines.join('\n')}\n`, 'utf8') };
  }

  private async collectMessages(channelId: string): Promise<MessageInfo[] | null> {
    const all: MessageInfo[] = [];
    let before: string | undefined;
    try {
      while (all.length < MAX_EXPORT_MESSAGES) {
        const batch = await this.ctx.port.fetchMessages(channelId, { limit: 100, ...(before ? { before } : {}) });
        if (batch.length === 0) break;
        all.push(...batch);
        before = batch[batch.length - 1]!.id;
        if (batch.length < 100) break;
      }
    } catch (err) {
      this.ctx.log.warn({ err: errInfo(err) }, 'Export: Nachrichten nicht lesbar');
      if (all.length === 0) return null;
    }
    return all.sort((a, b) => a.createdAt - b.createdAt);
  }

  findTicketForExport(number: number | null, channelId: string | null): TicketRow {
    const t = number !== null ? this.ctx.repo.ticketByNumber(number) : channelId ? this.ctx.repo.ticketByChannel(channelId) : undefined;
    if (!t) throw new UserError(number !== null ? 'Dieses Ticket existiert nicht.' : 'Bitte die Ticketnummer angeben oder den Befehl im Ticket nutzen.');
    return t;
  }
}
