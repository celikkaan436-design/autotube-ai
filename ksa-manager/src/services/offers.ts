import { offerEmbed } from '../content/views.js';
import { CURRENCIES, GAME_SHORT, isGame, type Currency } from '../domain/constants.js';
import { assertAllowed, type Actor } from '../domain/permissions.js';
import { isFinal } from '../domain/orderStatus.js';
import { errInfo } from '../logging/logger.js';
import { UserError } from '../util/errors.js';
import { hashObject } from '../util/hash.js';
import { formatPrice, parseCurrency, parsePriceToCents } from '../util/money.js';
import { sanitizeUserText } from '../util/text.js';
import { authConfig, type AppContext } from './context.js';
import type { Services } from './index.js';
import { ticketLabel, type OfferRow, type OrderRow, type TicketRow } from './repo.js';

export interface OfferCoreInput {
  startRank: string;
  target: string;
  scope: string;
  price: string;
  currency: string;
}

export interface OfferTermsInput {
  timeframe: string;
  cancellationTerms: string;
}

function offerHash(o: Pick<OfferRow, 'ticket_id' | 'version' | 'game' | 'start_rank' | 'target' | 'scope' | 'price_cents' | 'currency' | 'timeframe' | 'cancellation_terms'>): string {
  return hashObject({
    ticket: o.ticket_id,
    version: o.version,
    game: o.game,
    start: o.start_rank,
    target: o.target,
    scope: o.scope,
    price: o.price_cents,
    currency: o.currency,
    timeframe: o.timeframe,
    cancel: o.cancellation_terms,
  });
}

export class OfferService {
  constructor(
    private readonly ctx: AppContext,
    private readonly s: Services,
  ) {}

  private get repo() {
    return this.ctx.repo;
  }

  private requireOpenGameTicket(t: TicketRow): void {
    if (t.status !== 'open') throw new UserError('Das Ticket ist nicht offen.');
    if (!isGame(t.kind)) throw new UserError('Angebote gibt es nur in Warzone- oder Multiplayer-Tickets.');
    const order = this.repo.orderByTicket(t.id);
    if (order && isFinal(order.status)) throw new UserError('Der Auftrag ist bereits abgeschlossen oder storniert – keine neuen Angebote möglich.');
  }

