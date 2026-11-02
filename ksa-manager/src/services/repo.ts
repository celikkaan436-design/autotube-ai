import type { Db } from '../db/database.js';
import type { Game, OrderStatus, PaymentStatus, TicketKind, TicketPhase, TicketStatus } from '../domain/constants.js';
import type { TicketScope } from '../domain/permissions.js';

/** Zeilentypen und einfache, parametrisierte Abfragen (immer auf den Server begrenzt). */

export interface TicketRow {
  id: number;
  guild_id: string;
  number: number;
  kind: TicketKind;
  customer_id: string;
  channel_id: string | null;
  status: TicketStatus;
  phase: TicketPhase;
  claimed_by: string | null;
  assigned_operator_id: string | null;
  current_rank: string | null;
  current_sr: number | null;
  target_rank: string | null;
  platform: string | null;
  timeframe: string | null;
  details: string | null;
  subject: string | null;
  summary_message_id: string | null;
  customer_left: number;
  close_reason: string | null;
  closed_by: string | null;
  closed_at: number | null;
  reopen_count: number;
  created_at: number;
  updated_at: number;
}

export interface OfferRow {
  id: number;
  guild_id: string;
  ticket_id: number;
  version: number;
  status: 'draft' | 'sent' | 'accepted' | 'declined' | 'superseded' | 'withdrawn';
  game: Game;
  start_rank: string;
  target: string;
  scope: string;
  price_cents: number;
  currency: string;
  timeframe: string | null;
  cancellation_terms: string | null;
  content_hash: string;
  message_id: string | null;
  created_by: string;
  created_at: number;
  sent_at: number | null;
  decided_at: number | null;
  decided_by: string | null;
}

export interface OrderRow {
  id: number;
  guild_id: string;
  ticket_id: number;
  customer_id: string;
  game: Game;
  start_rank: string;
  target: string;
  accepted_offer_id: number;
  accepted_offer_version: number;
  accepted_offer_hash: string;
  operator_id: string | null;
  status: OrderStatus;
  payment_status: PaymentStatus;
  progress_percent: number;
  progress_note: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  cancelled_at: number | null;
}

export interface ProofRow {
  id: number;
  guild_id: string;
  order_id: number;
  ticket_id: number;
  status: 'pending' | 'declined' | 'publishing' | 'published' | 'withdrawn' | 'cancelled';
  version: number;
  version_hash: string;
  public_text: string;
  show_operator: number;
  operator_display_name: string | null;
  customer_display: 'anonymous' | 'display_name';
  customer_display_name: string | null;
  preview_message_id: string | null;
  review_message_id: string | null;
  created_by: string;
  publish_nonce: string | null;
  publish_attempts: number;
  publish_started_at: number | null;
  public_channel_id: string | null;
  public_message_id: string | null;
  published_at: number | null;
  withdrawn_at: number | null;
  withdrawn_by: string | null;
  withdraw_reason: string | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

export interface ProofImageRow {
  id: number;
  proof_id: number;
  position: number;
  source_message_id: string;
  source_attachment_id: string;
  original_name: string;
  content_type: string;
  ext: string;
  size_bytes: number;
  sha256: string;
  storage_path: string | null;
  created_at: number;
}

export interface ReviewRow {
  id: number;
  guild_id: string;
  order_id: number;
  customer_id: string;
  stars: number;
  text: string | null;
  publish_consent: number;
  display_mode: 'anonymous' | 'display_name';
  display_name: string | null;
  public_channel_id: string | null;
  public_message_id: string | null;
  published_at: number | null;
  text_hidden: number;
  hidden_by: string | null;
  hidden_reason: string | null;
  hidden_at: number | null;
  withdrawn_at: number | null;
  created_at: number;
}

export class Repo {
  constructor(
    readonly db: Db,
    readonly guildId: string,
  ) {}

  ticket(id: number): TicketRow | undefined {
    return this.db.prepare<[number, string], TicketRow>('SELECT * FROM tickets WHERE id = ? AND guild_id = ?').get(id, this.guildId);
  }

  ticketByNumber(number: number): TicketRow | undefined {
    return this.db
      .prepare<[number, string], TicketRow>('SELECT * FROM tickets WHERE number = ? AND guild_id = ?')
      .get(number, this.guildId);
  }

