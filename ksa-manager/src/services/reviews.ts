import { reviewPublicEmbed } from '../content/views.js';
import { isUnknownResource } from '../discord/port.js';
import { button, ButtonStyle, embed, row } from '../discord/ui.js';
import { COLORS } from '../domain/constants.js';
import { cid } from '../domain/customId.js';
import { assertAllowed, type Actor } from '../domain/permissions.js';
import { errInfo } from '../logging/logger.js';
import { UserError } from '../util/errors.js';
import { sanitizeUserText } from '../util/text.js';
import { authConfig, type AppContext } from './context.js';
import type { OrderRow, ReviewRow } from './repo.js';

export type ReviewPublication = 'none' | 'anonymous' | 'display_name';

export interface ReviewInput {
  stars: number;
  text: string | null;
  publication: ReviewPublication;
}

/**
 * Bewertungen: nur nach verifiziertem, abgeschlossenem Auftrag, eine je Auftrag
 * (UNIQUE-Constraint), Veröffentlichung nur mit ausdrücklicher Zustimmung.
 * Moderation kann Texte ausblenden, Sterne bleiben unverändert.
 */
export class ReviewService {
  constructor(private readonly ctx: AppContext) {}

  private get repo() {
    return this.ctx.repo;
  }

  async postInvitation(order: OrderRow): Promise<void> {
    const ticket = this.repo.ticket(order.ticket_id);
    if (!ticket?.channel_id || ticket.status !== 'open' || this.repo.reviewOfOrder(order.id)) return;
    await this.ctx.port.sendMessage(ticket.channel_id, {
      content: `<@${order.customer_id}>`,
      embeds: [
        embed({
          title: 'Wie zufrieden bist du?',
          description:
            'Dein Auftrag ist abgeschlossen. Du kannst freiwillig eine Bewertung abgeben (1–5 Sterne, optional mit Text). Du entscheidest selbst, ob und wie sie veröffentlicht wird.',
        }),
      ],
      components: [row(button(cid('rv', 'start', order.id), 'Bewertung abgeben', ButtonStyle.Primary))],
      allowedMentions: { users: [order.customer_id] },
    });
  }

  /** Prüft, ob der Nutzer diesen Auftrag (noch) bewerten darf. */
  assertCanReview(actor: Actor, orderId: number): OrderRow {
    const order = this.repo.order(orderId);
    if (!order) throw new UserError('Dieser Auftrag existiert nicht.');
    assertAllowed(actor, authConfig(this.ctx), 'review.submit', this.repo.scopeOfOrder(order));
    if (order.status !== 'abgeschlossen') throw new UserError('Bewertungen sind erst nach Abschluss des Auftrags möglich.');
    if (this.repo.reviewOfOrder(order.id)) throw new UserError('Für diesen Auftrag hast du bereits eine Bewertung abgegeben.');
    return order;
  }

