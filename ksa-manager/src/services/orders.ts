import { orderCustomerView } from '../content/views.js';
import type { MessagePayload } from '../discord/port.js';
import { embed } from '../discord/ui.js';
import {
  COLORS,
  GAME_SHORT,
  PAYMENT_STATUS_LABEL,
  PROCESS_STATUS_LABEL,
  type OrderStatus,
  type PaymentStatus,
} from '../domain/constants.js';
import { checkTransition, isFinal, ORDER_TRANSITIONS } from '../domain/orderStatus.js';
import { assertAllowed, resolveLevel, type Actor } from '../domain/permissions.js';
import { UserError } from '../util/errors.js';
import { sanitizeUserText } from '../util/text.js';
import { discordTimestamp } from '../util/time.js';
import { authConfig, type AppContext } from './context.js';
import type { Services } from './index.js';
import { ticketLabel, type OrderRow, type TicketRow } from './repo.js';

export interface OrderNoteRow {
  id: number;
  order_id: number;
  author_id: string;
  body: string;
  created_at: number;
}

export interface OrderEventRow {
  id: number;
  order_id: number;
  actor_id: string;
  type: string;
  from_value: string | null;
  to_value: string | null;
  details: string | null;
  created_at: number;
}

export class OrderService {
  constructor(
    private readonly ctx: AppContext,
    private readonly s: Services,
  ) {}

  private get repo() {
    return this.ctx.repo;
  }

  /** Auftrag über den Ticketkanal finden (Befehle im Ticket). */
  requireByChannel(channelId: string | null): { order: OrderRow; ticket: TicketRow } {
    const ticket = this.s.tickets.requireTicketByChannel(channelId);
    const order = this.repo.orderByTicket(ticket.id);
    if (!order) throw new UserError('Zu diesem Ticket gibt es noch keinen Auftrag (erst nach Annahme eines Angebots).');
    return { order, ticket };
  }

  requireById(orderId: number): { order: OrderRow; ticket: TicketRow } {
    const order = this.repo.order(orderId);
    if (!order) throw new UserError('Dieser Auftrag existiert nicht.');
    const ticket = this.repo.ticket(order.ticket_id)!;
    return { order, ticket };
  }

  /** Statuswechsel mit Statusmaschine, Berechtigung und Schutz vor parallelen Änderungen. */
  async setStatus(actor: Actor, orderId: number, to: OrderStatus): Promise<OrderRow> {
    const { order } = this.requireById(orderId);
    const scope = this.repo.scopeOfOrder(order);
    assertAllowed(actor, authConfig(this.ctx), to === 'storniert' ? 'order.status.cancel' : 'order.status', scope);
    return this.ctx.locks.run(`order:${order.id}`, async () => {
      const current = this.repo.order(order.id)!;
      const level = resolveLevel(actor, authConfig(this.ctx));
      const check = checkTransition(current.status, to, level, current.operator_id === actor.userId);
      if (!check.ok) throw new UserError(check.reason.replace(`„${current.status}“`, `„${PROCESS_STATUS_LABEL[current.status]}“`).replace(`„${to}“`, `„${PROCESS_STATUS_LABEL[to]}“`));
      const now = this.ctx.clock.now();
      this.ctx.db.transaction(() => {
        const changed = this.ctx.db
          .prepare(
            `UPDATE orders SET status = ?, updated_at = ?,
               completed_at = CASE WHEN ? = 'abgeschlossen' THEN ? ELSE completed_at END,
               cancelled_at = CASE WHEN ? = 'storniert' THEN ? ELSE cancelled_at END,
               progress_percent = CASE WHEN ? = 'abgeschlossen' THEN 100 ELSE progress_percent END
             WHERE id = ? AND status = ?`,
          )
          .run(to, now, to, now, to, now, to, current.id, current.status).changes;
        if (changed !== 1) throw new UserError('Der Status wurde zwischenzeitlich geändert. Bitte erneut versuchen.');
        this.repo.addOrderEvent(current.id, actor.userId, 'status', current.status, to, null, now);
      })();
      const updated = this.repo.order(current.id)!;
      const ticket = this.repo.ticket(updated.ticket_id)!;
      this.ctx.audit.record(actor.userId, 'order.status', { type: 'order', id: updated.id }, { from: current.status, to });
      await this.s.tickets.notify(ticket, `Auftrag #${updated.id}: Status ist jetzt **${PROCESS_STATUS_LABEL[to]}**.`);
      await this.s.tickets.refreshSummary(ticket);
      await this.ctx.audit.teamLog('Auftragsstatus geändert', [`Auftrag #${updated.id} (${ticketLabel(ticket)}): ${PROCESS_STATUS_LABEL[current.status]} → ${PROCESS_STATUS_LABEL[to]}`]);
      this.s.overview.schedule();
      if (to === 'abgeschlossen') {
        await this.s.reviews.postInvitation(updated).catch((err: unknown) => this.ctx.log.warn({ err }, 'Bewertungseinladung fehlgeschlagen'));
        await this.s.proofs.onOrderCompleted(updated.id);
      }
      if (to === 'storniert') await this.s.proofs.cancelForOrder(updated.id, actor.userId, 'Auftrag storniert');
      return updated;
    });
  }

