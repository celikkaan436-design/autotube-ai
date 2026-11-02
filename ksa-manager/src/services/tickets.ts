import { ticketSummary, ticketWelcomeText } from '../content/views.js';
import { errorCode, isUnknownResource, DiscordErrorCode } from '../discord/port.js';
import { isGame, TICKET_KIND_LABEL, TICKET_KIND_SLUG, type TicketKind } from '../domain/constants.js';
import { assertAllowed, atLeast, resolveLevel, type Actor } from '../domain/permissions.js';
import { isActive } from '../domain/orderStatus.js';
import { errInfo } from '../logging/logger.js';
import { CATEGORIES, overwritesFor, TICKET_MEMBER_ALLOW, ticketOverwrites, type RoleKey } from '../setup/blueprint.js';
import { UserError } from '../util/errors.js';
import { padNumber, sanitizeUserText } from '../util/text.js';
import { authConfig, type AppContext } from './context.js';
import { CooldownService } from './cooldowns.js';
import { categoryResKey } from './registry.js';
import { ticketLabel, type TicketRow } from './repo.js';

export interface RankedRequestForm {
  currentRank: string;
  targetRank: string;
  platform: string;
  timeframe: string;
  details: string;
}

export interface SupportRequestForm {
  subject: string;
  description: string;
}

const MAX_CHANNELS_PER_CATEGORY = 50;

/** Extrahiert eine SR-Angabe wie "Gold II, 4.300 SR" → 4300 (falls vorhanden). */
export function extractSr(input: string): number | null {
  const m = /(\d{1,3}(?:[.\s]\d{3})+|\d{1,6})\s*SR\b/i.exec(input) ?? /\bSR\s*[:=]?\s*(\d{1,3}(?:[.\s]\d{3})+|\d{1,6})/i.exec(input);
  if (!m?.[1]) return null;
  const n = Number(m[1].replace(/[.\s]/g, ''));
  return Number.isSafeInteger(n) && n >= 0 && n <= 1_000_000 ? n : null;
}

export class TicketService {
  readonly cooldowns: CooldownService;

  constructor(private readonly ctx: AppContext) {
    this.cooldowns = new CooldownService(ctx.db, ctx.config.guildId);
  }

  private get repo() {
    return this.ctx.repo;
  }

  /** Vorabprüfung vor dem Anzeigen des Formulars (wird beim Absenden erneut geprüft). */
  precheck(actor: Actor): void {
    const now = this.ctx.clock.now();
    const remaining = this.cooldowns.remaining(actor.userId, 'ticket.create', now);
    if (remaining > 0) {
      throw new UserError(`Bitte warte noch ${Math.ceil(remaining / 1000)} Sekunden, bevor du ein weiteres Ticket erstellst.`);
    }
    const max = this.ctx.settings.get('tickets.maxOpenPerUser');
    const open = this.repo.ticketsOfCustomer(actor.userId, ['open', 'creating']);
    if (open.length >= max) {
      const list = open.filter((t) => t.channel_id).map((t) => `<#${t.channel_id}>`).join(', ');
      throw new UserError(`Du hast bereits ${open.length} offene(s) Ticket(s)${list ? `: ${list}` : ''}. Maximal erlaubt: ${max}.`);
    }
    if (!this.ctx.registry.categoryId('tickets_open')) {
      throw new UserError('Das Ticketsystem ist noch nicht eingerichtet. Bitte wende dich an das Team.');
    }
  }