  /** Schritt 1: Entwurf mit Kerndaten anlegen (ersetzt einen älteren, nicht gesendeten Entwurf). */
  createDraft(actor: Actor, ticket: TicketRow, input: OfferCoreInput): OfferRow {
    assertAllowed(actor, authConfig(this.ctx), 'offer.create', this.repo.scopeOfTicket(ticket));
    this.requireOpenGameTicket(ticket);
    const priceCents = parsePriceToCents(input.price);
    if (priceCents === null) throw new UserError('Ungültiger Preis. Beispiel: 49,99');
    const currency = parseCurrency(input.currency || this.ctx.settings.get('offers.defaultCurrency'));
    if (!currency) throw new UserError(`Ungültige Währung. Erlaubt: ${CURRENCIES.join(', ')}`);
    const startRank = sanitizeUserText(input.startRank, 100);
    const target = sanitizeUserText(input.target, 100);
    const scope = sanitizeUserText(input.scope, 1000);
    if (!startRank || !target || !scope) throw new UserError('Ausgangsrang, Ziel und Leistungsumfang sind Pflichtfelder.');
    const now = this.ctx.clock.now();
    const game = ticket.kind as 'warzone' | 'multiplayer';
    const create = this.ctx.db.transaction((): OfferRow => {
      this.ctx.db.prepare("UPDATE offers SET status = 'withdrawn' WHERE ticket_id = ? AND status = 'draft'").run(ticket.id);
      const latest = this.repo.latestOffer(ticket.id);
      const version = (latest?.version ?? 0) + 1;
      const base = {
        ticket_id: ticket.id,
        version,
        game,
        start_rank: startRank,
        target,
        scope,
        price_cents: priceCents,
        currency,
        timeframe: null,
        cancellation_terms: null,
      };
      const info = this.ctx.db
        .prepare(
          `INSERT INTO offers (guild_id, ticket_id, version, status, game, start_rank, target, scope, price_cents, currency,
             timeframe, cancellation_terms, content_hash, created_by, created_at)
           VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
        )
        .run(this.ctx.config.guildId, ticket.id, version, game, startRank, target, scope, priceCents, currency, offerHash(base), actor.userId, now);
      return this.repo.offer(Number(info.lastInsertRowid))!;
    });
    return create();
  }

  /** Schritt 2: Zeitraum und Abbruchbedingungen ergänzen. */
  completeDraft(actor: Actor, offerId: number, channelId: string | null, terms: OfferTermsInput): OfferRow {
    const { offer, ticket } = this.loadInChannel(offerId, channelId);
    assertAllowed(actor, authConfig(this.ctx), 'offer.create', this.repo.scopeOfTicket(ticket));
    if (offer.status !== 'draft') throw new UserError('Dieser Entwurf wurde bereits gesendet oder verworfen.');
    const timeframe = sanitizeUserText(terms.timeframe, 100);
    const cancel = sanitizeUserText(terms.cancellationTerms, 1000);
    if (!timeframe || !cancel) throw new UserError('Zeitraum und Abbruchbedingungen sind Pflichtfelder.');
    const updated = { ...offer, timeframe, cancellation_terms: cancel };
    const changed = this.ctx.db
      .prepare("UPDATE offers SET timeframe = ?, cancellation_terms = ?, content_hash = ? WHERE id = ? AND status = 'draft'")
      .run(timeframe, cancel, offerHash(updated), offer.id).changes;
    if (!changed) throw new UserError('Dieser Entwurf wurde zwischenzeitlich verändert.');
    return this.repo.offer(offer.id)!;
  }

  discardDraft(actor: Actor, offerId: number, channelId: string | null): void {
    const { offer, ticket } = this.loadInChannel(offerId, channelId);
    assertAllowed(actor, authConfig(this.ctx), 'offer.create', this.repo.scopeOfTicket(ticket));
    this.ctx.db.prepare("UPDATE offers SET status = 'withdrawn' WHERE id = ? AND status = 'draft'").run(offer.id);
  }

  /** Sendet einen vollständigen Entwurf an den Kunden. Ältere offene Versionen werden ersetzt. */
  async send(actor: Actor, offerId: number, channelId: string | null): Promise<OfferRow> {
    const { offer, ticket } = this.loadInChannel(offerId, channelId);
    assertAllowed(actor, authConfig(this.ctx), 'offer.create', this.repo.scopeOfTicket(ticket));
    this.requireOpenGameTicket(ticket);
    if (offer.status !== 'draft') throw new UserError('Dieser Entwurf wurde bereits gesendet oder verworfen.');
    if (!offer.timeframe || !offer.cancellation_terms) throw new UserError('Bitte zuerst Zeitraum und Abbruchbedingungen ergänzen.');
    return this.ctx.locks.run(`ticket:${ticket.id}:offer`, async () => {
      const now = this.ctx.clock.now();
      const superseded = this.ctx.db
        .prepare<[number], OfferRow>("SELECT * FROM offers WHERE ticket_id = ? AND status = 'sent'")
        .all(ticket.id);
      this.ctx.db.transaction(() => {
        this.ctx.db.prepare("UPDATE offers SET status = 'superseded' WHERE ticket_id = ? AND status = 'sent'").run(ticket.id);
        const changed = this.ctx.db
          .prepare("UPDATE offers SET status = 'sent', sent_at = ? WHERE id = ? AND status = 'draft'")
          .run(now, offer.id).changes;
        if (!changed) throw new UserError('Dieser Entwurf wurde bereits gesendet.');
        if (!this.repo.orderByTicket(ticket.id)) {
          this.ctx.db.prepare("UPDATE tickets SET phase = 'angebot_gesendet', updated_at = ? WHERE id = ?").run(now, ticket.id);
        }
      })();
      const sent = this.repo.offer(offer.id)!;
      if (ticket.channel_id) {
        for (const old of superseded) {
          if (old.message_id) {
            await this.ctx.port
              .editMessage(ticket.channel_id, old.message_id, offerEmbed(this.repo.offer(old.id)!, ticket, this.ctx.config.timezone, false))
              .catch(() => undefined);
          }
        }
        const messageId = await this.ctx.port.sendMessage(ticket.channel_id, {
          ...offerEmbed(sent, ticket, this.ctx.config.timezone),
          content: `<@${ticket.customer_id}> Neues Angebot (Version ${sent.version}).`,
          allowedMentions: { users: [ticket.customer_id] },
        });
        this.ctx.db.prepare('UPDATE offers SET message_id = ? WHERE id = ?').run(messageId, sent.id);
      }
      this.ctx.audit.record(actor.userId, 'offer.sent', { type: 'offer', id: sent.id }, { ticket: ticket.id, version: sent.version });
      await this.ctx.audit.teamLog('Angebot gesendet', [`${ticketLabel(ticket)} – Version ${sent.version}, ${formatPrice(sent.price_cents, sent.currency)}`]);
      await this.s.tickets.refreshSummary(this.repo.ticket(ticket.id)!);
      return this.repo.offer(sent.id)!;
    });
  }

  /** Prüft, ob der Kunde dieses konkrete Angebot annehmen darf (für die Rückfrage). */
  validateAcceptance(actor: Actor, offerId: number, hashPrefix: string, channelId: string | null): { offer: OfferRow; ticket: TicketRow } {
    const { offer, ticket } = this.loadInChannel(offerId, channelId);
    assertAllowed(actor, authConfig(this.ctx), 'offer.accept', this.repo.scopeOfTicket(ticket));
    if (ticket.status !== 'open') throw new UserError('Das Ticket ist nicht offen.');
    if (offer.status === 'accepted') throw new UserError('Dieses Angebot wurde bereits angenommen.');
    if (offer.status !== 'sent') throw new UserError('Dieses Angebot ist nicht mehr gültig (ersetzt, abgelehnt oder zurückgezogen).');
    if (hashPrefix.length < 16 || !offer.content_hash.startsWith(hashPrefix)) {
      throw new UserError('Die Angebotsdaten haben sich geändert. Bitte die aktuelle Version prüfen.');
    }
    const latest = this.repo.latestOffer(ticket.id);
    if (latest && latest.version > offer.version && latest.status === 'sent') {
      throw new UserError('Es gibt eine neuere Angebotsversion. Bitte diese prüfen.');
    }
    const order = this.repo.orderByTicket(ticket.id);
    if (order && isFinal(order.status)) throw new UserError('Der Auftrag ist bereits abgeschlossen oder storniert.');
    return { offer, ticket };
  }

  /** Annahme: erzeugt den Auftrag (oder aktualisiert ihn bei einer Änderungsversion). */
  async accept(actor: Actor, offerId: number, hashPrefix: string, channelId: string | null): Promise<{ offer: OfferRow; order: OrderRow; created: boolean }> {
    const { ticket } = this.validateAcceptance(actor, offerId, hashPrefix, channelId);
    return this.ctx.locks.run(`ticket:${ticket.id}:offer`, async () => {
      const { offer } = this.validateAcceptance(actor, offerId, hashPrefix, channelId);
      const now = this.ctx.clock.now();
      let created = false;
      const orderId = this.ctx.db.transaction((): number => {
        const changed = this.ctx.db
          .prepare("UPDATE offers SET status = 'accepted', decided_at = ?, decided_by = ? WHERE id = ? AND status = 'sent' AND content_hash = ?")
          .run(now, actor.userId, offer.id, offer.content_hash).changes;
        if (changed !== 1) throw new UserError('Dieses Angebot wurde bereits bearbeitet.');
        const existing = this.repo.orderByTicket(ticket.id);
        this.ctx.db.prepare("UPDATE tickets SET phase = 'angebot_angenommen', updated_at = ? WHERE id = ?").run(now, ticket.id);
        if (existing) {
          this.ctx.db
            .prepare(
              'UPDATE orders SET accepted_offer_id = ?, accepted_offer_version = ?, accepted_offer_hash = ?, start_rank = ?, target = ?, updated_at = ? WHERE id = ?',
            )
            .run(offer.id, offer.version, offer.content_hash, offer.start_rank, offer.target, now, existing.id);
          this.repo.addOrderEvent(existing.id, actor.userId, 'offer_changed', String(existing.accepted_offer_version), String(offer.version), null, now);
          return existing.id;
        }
        const info = this.ctx.db
          .prepare(
            `INSERT INTO orders (guild_id, ticket_id, customer_id, game, start_rank, target, accepted_offer_id, accepted_offer_version,
               accepted_offer_hash, operator_id, status, payment_status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'angebot_angenommen', 'offen', ?, ?)`,
          )
          .run(
            this.ctx.config.guildId,
            ticket.id,
            ticket.customer_id,
            offer.game,
            offer.start_rank,
            offer.target,
            offer.id,
            offer.version,
            offer.content_hash,
            ticket.assigned_operator_id,
            now,
            now,
          );
        const id = Number(info.lastInsertRowid);
        this.repo.addOrderEvent(id, actor.userId, 'created', null, 'angebot_angenommen', { offerVersion: offer.version }, now);
        created = true;
        return id;
      })();
      const order = this.repo.order(orderId)!;
      const accepted = this.repo.offer(offer.id)!;
      if (ticket.channel_id && accepted.message_id) {
        await this.ctx.port
          .editMessage(ticket.channel_id, accepted.message_id, offerEmbed(accepted, ticket, this.ctx.config.timezone, false))
          .catch(() => undefined);
      }
      const customerRole = this.ctx.registry.roleId('customer');
      if (customerRole) {
        await this.ctx.port.addRole(ticket.customer_id, customerRole, `Auftrag #${order.id}`).catch((err: unknown) => {
          this.ctx.log.warn({ err: errInfo(err) }, 'Kunden-Rolle konnte nicht vergeben werden');
        });
      }
      await this.s.tickets.notify(
        this.repo.ticket(ticket.id)!,
        created
          ? `Angebot v${accepted.version} wurde angenommen. Auftrag **#${order.id}** ist angelegt (Status: Angebot angenommen).`
          : `Die geänderte Angebotsversion v${accepted.version} wurde angenommen und gilt jetzt für Auftrag **#${order.id}**.`,
      );
      this.ctx.audit.record(actor.userId, 'offer.accepted', { type: 'offer', id: accepted.id }, { order: order.id, version: accepted.version, created });
      await this.ctx.audit.teamLog(created ? 'Auftrag angelegt' : 'Angebotsänderung angenommen', [
        `Auftrag #${order.id} – ${GAME_SHORT[order.game]} – ${ticketLabel(ticket)} – Angebot v${accepted.version}`,
      ]);
      await this.s.tickets.refreshSummary(this.repo.ticket(ticket.id)!);
      if (!created) await this.s.proofs.onOrderDataChanged(order.id);
      this.s.overview.schedule();
      return { offer: accepted, order, created };
    });
  }

  async decline(actor: Actor, offerId: number, channelId: string | null): Promise<OfferRow> {
    const { offer, ticket } = this.loadInChannel(offerId, channelId);
    assertAllowed(actor, authConfig(this.ctx), 'offer.accept', this.repo.scopeOfTicket(ticket));
    const changed = this.ctx.db
      .prepare("UPDATE offers SET status = 'declined', decided_at = ?, decided_by = ? WHERE id = ? AND status = 'sent'")
      .run(this.ctx.clock.now(), actor.userId, offer.id).changes;
    if (!changed) throw new UserError('Dieses Angebot ist nicht mehr offen.');
    const updated = this.repo.offer(offer.id)!;
    if (ticket.channel_id && updated.message_id) {
      await this.ctx.port.editMessage(ticket.channel_id, updated.message_id, offerEmbed(updated, ticket, this.ctx.config.timezone, false)).catch(() => undefined);
    }
    await this.s.tickets.notify(ticket, `Angebot v${updated.version} wurde abgelehnt. Das Team kann eine neue Version erstellen.`);
    this.ctx.audit.record(actor.userId, 'offer.declined', { type: 'offer', id: updated.id });
    return updated;
  }

  async withdraw(actor: Actor, ticket: TicketRow): Promise<OfferRow> {
    assertAllowed(actor, authConfig(this.ctx), 'offer.withdraw', this.repo.scopeOfTicket(ticket));
    const sent = this.ctx.db
      .prepare<[number], OfferRow>("SELECT * FROM offers WHERE ticket_id = ? AND status = 'sent' ORDER BY version DESC LIMIT 1")
      .get(ticket.id);
    if (!sent) throw new UserError('Es gibt kein offenes Angebot.');
    this.ctx.db.prepare("UPDATE offers SET status = 'withdrawn', decided_at = ?, decided_by = ? WHERE id = ? AND status = 'sent'").run(this.ctx.clock.now(), actor.userId, sent.id);
    const updated = this.repo.offer(sent.id)!;
    if (ticket.channel_id && updated.message_id) {
      await this.ctx.port.editMessage(ticket.channel_id, updated.message_id, offerEmbed(updated, ticket, this.ctx.config.timezone, false)).catch(() => undefined);
    }
    await this.s.tickets.notify(ticket, `Angebot v${updated.version} wurde vom Team zurückgezogen.`);
    this.ctx.audit.record(actor.userId, 'offer.withdrawn', { type: 'offer', id: updated.id });
    return updated;
  }

  list(actor: Actor, ticket: TicketRow): OfferRow[] {
    assertAllowed(actor, authConfig(this.ctx), 'offer.view', this.repo.scopeOfTicket(ticket));
    return this.repo.offersOfTicket(ticket.id).filter((o) => o.status !== 'draft' || o.created_by === actor.userId);
  }

  private loadInChannel(offerId: number, channelId: string | null): { offer: OfferRow; ticket: TicketRow } {
    const offer = this.repo.offer(offerId);
    if (!offer) throw new UserError('Dieses Angebot existiert nicht.');
    const ticket = this.repo.ticket(offer.ticket_id);
    if (!ticket || !channelId || ticket.channel_id !== channelId) throw new UserError('Dieses Angebot gehört nicht zu diesem Kanal.');
    return { offer, ticket };
  }

  static defaultCurrency(c: string): Currency {
    return (CURRENCIES as readonly string[]).includes(c) ? (c as Currency) : 'EUR';
  }
}