  allowedTargets(actor: Actor, order: OrderRow): OrderStatus[] {
    const level = resolveLevel(actor, authConfig(this.ctx));
    return ORDER_TRANSITIONS[order.status].filter((to) => checkTransition(order.status, to, level, order.operator_id === actor.userId).ok);
  }

  async setProgress(actor: Actor, orderId: number, percent: number, note: string | null): Promise<OrderRow> {
    const { order } = this.requireById(orderId);
    assertAllowed(actor, authConfig(this.ctx), 'order.progress', this.repo.scopeOfOrder(order));
    if (isFinal(order.status)) throw new UserError('Der Auftrag ist bereits beendet.');
    if (!Number.isInteger(percent) || percent < 0 || percent > 100) throw new UserError('Fortschritt muss zwischen 0 und 100 liegen.');
    const cleanNote = note ? sanitizeUserText(note, 500) : null;
    const now = this.ctx.clock.now();
    this.ctx.db.transaction(() => {
      this.ctx.db.prepare('UPDATE orders SET progress_percent = ?, progress_note = ?, updated_at = ? WHERE id = ?').run(percent, cleanNote, now, order.id);
      this.repo.addOrderEvent(order.id, actor.userId, 'progress', String(order.progress_percent), String(percent), null, now);
    })();
    const ticket = this.repo.ticket(order.ticket_id)!;
    await this.s.tickets.notify(ticket, `Auftrag #${order.id}: Fortschritt **${percent} %**${cleanNote ? ` – ${cleanNote}` : ''}`);
    await this.s.tickets.refreshSummary(ticket);
    this.s.overview.schedule();
    return this.repo.order(order.id)!;
  }

  /** Manuelle Zahlungsbestätigung – keine Zahlungsabwicklung, keine Zahlungsdaten. */
  async setPayment(actor: Actor, orderId: number, status: PaymentStatus): Promise<OrderRow> {
    const { order } = this.requireById(orderId);
    assertAllowed(actor, authConfig(this.ctx), 'order.payment', this.repo.scopeOfOrder(order));
    if (order.payment_status === status) throw new UserError('Der Zahlungsstatus ist bereits so gesetzt.');
    const now = this.ctx.clock.now();
    this.ctx.db.transaction(() => {
      const changed = this.ctx.db
        .prepare('UPDATE orders SET payment_status = ?, updated_at = ? WHERE id = ? AND payment_status = ?')
        .run(status, now, order.id, order.payment_status).changes;
      if (changed !== 1) throw new UserError('Der Zahlungsstatus wurde zwischenzeitlich geändert.');
      this.repo.addOrderEvent(order.id, actor.userId, 'payment', order.payment_status, status, null, now);
    })();
    const ticket = this.repo.ticket(order.ticket_id)!;
    this.ctx.audit.record(actor.userId, 'order.payment', { type: 'order', id: order.id }, { from: order.payment_status, to: status });
    await this.s.tickets.notify(ticket, `Auftrag #${order.id}: Zahlungsstatus **${PAYMENT_STATUS_LABEL[status]}** (manuell durch das Team gesetzt).`);
    await this.s.tickets.refreshSummary(ticket);
    await this.ctx.audit.teamLog('Zahlungsstatus geändert', [`Auftrag #${order.id}: ${PAYMENT_STATUS_LABEL[order.payment_status]} → ${PAYMENT_STATUS_LABEL[status]} durch <@${actor.userId}>`]);
    this.s.overview.schedule();
    return this.repo.order(order.id)!;
  }