  /**
   * Erstellt ein Ticket. Reihenfolge: Sperre → Cooldown → Limit + Reservierung (Transaktion)
   * → Kanal → Speichern → Zusammenfassung → gezielte Support-Benachrichtigung.
   */
  async create(actor: Actor, kind: TicketKind, form: RankedRequestForm | SupportRequestForm): Promise<TicketRow> {
    return this.ctx.locks.run(`ticket-create:${actor.userId}`, async () => {
      const now = this.ctx.clock.now();
      this.precheck(actor);
      const max = this.ctx.settings.get('tickets.maxOpenPerUser');

      const reserve = this.ctx.db.transaction((): TicketRow => {
        const open = this.ctx.db
          .prepare<[string, string], { n: number }>(
            "SELECT COUNT(*) AS n FROM tickets WHERE guild_id = ? AND customer_id = ? AND status IN ('open','creating')",
          )
          .get(this.ctx.config.guildId, actor.userId);
        if ((open?.n ?? 0) >= max) throw new UserError(`Du hast bereits die maximale Anzahl offener Tickets (${max}).`);
        const number = this.repo.nextCounter('ticket');
        const isRanked = isGame(kind);
        const ranked = isRanked ? (form as RankedRequestForm) : undefined;
        const support = !isRanked ? (form as SupportRequestForm) : undefined;
        const info = this.ctx.db
          .prepare(
            `INSERT INTO tickets (guild_id, number, kind, customer_id, status, phase, current_rank, current_sr, target_rank,
               platform, timeframe, details, subject, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'creating', 'anfrage', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            this.ctx.config.guildId,
            number,
            kind,
            actor.userId,
            ranked ? sanitizeUserText(ranked.currentRank, 100) : null,
            ranked ? extractSr(ranked.currentRank) : null,
            ranked ? sanitizeUserText(ranked.targetRank, 100) : null,
            ranked ? sanitizeUserText(ranked.platform, 50) : null,
            ranked ? sanitizeUserText(ranked.timeframe, 100) : null,
            ranked ? sanitizeUserText(ranked.details, 1000) : sanitizeUserText(support?.description ?? '', 1500),
            support ? sanitizeUserText(support.subject, 100) : null,
            now,
            now,
          );
        return this.repo.ticket(Number(info.lastInsertRowid))!;
      });
      const reserved = reserve();
      const cooldown = this.ctx.settings.get('tickets.createCooldownSeconds');
      if (cooldown > 0) this.cooldowns.set(actor.userId, 'ticket.create', now + cooldown * 1000);

      let channelId: string | null = null;
      try {
        const parentId = await this.ensureTicketCategory('open');
        channelId = await this.ctx.port.createChannel({
          name: `ticket-${padNumber(reserved.number)}-${TICKET_KIND_SLUG[kind]}`,
          kind: 'text',
          parentId,
          topic: `Ticket ${ticketLabel(reserved)} – ${TICKET_KIND_LABEL[kind]}. Privat: Kunde, Support und zugewiesenes Team.`,
          overwrites: ticketOverwrites(
            { guildId: this.ctx.config.guildId, botUserId: this.ctx.port.botUserId(), roles: this.roleMap() },
            actor.userId,
            null,
          ),
          reason: `Ticket ${ticketLabel(reserved)} erstellt`,
        });
        this.ctx.db
          .prepare("UPDATE tickets SET channel_id = ?, status = 'open', updated_at = ? WHERE id = ? AND status = 'creating'")
          .run(channelId, now, reserved.id);
      } catch (err) {
        this.ctx.log.error({ err: errInfo(err), ticketId: reserved.id }, 'Ticketkanal konnte nicht erstellt werden');
        this.ctx.db.prepare("UPDATE tickets SET status = 'failed', updated_at = ? WHERE id = ?").run(now, reserved.id);
        this.cooldowns.clear(actor.userId, 'ticket.create');
        if (channelId) await this.ctx.port.deleteChannel(channelId, 'Ticket-Erstellung fehlgeschlagen').catch(() => false);
        throw new UserError('Das Ticket konnte nicht erstellt werden. Bitte versuche es später erneut oder wende dich an das Team.');
      }

      const ticket = this.repo.ticket(reserved.id)!;
      try {
        const summaryId = await this.ctx.port.sendMessage(channelId, ticketSummary(ticket, undefined));
        this.ctx.db.prepare('UPDATE tickets SET summary_message_id = ? WHERE id = ?').run(summaryId, ticket.id);
        await this.ctx.port.sendMessage(channelId, {
          content: ticketWelcomeText(ticket, max),
          allowedMentions: { users: [actor.userId] },
        });
        const supportRole = this.ctx.registry.roleId('support');
        if (supportRole) {
          await this.ctx.port.sendMessage(channelId, {
            content: `<@&${supportRole}> Neue Anfrage: ${TICKET_KIND_LABEL[kind]} – Ticket ${ticketLabel(ticket)}.`,
            allowedMentions: { roles: [supportRole] },
          });
        }
      } catch (err) {
        this.ctx.log.warn({ err: errInfo(err), ticketId: ticket.id }, 'Ticket-Zusammenfassung konnte nicht vollständig gepostet werden');
      }
      this.ctx.audit.record(actor.userId, 'ticket.created', { type: 'ticket', id: ticket.id }, { kind, number: ticket.number });
      await this.ctx.audit.teamLog('Neues Ticket', [`${ticketLabel(ticket)} – ${TICKET_KIND_LABEL[kind]}`, `Kanal: <#${channelId}>`]);
      return this.repo.ticket(ticket.id)!;
    });
  }

  /** Ticket aus Custom-ID laden und gegen Kanal/Server prüfen (Schutz vor manipulierten IDs). */
  requireTicketInChannel(ticketId: number, channelId: string | null): TicketRow {
    const t = this.repo.ticket(ticketId);
    if (!t) throw new UserError('Dieses Ticket existiert nicht.');
    if (!channelId || t.channel_id !== channelId) throw new UserError('Diese Aktion gehört nicht zu diesem Kanal.');
    return t;
  }

  requireTicketByChannel(channelId: string | null): TicketRow {
    const t = channelId ? this.repo.ticketByChannel(channelId) : undefined;
    if (!t) throw new UserError('Dieser Befehl funktioniert nur in einem Ticketkanal.');
    return t;
  }

  async claim(actor: Actor, ticketId: number, channelId: string | null): Promise<TicketRow> {
    const t = this.requireTicketInChannel(ticketId, channelId);
    assertAllowed(actor, authConfig(this.ctx), 'ticket.claim', this.repo.scopeOfTicket(t));
    if (t.status !== 'open') throw new UserError('Das Ticket ist nicht offen.');
    return this.ctx.locks.run(`ticket:${t.id}`, async () => {
      const now = this.ctx.clock.now();
      const changed = this.ctx.db
        .prepare('UPDATE tickets SET claimed_by = ?, updated_at = ? WHERE id = ? AND claimed_by IS NULL')
        .run(actor.userId, now, t.id).changes;
      if (changed === 0) {
        const current = this.repo.ticket(t.id)!;
        if (current.claimed_by === actor.userId) throw new UserError('Du hast dieses Ticket bereits übernommen.');
        throw new UserError(`Dieses Ticket wurde bereits von <@${current.claimed_by}> übernommen.`);
      }
      this.ctx.audit.record(actor.userId, 'ticket.claimed', { type: 'ticket', id: t.id });
      const updated = this.repo.ticket(t.id)!;
      await this.refreshSummary(updated);
      await this.notify(updated, `<@${actor.userId}> hat das Ticket übernommen.`);
      return updated;
    });
  }

  async assignOperator(actor: Actor, ticketId: number, channelId: string | null, operatorUserId: string): Promise<TicketRow> {
    const t = this.requireTicketInChannel(ticketId, channelId);
    assertAllowed(actor, authConfig(this.ctx), 'ticket.assign', this.repo.scopeOfTicket(t));
    if (t.status !== 'open') throw new UserError('Das Ticket ist nicht offen.');
    if (t.kind === 'support') throw new UserError('Support-Tickets haben keinen Operator.');
    if (operatorUserId === t.customer_id) throw new UserError('Der Kunde kann nicht als Operator zugewiesen werden.');
    const member = await this.ctx.port.fetchMember(operatorUserId, { force: true });
    if (!member || member.isBot) throw new UserError('Dieses Mitglied ist nicht auf dem Server.');
    const level = resolveLevel({ userId: member.userId, roleIds: member.roleIds }, authConfig(this.ctx));
    if (!atLeast(level, 'operator')) throw new UserError('Nur Mitglieder mit der Rolle KSA Operator (oder höher) können zugewiesen werden.');

    return this.ctx.locks.run(`ticket:${t.id}`, async () => {
      const now = this.ctx.clock.now();
      const current = this.repo.ticket(t.id)!;
      const previous = current.assigned_operator_id;
      if (previous === operatorUserId) throw new UserError('Dieses Mitglied ist bereits zugewiesen.');
      const order = this.repo.orderByTicket(t.id);
      this.ctx.db.transaction(() => {
        this.ctx.db.prepare('UPDATE tickets SET assigned_operator_id = ?, updated_at = ? WHERE id = ?').run(operatorUserId, now, t.id);
        if (order) {
          this.ctx.db.prepare('UPDATE orders SET operator_id = ?, updated_at = ? WHERE id = ?').run(operatorUserId, now, order.id);
          this.repo.addOrderEvent(order.id, actor.userId, 'operator', previous, operatorUserId, null, now);
        }
      })();
      if (current.channel_id) {
        if (previous && previous !== current.customer_id) {
          await this.ctx.port.removeOverwrite(current.channel_id, previous, 'Operator gewechselt').catch(() => undefined);
        }
        await this.ctx.port.setOverwrite(
          current.channel_id,
          { id: operatorUserId, type: 'member', allow: TICKET_MEMBER_ALLOW, deny: 0n },
          'Operator zugewiesen',
        );
      }
      this.ctx.audit.record(actor.userId, 'ticket.assigned', { type: 'ticket', id: t.id }, { operator: operatorUserId, previous });
      const updated = this.repo.ticket(t.id)!;
      await this.refreshSummary(updated);
      await this.notify(updated, `<@${operatorUserId}> wurde als Operator zugewiesen.`, [operatorUserId]);
      return updated;
    });
  }

  /** Schließt ein Ticket: Kunde verliert Zugriff, Kanal wandert ins Archiv (ohne Rechte-Sync). */
  async close(actor: Actor, ticketId: number, channelId: string | null, reason: string | null): Promise<TicketRow> {
    const t = channelId === null ? this.repo.ticket(ticketId) : this.requireTicketInChannel(ticketId, channelId);
    if (!t) throw new UserError('Dieses Ticket existiert nicht.');
    assertAllowed(actor, authConfig(this.ctx), 'ticket.close', this.repo.scopeOfTicket(t));
    const level = resolveLevel(actor, authConfig(this.ctx));
    const order = this.repo.orderByTicket(t.id);
    if (!atLeast(level, 'support') && order && isActive(order.status)) {
      throw new UserError('Solange dein Auftrag aktiv ist, kann nur das Team das Ticket schließen.');
    }
    return this.ctx.locks.run(`ticket:${t.id}`, async () => {
      const now = this.ctx.clock.now();
      const changed = this.ctx.db
        .prepare(
          "UPDATE tickets SET status = 'closed', closed_at = ?, closed_by = ?, close_reason = ?, updated_at = ? WHERE id = ? AND status = 'open'",
        )
        .run(now, actor.userId, reason ? sanitizeUserText(reason, 300) : null, now, t.id).changes;
      if (changed === 0) throw new UserError('Das Ticket ist bereits geschlossen.');
      const updated = this.repo.ticket(t.id)!;
      if (updated.channel_id) {
        try {
          await this.ctx.port.sendMessage(updated.channel_id, {
            content: `Ticket ${ticketLabel(updated)} wurde von <@${actor.userId}> geschlossen.${reason ? ` Grund: ${sanitizeUserText(reason, 300)}` : ''}\nDer Kanal wird archiviert; der Kunde hat keinen Zugriff mehr. Ein Export ist über \`/ticket export\` möglich.`,
            allowedMentions: {},
          });
          const archive = await this.ensureTicketCategory('archive');
          await this.ctx.port.editChannel(updated.channel_id, {
            parentId: archive,
            overwrites: ticketOverwrites(
              { guildId: this.ctx.config.guildId, botUserId: this.ctx.port.botUserId(), roles: this.roleMap() },
              null,
              null,
            ),
            reason: `Ticket ${ticketLabel(updated)} geschlossen`,
          });
          await this.refreshSummary(this.repo.ticket(t.id)!);
        } catch (err) {
          if (isUnknownResource(err)) this.markChannelDeleted(updated.channel_id);
          else this.ctx.log.warn({ err: errInfo(err), ticketId: t.id }, 'Archivieren des Ticketkanals fehlgeschlagen');
        }
      }
      this.ctx.audit.record(actor.userId, 'ticket.closed', { type: 'ticket', id: t.id }, { reason: reason ? 'angegeben' : null });
      await this.ctx.audit.teamLog('Ticket geschlossen', [`${ticketLabel(updated)} von <@${actor.userId}>`]);
      return this.repo.ticket(t.id)!;
    });
  }

  async reopen(actor: Actor, ticketNumber: number): Promise<TicketRow> {
    const t = this.repo.ticketByNumber(ticketNumber);
    if (!t) throw new UserError('Dieses Ticket existiert nicht.');
    assertAllowed(actor, authConfig(this.ctx), 'ticket.reopen', this.repo.scopeOfTicket(t));
    if (t.status === 'channel_deleted' || !t.channel_id) throw new UserError('Der Ticketkanal existiert nicht mehr. Bitte ein neues Ticket erstellen.');
    if (t.status !== 'closed') throw new UserError('Nur geschlossene Tickets können wiedereröffnet werden.');
    return this.ctx.locks.run(`ticket:${t.id}`, async () => {
      const now = this.ctx.clock.now();
      const channel = await this.ctx.port.getChannel(t.channel_id!);
      if (!channel) {
        this.markChannelDeleted(t.channel_id!);
        throw new UserError('Der Ticketkanal wurde gelöscht. Bitte ein neues Ticket erstellen.');
      }
      const customer = await this.ctx.port.fetchMember(t.customer_id, { force: true });
      const operator = t.assigned_operator_id ? await this.ctx.port.fetchMember(t.assigned_operator_id, { force: true }) : null;
      const changed = this.ctx.db
        .prepare(
          "UPDATE tickets SET status = 'open', closed_at = NULL, closed_by = NULL, close_reason = NULL, reopen_count = reopen_count + 1, customer_left = ?, updated_at = ? WHERE id = ? AND status = 'closed'",
        )
        .run(customer ? 0 : 1, now, t.id).changes;
      if (changed === 0) throw new UserError('Das Ticket wurde bereits wiedereröffnet.');
      const open = await this.ensureTicketCategory('open');
      await this.ctx.port.editChannel(t.channel_id!, {
        parentId: open,
        overwrites: ticketOverwrites(
          { guildId: this.ctx.config.guildId, botUserId: this.ctx.port.botUserId(), roles: this.roleMap() },
          customer ? t.customer_id : null,
          operator ? t.assigned_operator_id : null,
        ),
        reason: `Ticket ${ticketLabel(t)} wiedereröffnet`,
      });
      const updated = this.repo.ticket(t.id)!;
      await this.refreshSummary(updated);
      await this.notify(
        updated,
        `Ticket wurde von <@${actor.userId}> wiedereröffnet.${customer ? ` <@${t.customer_id}>` : ' Hinweis: Der Kunde ist nicht mehr auf dem Server.'}`,
        customer ? [t.customer_id] : [],
      );
      this.ctx.audit.record(actor.userId, 'ticket.reopened', { type: 'ticket', id: t.id });
      return updated;
    });
  }

  /** Gelöschter Kanal: Ticket als solches markieren, aktive Proofs verwerfen. */
  markChannelDeleted(channelId: string): TicketRow | undefined {
    const t = this.repo.ticketByChannel(channelId);
    if (!t || t.status === 'channel_deleted') return t;
    const now = this.ctx.clock.now();
    this.ctx.db.prepare("UPDATE tickets SET status = 'channel_deleted', updated_at = ? WHERE id = ?").run(now, t.id);
    this.ctx.audit.record('system', 'ticket.channel_deleted', { type: 'ticket', id: t.id });
    void this.ctx.audit.teamLog('Ticketkanal gelöscht', [`${ticketLabel(t)}: Der Kanal wurde gelöscht. Auftragsdaten bleiben erhalten.`]);
    return this.repo.ticket(t.id);
  }

  /** Mitglied hat den Server verlassen. */
  async handleMemberLeft(userId: string): Promise<void> {
    const now = this.ctx.clock.now();
    const asCustomer = this.repo.ticketsOfCustomer(userId, ['open']);
    for (const t of asCustomer) {
      this.ctx.db.prepare('UPDATE tickets SET customer_left = 1, updated_at = ? WHERE id = ?').run(now, t.id);
      await this.notify(this.repo.ticket(t.id)!, 'Hinweis: Der Kunde hat den Server verlassen. Das Ticket bleibt für das Team erhalten.');
      await this.refreshSummary(this.repo.ticket(t.id)!);
    }
    const asOperator = this.ctx.db
      .prepare<[string, string], TicketRow>("SELECT * FROM tickets WHERE guild_id = ? AND assigned_operator_id = ? AND status = 'open'")
      .all(this.ctx.config.guildId, userId);
    for (const t of asOperator) {
      this.ctx.db.transaction(() => {
        this.ctx.db.prepare('UPDATE tickets SET assigned_operator_id = NULL, updated_at = ? WHERE id = ?').run(now, t.id);
        const order = this.repo.orderByTicket(t.id);
        if (order) {
          this.ctx.db.prepare('UPDATE orders SET operator_id = NULL, updated_at = ? WHERE id = ?').run(now, order.id);
          this.repo.addOrderEvent(order.id, 'system', 'operator', userId, null, { reason: 'Mitglied hat den Server verlassen' }, now);
        }
      })();
      const supportRole = this.ctx.registry.roleId('support');
      if (t.channel_id) {
        await this.ctx.port
          .sendMessage(t.channel_id, {
            content: `${supportRole ? `<@&${supportRole}> ` : ''}Der zugewiesene Operator hat den Server verlassen. Bitte neu zuweisen.`,
            allowedMentions: supportRole ? { roles: [supportRole] } : {},
          })
          .catch(() => undefined);
      }
      await this.refreshSummary(this.repo.ticket(t.id)!);
    }
  }

  /** Kunde ist zurück: Zugriff auf offene Tickets wiederherstellen. */
  async handleMemberRejoined(userId: string): Promise<void> {
    const tickets = this.repo.ticketsOfCustomer(userId, ['open']).filter((t) => t.customer_left === 1 && t.channel_id);
    for (const t of tickets) {
      try {
        await this.ctx.port.setOverwrite(
          t.channel_id!,
          { id: userId, type: 'member', allow: TICKET_MEMBER_ALLOW, deny: 0n },
          'Kunde ist zurück',
        );
        this.ctx.db.prepare('UPDATE tickets SET customer_left = 0, updated_at = ? WHERE id = ?').run(this.ctx.clock.now(), t.id);
        await this.notify(this.repo.ticket(t.id)!, `<@${userId}> ist wieder auf dem Server.`, [userId]);
        await this.refreshSummary(this.repo.ticket(t.id)!);
      } catch (err) {
        this.ctx.log.warn({ err: errInfo(err), ticketId: t.id }, 'Zugriff konnte nicht wiederhergestellt werden');
      }
    }
  }

  async refreshSummary(t: TicketRow): Promise<void> {
    if (!t.channel_id || !t.summary_message_id) return;
    try {
      await this.ctx.port.editMessage(t.channel_id, t.summary_message_id, ticketSummary(t, this.repo.orderByTicket(t.id)));
    } catch (err) {
      if (errorCode(err) === DiscordErrorCode.UnknownChannel) this.markChannelDeleted(t.channel_id);
      else this.ctx.log.debug({ err: errInfo(err) }, 'Zusammenfassung nicht aktualisiert');
    }
  }

  async notify(t: TicketRow, content: string, pingUsers: string[] = []): Promise<void> {
    if (!t.channel_id || t.status === 'channel_deleted') return;
    try {
      await this.ctx.port.sendMessage(t.channel_id, { content, allowedMentions: { users: pingUsers } });
    } catch (err) {
      if (errorCode(err) === DiscordErrorCode.UnknownChannel) this.markChannelDeleted(t.channel_id);
      else this.ctx.log.warn({ err: errInfo(err), ticketId: t.id }, 'Ticket-Hinweis fehlgeschlagen');
    }
  }

  roleMap(): Partial<Record<RoleKey, string>> {
    const out: Partial<Record<RoleKey, string>> = {};
    for (const k of ['founder', 'admin', 'support', 'operator'] as const) {
      const id = this.ctx.registry.roleId(k);
      if (id) out[k] = id;
    }
    return out;
  }

  /**
   * Liefert eine Ticket-Kategorie mit freiem Platz (Discord: max. 50 Kanäle je Kategorie).
   * Bei Bedarf wird eine weitere Kategorie gleicher Rechte angelegt.
   */
  async ensureTicketCategory(which: 'open' | 'archive'): Promise<string> {
    const baseKey = which === 'open' ? 'tickets_open' : 'tickets_archive';
    const baseName = CATEGORIES.find((c) => c.key === baseKey)!.name;
    const snap = await this.ctx.port.snapshot();
    const candidates = [baseKey, ...Array.from({ length: 9 }, (_, i) => `${baseKey}_${i + 2}`)];
    for (const [i, key] of candidates.entries()) {
      const id = this.ctx.registry.categoryId(key);
      const exists = id ? snap.channels.find((c) => c.id === id && c.kind === 'category') : undefined;
      if (exists) {
        const children = snap.channels.filter((c) => c.parentId === exists.id).length;
        if (children < MAX_CHANNELS_PER_CATEGORY) return exists.id;
        continue;
      }
      if (i === 0 && !id) throw new UserError('Die Ticket-Kategorien sind nicht eingerichtet. Bitte /setup ausführen.');
      // Kategorie fehlt (gelöscht oder noch nicht angelegt) → neu anlegen.
      const roles: Partial<Record<RoleKey, string>> = this.roleMap();
      const created = await this.ctx.port.createChannel({
        name: i === 0 ? baseName : `${baseName} ${i + 1}`,
        kind: 'category',
        parentId: null,
        overwrites: overwritesFor('tickets', {
          guildId: this.ctx.config.guildId,
          botUserId: snap.bot.userId,
          roles,
          requireRulesAcceptance: false,
        }),
        reason: 'Zusätzliche Ticket-Kategorie',
      });
      this.ctx.registry.markDone(categoryResKey(key), 'category', created, this.ctx.clock.now());
      return created;
    }
    throw new UserError('Alle Ticket-Kategorien sind voll. Bitte alte Tickets archivieren oder löschen.');
  }
}