  async submit(actor: Actor, orderId: number, input: ReviewInput): Promise<ReviewRow> {
    if (!Number.isInteger(input.stars) || input.stars < 1 || input.stars > 5) throw new UserError('Bitte 1 bis 5 Sterne wählen.');
    return this.ctx.locks.run(`review:${orderId}`, async () => {
      const order = this.assertCanReview(actor, orderId);
      const text = input.text ? sanitizeUserText(input.text, 1000) || null : null;
      let displayName: string | null = null;
      if (input.publication === 'display_name') {
        const m = await this.ctx.port.fetchMember(actor.userId);
        displayName = m ? sanitizeUserText(m.displayName, 80) : null;
      }
      const now = this.ctx.clock.now();
      let id: number;
      try {
        const info = this.ctx.db
          .prepare(
            `INSERT INTO reviews (guild_id, order_id, customer_id, stars, text, publish_consent, display_mode, display_name, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            this.ctx.config.guildId,
            order.id,
            actor.userId,
            input.stars,
            text,
            input.publication === 'none' ? 0 : 1,
            input.publication === 'display_name' ? 'display_name' : 'anonymous',
            displayName,
            now,
          );
        id = Number(info.lastInsertRowid);
      } catch (err) {
        if (String((err as Error).message).includes('UNIQUE')) throw new UserError('Für diesen Auftrag gibt es bereits eine Bewertung.');
        throw err;
      }
      this.ctx.audit.record(actor.userId, 'review.submitted', { type: 'review', id }, { stars: input.stars, publish: input.publication });
      let review = this.repo.review(id)!;
      if (review.publish_consent) review = await this.publish(review, order);
      await this.ctx.audit.teamLog('Neue Bewertung', [`Auftrag #${order.id}: ${input.stars}/5 Sterne · ${review.publish_consent ? 'veröffentlicht' : 'nicht öffentlich'}`]);
      return review;
    });
  }

  private async publish(review: ReviewRow, order: OrderRow): Promise<ReviewRow> {
    const channelId = this.ctx.registry.channelId('bewertungen');
    if (!channelId) return review;
    try {
      const messageId = await this.ctx.port.sendMessage(channelId, reviewPublicEmbed(review, order, this.ctx.config.timezone));
      this.ctx.db
        .prepare('UPDATE reviews SET public_channel_id = ?, public_message_id = ?, published_at = ? WHERE id = ?')
        .run(channelId, messageId, this.ctx.clock.now(), review.id);
    } catch (err) {
      this.ctx.log.warn({ err: errInfo(err), reviewId: review.id }, 'Bewertung konnte nicht veröffentlicht werden');
    }
    return this.repo.review(review.id)!;
  }

  /** Moderation: Text aus- oder einblenden. Sterne werden niemals verändert. */
  async setTextHidden(actor: Actor, reviewId: number, hidden: boolean, reason: string | null): Promise<ReviewRow> {
    const review = this.repo.review(reviewId);
    if (!review) throw new UserError('Diese Bewertung existiert nicht.');
    assertAllowed(actor, authConfig(this.ctx), 'review.moderate');
    if (Boolean(review.text_hidden) === hidden) throw new UserError(hidden ? 'Der Text ist bereits ausgeblendet.' : 'Der Text ist bereits sichtbar.');
    const now = this.ctx.clock.now();
    this.ctx.db
      .prepare('UPDATE reviews SET text_hidden = ?, hidden_by = ?, hidden_reason = ?, hidden_at = ? WHERE id = ?')
      .run(hidden ? 1 : 0, actor.userId, reason ? sanitizeUserText(reason, 300) : null, now, review.id);
    const updated = this.repo.review(review.id)!;
    const order = this.repo.order(updated.order_id)!;
    if (updated.public_channel_id && updated.public_message_id) {
      await this.ctx.port
        .editMessage(updated.public_channel_id, updated.public_message_id, reviewPublicEmbed(updated, order, this.ctx.config.timezone))
        .catch((err: unknown) => this.ctx.log.warn({ err: errInfo(err) }, 'Bewertung nicht aktualisiert'));
    }
    this.ctx.audit.record(actor.userId, hidden ? 'review.text_hidden' : 'review.text_shown', { type: 'review', id: review.id }, { reason: reason ? 'angegeben' : null });
    await this.ctx.audit.teamLog(hidden ? 'Bewertungstext ausgeblendet' : 'Bewertungstext eingeblendet', [`Bewertung #${review.id} durch <@${actor.userId}> (Sterne unverändert: ${review.stars}/5)`], COLORS.warning);
    return updated;
  }

  /** Kunde zieht die Veröffentlichung seiner Bewertung zurück. */
  async withdrawOwn(actor: Actor, reviewId: number): Promise<ReviewRow> {
    const review = this.repo.review(reviewId);
    if (!review) throw new UserError('Diese Bewertung existiert nicht.');
    assertAllowed(actor, authConfig(this.ctx), 'review.withdrawOwn', { customerId: review.customer_id, assignedOperatorId: null });
    if (!review.public_message_id || review.withdrawn_at) throw new UserError('Diese Bewertung ist nicht veröffentlicht.');
    try {
      await this.ctx.port.deleteMessage(review.public_channel_id!, review.public_message_id);
    } catch (err) {
      if (!isUnknownResource(err)) throw new UserError('Die Bewertung konnte nicht entfernt werden. Bitte später erneut versuchen.');
    }
    this.ctx.db.prepare('UPDATE reviews SET publish_consent = 0, withdrawn_at = ? WHERE id = ?').run(this.ctx.clock.now(), review.id);
    this.ctx.audit.record(actor.userId, 'review.withdrawn', { type: 'review', id: review.id });
    return this.repo.review(review.id)!;
  }

  ownReviews(actor: Actor): ReviewRow[] {
    return this.ctx.db
      .prepare<[string, string], ReviewRow>('SELECT * FROM reviews WHERE guild_id = ? AND customer_id = ? ORDER BY id DESC')
      .all(this.ctx.config.guildId, actor.userId);
  }

  ordersAwaitingReview(actor: Actor): OrderRow[] {
    return this.ctx.db
      .prepare<[string, string], OrderRow>(
        `SELECT o.* FROM orders o LEFT JOIN reviews r ON r.order_id = o.id
         WHERE o.guild_id = ? AND o.customer_id = ? AND o.status = 'abgeschlossen' AND r.id IS NULL ORDER BY o.id DESC LIMIT 25`,
      )
      .all(this.ctx.config.guildId, actor.userId);
  }
}