  ticketByChannel(channelId: string): TicketRow | undefined {
    return this.db
      .prepare<[string, string], TicketRow>('SELECT * FROM tickets WHERE channel_id = ? AND guild_id = ?')
      .get(channelId, this.guildId);
  }

  ticketsOfCustomer(customerId: string, statuses: TicketStatus[]): TicketRow[] {
    const placeholders = statuses.map(() => '?').join(',');
    return this.db
      .prepare<unknown[], TicketRow>(
        `SELECT * FROM tickets WHERE guild_id = ? AND customer_id = ? AND status IN (${placeholders}) ORDER BY id`,
      )
      .all(this.guildId, customerId, ...statuses);
  }

  offer(id: number): OfferRow | undefined {
    return this.db.prepare<[number, string], OfferRow>('SELECT * FROM offers WHERE id = ? AND guild_id = ?').get(id, this.guildId);
  }

  offersOfTicket(ticketId: number): OfferRow[] {
    return this.db
      .prepare<[number, string], OfferRow>('SELECT * FROM offers WHERE ticket_id = ? AND guild_id = ? ORDER BY version')
      .all(ticketId, this.guildId);
  }

  latestOffer(ticketId: number): OfferRow | undefined {
    return this.db
      .prepare<[number, string], OfferRow>(
        'SELECT * FROM offers WHERE ticket_id = ? AND guild_id = ? ORDER BY version DESC LIMIT 1',
      )
      .get(ticketId, this.guildId);
  }

  order(id: number): OrderRow | undefined {
    return this.db.prepare<[number, string], OrderRow>('SELECT * FROM orders WHERE id = ? AND guild_id = ?').get(id, this.guildId);
  }

  orderByTicket(ticketId: number): OrderRow | undefined {
    return this.db
      .prepare<[number, string], OrderRow>('SELECT * FROM orders WHERE ticket_id = ? AND guild_id = ?')
      .get(ticketId, this.guildId);
  }

  proof(id: number): ProofRow | undefined {
    return this.db.prepare<[number, string], ProofRow>('SELECT * FROM proofs WHERE id = ? AND guild_id = ?').get(id, this.guildId);
  }

  activeProofOfOrder(orderId: number): ProofRow | undefined {
    return this.db
      .prepare<[number, string], ProofRow>(
        "SELECT * FROM proofs WHERE order_id = ? AND guild_id = ? AND status IN ('pending','declined','publishing')",
      )
      .get(orderId, this.guildId);
  }

  proofImages(proofId: number): ProofImageRow[] {
    return this.db
      .prepare<[number], ProofImageRow>('SELECT * FROM proof_images WHERE proof_id = ? ORDER BY position, id')
      .all(proofId);
  }

  review(id: number): ReviewRow | undefined {
    return this.db.prepare<[number, string], ReviewRow>('SELECT * FROM reviews WHERE id = ? AND guild_id = ?').get(id, this.guildId);
  }

  reviewOfOrder(orderId: number): ReviewRow | undefined {
    return this.db
      .prepare<[number, string], ReviewRow>('SELECT * FROM reviews WHERE order_id = ? AND guild_id = ?')
      .get(orderId, this.guildId);
  }

  /** Autorisierungs-Scope eines Tickets (Kunde + zugewiesener Operator). */
  scopeOfTicket(t: TicketRow): TicketScope {
    return { customerId: t.customer_id, assignedOperatorId: t.assigned_operator_id };
  }

  scopeOfOrder(o: OrderRow): TicketScope {
    return { customerId: o.customer_id, assignedOperatorId: o.operator_id };
  }

  addOrderEvent(orderId: number, actorId: string, type: string, from: string | null, to: string | null, details: Record<string, unknown> | null, now: number): void {
    this.db
      .prepare('INSERT INTO order_events (order_id, actor_id, type, from_value, to_value, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(orderId, actorId, type, from, to, details ? JSON.stringify(details) : null, now);
  }

  nextCounter(name: string): number {
    const row = this.db
      .prepare<[string, string], { value: number }>(
        `INSERT INTO counters (guild_id, name, value) VALUES (?, ?, 1)
         ON CONFLICT(guild_id, name) DO UPDATE SET value = value + 1 RETURNING value`,
      )
      .get(this.guildId, name);
    if (!row) throw new Error('Zähler konnte nicht erhöht werden');
    return row.value;
  }
}

export function ticketLabel(t: Pick<TicketRow, 'number'>): string {
  return `#${String(t.number).padStart(4, '0')}`;
}