  /** Interne Notiz – erscheint nie in Kundenansichten, Proofs oder Kundenexporten. */
  addNote(actor: Actor, orderId: number, body: string): OrderNoteRow {
    const { order } = this.requireById(orderId);
    assertAllowed(actor, authConfig(this.ctx), 'order.note', this.repo.scopeOfOrder(order));
    const text = sanitizeUserText(body, 1500);
    if (!text) throw new UserError('Die Notiz ist leer.');
    const info = this.ctx.db
      .prepare('INSERT INTO order_notes (order_id, author_id, body, created_at) VALUES (?, ?, ?, ?)')
      .run(order.id, actor.userId, text, this.ctx.clock.now());
    this.ctx.audit.record(actor.userId, 'order.note_added', { type: 'order', id: order.id });
    return this.ctx.db.prepare<[number], OrderNoteRow>('SELECT * FROM order_notes WHERE id = ?').get(Number(info.lastInsertRowid))!;
  }

  notes(actor: Actor, order: OrderRow): OrderNoteRow[] {
    assertAllowed(actor, authConfig(this.ctx), 'order.view.internal', this.repo.scopeOfOrder(order));
    return this.ctx.db.prepare<[number], OrderNoteRow>('SELECT * FROM order_notes WHERE order_id = ? ORDER BY id').all(order.id);
  }

  events(actor: Actor, order: OrderRow): OrderEventRow[] {
    assertAllowed(actor, authConfig(this.ctx), 'order.view.internal', this.repo.scopeOfOrder(order));
    return this.ctx.db.prepare<[number], OrderEventRow>('SELECT * FROM order_events WHERE order_id = ? ORDER BY id').all(order.id);
  }

  /** Ansicht je nach Berechtigung: Kunden ohne, Team mit internen Notizen. */
  view(actor: Actor, orderId: number): MessagePayload {
    const { order, ticket } = this.requireById(orderId);
    assertAllowed(actor, authConfig(this.ctx), 'order.view', this.repo.scopeOfOrder(order));
    const base = orderCustomerView(order, ticket, this.ctx.config.timezone);
    const internal = authConfigAllows(this.ctx, actor, order);
    if (!internal) return base;
    const notes = this.notes(actor, order);
    const events = this.events(actor, order).slice(-10);
    base.embeds!.push(
      embed({
        title: `Intern – Auftrag #${order.id}`,
        color: COLORS.neutral,
        fields: [
          {
            name: `Interne Notizen (${notes.length})`,
            value: notes.length ? notes.slice(-5).map((n) => `${discordTimestamp(n.created_at, 'd')} <@${n.author_id}>: ${n.body}`).join('\n') : '–',
          },
          {
            name: 'Änderungsverlauf (letzte 10)',
            value: events.length
              ? events.map((e) => `${discordTimestamp(e.created_at, 'd')} ${e.type}: ${e.from_value ?? '–'} → ${e.to_value ?? '–'} (<@${e.actor_id}>)`).join('\n')
              : '–',
          },
        ],
        footer: 'Nur für das Team sichtbar',
      }),
    );
    return base;
  }

  listActive(actor: Actor): OrderRow[] {
    const level = resolveLevel(actor, authConfig(this.ctx));
    const all = this.ctx.db
      .prepare<[string], OrderRow>("SELECT * FROM orders WHERE guild_id = ? AND status NOT IN ('abgeschlossen','storniert') ORDER BY id")
      .all(this.ctx.config.guildId);
    if (level === 'operator') return all.filter((o) => o.operator_id === actor.userId);
    if (level === 'member') return all.filter((o) => o.customer_id === actor.userId);
    return all;
  }

  label(order: OrderRow): string {
    return `#${order.id} ${GAME_SHORT[order.game]} · ${PROCESS_STATUS_LABEL[order.status]}`;
  }
}

function authConfigAllows(ctx: AppContext, actor: Actor, order: OrderRow): boolean {
  try {
    assertAllowed(actor, authConfig(ctx), 'order.view.internal', ctx.repo.scopeOfOrder(order));
    return true;
  } catch {
    return false;
  }
}
