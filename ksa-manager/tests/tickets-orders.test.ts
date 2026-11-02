import { PermissionFlagsBits as P } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { orderCustomerView } from '../src/content/views.js';
import { createOrder, GUILD, IDS, RANKED_FORM, setupWithMembers } from './helpers/context.js';

describe('Tickets', () => {
  it('erstellt einen privaten Kanal mit expliziten Rechten', async () => {
    const env = await setupWithMembers();
    const t = await env.s.tickets.create(env.actor(IDS.customer), 'warzone', RANKED_FORM);
    expect(t.status).toBe('open');
    expect(t.number).toBe(1);
    expect(t.current_sr).toBe(4300);
    const ch = env.port.channels.get(t.channel_id!)!;
    expect(ch.parentId).toBe(env.ctx.registry.categoryId('tickets_open'));
    const ow = (id: string) => ch.overwrites.find((o) => o.id === id);
    expect(ow(GUILD)!.deny & P.ViewChannel).toBe(P.ViewChannel);
    expect(ow(IDS.customer)!.allow & P.ViewChannel).toBe(P.ViewChannel);
    expect(ow(env.ctx.registry.roleId('support')!)!.allow & P.ViewChannel).toBe(P.ViewChannel);
    // Die Operator-Rolle sieht Tickets NICHT pauschal
    expect(ow(env.ctx.registry.roleId('operator')!)).toBeUndefined();
    expect(ow(IDS.customer2)).toBeUndefined();
    // Support wird gezielt per Rollen-Ping benachrichtigt
    const ping = env.port.messagesIn(t.channel_id!).find((m) => m.payload.allowedMentions?.roles?.length);
    expect(ping?.payload.allowedMentions?.roles).toEqual([env.ctx.registry.roleId('support')]);
  });

  it('begrenzt offene Tickets je Kunde – auch bei gleichzeitigen Anfragen', async () => {
    const env = await setupWithMembers();
    env.ctx.settings.set('tickets.createCooldownSeconds', 0, 'test');
    env.ctx.settings.set('tickets.maxOpenPerUser', 2, 'test');
    const results = await Promise.allSettled([1, 2, 3, 4].map(() => env.s.tickets.create(env.actor(IDS.customer), 'warzone', RANKED_FORM)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    expect(env.ctx.repo.ticketsOfCustomer(IDS.customer, ['open'])).toHaveLength(2);
  });

  it('erzwingt den Cooldown persistent', async () => {
    const env = await setupWithMembers();
    await env.s.tickets.create(env.actor(IDS.customer), 'support', { subject: 'Frage', description: 'Hallo' });
    await expect(env.s.tickets.create(env.actor(IDS.customer), 'support', { subject: 'Frage 2', description: 'Hallo' })).rejects.toThrow(/warte/);
    env.clock.advance(121_000);
    await expect(env.s.tickets.create(env.actor(IDS.customer), 'support', { subject: 'Frage 2', description: 'Hallo' })).resolves.toBeTruthy();
  });

  it('bei fehlgeschlagener Kanalerstellung bleibt kein offenes Ticket zurück', async () => {
    const env = await setupWithMembers();
    env.port.failNext('createChannel');
    await expect(env.s.tickets.create(env.actor(IDS.customer), 'warzone', RANKED_FORM)).rejects.toThrow(/nicht erstellt/);
    expect(env.ctx.repo.ticketsOfCustomer(IDS.customer, ['open', 'creating'])).toHaveLength(0);
    await expect(env.s.tickets.create(env.actor(IDS.customer), 'warzone', RANKED_FORM)).resolves.toBeTruthy();
  });

  it('konkurrierende Übernahme: genau ein Support gewinnt', async () => {
    const env = await setupWithMembers();
    const t = await env.s.tickets.create(env.actor(IDS.customer), 'warzone', RANKED_FORM);
    const res = await Promise.allSettled([
      env.s.tickets.claim(env.actor(IDS.support), t.id, t.channel_id),
      env.s.tickets.claim(env.actor(IDS.support2), t.id, t.channel_id),
    ]);
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(res.find((r) => r.status === 'rejected')!.status).toBe('rejected');
  });

  it('weist normale Mitglieder, Kunden und Operatoren bei Übernahme/Zuweisung ab', async () => {
    const env = await setupWithMembers();
    const t = await env.s.tickets.create(env.actor(IDS.customer), 'warzone', RANKED_FORM);
    await expect(env.s.tickets.claim(env.actor(IDS.member), t.id, t.channel_id)).rejects.toThrow(/Support-Team/);
    await expect(env.s.tickets.claim(env.actor(IDS.customer), t.id, t.channel_id)).rejects.toThrow(/Support-Team/);
    await expect(env.s.tickets.claim(env.actor(IDS.operator), t.id, t.channel_id)).rejects.toThrow(/Support-Team/);
    await expect(env.s.tickets.assignOperator(env.actor(IDS.operator), t.id, t.channel_id, IDS.operator)).rejects.toThrow(/Support-Team/);
    // Zuweisung an ein normales Mitglied wird verweigert
    await expect(env.s.tickets.assignOperator(env.actor(IDS.support), t.id, t.channel_id, IDS.member)).rejects.toThrow(/KSA Operator/);
  });

  it('manipulierte Ticket-ID aus einem anderen Kanal wird abgelehnt', async () => {
    const env = await setupWithMembers();
    const a = await env.s.tickets.create(env.actor(IDS.customer), 'warzone', RANKED_FORM);
    const b = await env.s.tickets.create(env.actor(IDS.customer2), 'warzone', RANKED_FORM);
    await expect(env.s.tickets.claim(env.actor(IDS.support), a.id, b.channel_id)).rejects.toThrow(/nicht zu diesem Kanal/);
    expect(() => env.s.tickets.requireTicketInChannel(999, a.channel_id)).toThrow(/existiert nicht/);
  });

  it('Zuweisung gibt nur dem zugewiesenen Operator Zugriff; Wechsel entzieht ihn', async () => {
    const env = await setupWithMembers();
    const t = await env.s.tickets.create(env.actor(IDS.customer), 'warzone', RANKED_FORM);
    await env.s.tickets.assignOperator(env.actor(IDS.support), t.id, t.channel_id, IDS.operator);
    let ch = env.port.channels.get(t.channel_id!)!;
    expect(ch.overwrites.some((o) => o.id === IDS.operator)).toBe(true);
    expect(ch.overwrites.some((o) => o.id === IDS.operator2)).toBe(false);
    await env.s.tickets.assignOperator(env.actor(IDS.support), t.id, t.channel_id, IDS.operator2);
    ch = env.port.channels.get(t.channel_id!)!;
    expect(ch.overwrites.some((o) => o.id === IDS.operator)).toBe(false);
    expect(ch.overwrites.some((o) => o.id === IDS.operator2)).toBe(true);
  });

  it('Schließen archiviert ohne Rechte-Sync, entzieht Kundenzugriff; Wiederöffnen stellt ihn her', async () => {
    const env = await setupWithMembers();
    const t = await env.s.tickets.create(env.actor(IDS.customer), 'warzone', RANKED_FORM);
    await expect(env.s.tickets.close(env.actor(IDS.customer2), t.id, t.channel_id, null)).rejects.toThrow();
    await env.s.tickets.close(env.actor(IDS.customer), t.id, t.channel_id, 'erledigt');
    let ch = env.port.channels.get(t.channel_id!)!;
    expect(ch.parentId).toBe(env.ctx.registry.categoryId('tickets_archive'));
    expect(ch.overwrites.some((o) => o.id === IDS.customer)).toBe(false);
    expect(ch.overwrites.find((o) => o.id === GUILD)!.deny & P.ViewChannel).toBe(P.ViewChannel);
    await expect(env.s.tickets.close(env.actor(IDS.support), t.id, t.channel_id, null)).rejects.toThrow(/bereits geschlossen/);
    await expect(env.s.tickets.reopen(env.actor(IDS.customer), t.number)).rejects.toThrow(/Support-Team/);
    await env.s.tickets.reopen(env.actor(IDS.support), t.number);
    ch = env.port.channels.get(t.channel_id!)!;
    expect(ch.parentId).toBe(env.ctx.registry.categoryId('tickets_open'));
    expect(ch.overwrites.some((o) => o.id === IDS.customer)).toBe(true);
  });

  it('gelöschter Kanal und ausgeschiedene Mitglieder werden sauber behandelt', async () => {
    const env = await setupWithMembers();
    const { ticket } = await createOrder(env);
    env.port.members.delete(IDS.operator);
    await env.s.tickets.handleMemberLeft(IDS.operator);
    expect(env.ctx.repo.ticket(ticket.id)!.assigned_operator_id).toBeNull();
    expect(env.ctx.repo.orderByTicket(ticket.id)!.operator_id).toBeNull();
    await env.s.tickets.handleMemberLeft(IDS.customer);
    expect(env.ctx.repo.ticket(ticket.id)!.customer_left).toBe(1);
    env.port.channels.delete(ticket.channel_id!);
    env.s.tickets.markChannelDeleted(ticket.channel_id!);
    expect(env.ctx.repo.ticket(ticket.id)!.status).toBe('channel_deleted');
    await expect(env.s.tickets.reopen(env.actor(IDS.support), ticket.number)).rejects.toThrow(/existiert nicht mehr/);
  });
});

describe('Angebote', () => {
  it('nur das Team erstellt Angebote; nur der Kunde nimmt an', async () => {
    const env = await setupWithMembers();
    const t = await env.s.tickets.create(env.actor(IDS.customer), 'warzone', RANKED_FORM);
    const input = { startRank: 'Gold', target: 'Platin', scope: 'Aufstieg', price: '30', currency: 'EUR' };
    expect(() => env.s.offers.createDraft(env.actor(IDS.customer), t, input)).toThrow(/Support-Team/);
    expect(() => env.s.offers.createDraft(env.actor(IDS.operator), t, input)).toThrow(/Support-Team/);
    const d = env.s.offers.createDraft(env.actor(IDS.support), t, input);
    env.s.offers.completeDraft(env.actor(IDS.support), d.id, t.channel_id, { timeframe: '5 Tage', cancellationTerms: 'Keine' });
    const sent = await env.s.offers.send(env.actor(IDS.support), d.id, t.channel_id);
    const h = sent.content_hash.slice(0, 16);
    await expect(env.s.offers.accept(env.actor(IDS.founder), sent.id, h, t.channel_id)).rejects.toThrow(/ausschließlich der Kunde/);
    await expect(env.s.offers.accept(env.actor(IDS.customer2), sent.id, h, t.channel_id)).rejects.toThrow(/ausschließlich der Kunde/);
    await expect(env.s.offers.accept(env.actor(IDS.customer), sent.id, 'ffffffffffffffff', t.channel_id)).rejects.toThrow(/geändert/);
    const { order, created } = await env.s.offers.accept(env.actor(IDS.customer), sent.id, h, t.channel_id);
    expect(created).toBe(true);
    expect(order.status).toBe('angebot_angenommen');
    expect(order.accepted_offer_version).toBe(1);
    expect(env.port.members.get(IDS.customer)!.roleIds).toContain(env.ctx.registry.roleId('customer'));
  });

  it('kein Auftrag ohne Annahme; Doppelklick erzeugt nur einen Auftrag', async () => {
    const env = await setupWithMembers();
    const t = await env.s.tickets.create(env.actor(IDS.customer), 'warzone', RANKED_FORM);
    const d = env.s.offers.createDraft(env.actor(IDS.support), t, { startRank: 'Gold', target: 'Platin', scope: 'x', price: '30', currency: 'EUR' });
    env.s.offers.completeDraft(env.actor(IDS.support), d.id, t.channel_id, { timeframe: '5 Tage', cancellationTerms: 'Keine' });
    const sent = await env.s.offers.send(env.actor(IDS.support), d.id, t.channel_id);
    expect(env.ctx.repo.orderByTicket(t.id)).toBeUndefined();
    const h = sent.content_hash.slice(0, 16);
    const r = await Promise.allSettled([1, 2].map(() => env.s.offers.accept(env.actor(IDS.customer), sent.id, h, t.channel_id)));
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(env.ctx.db.prepare('SELECT COUNT(*) AS n FROM orders').get()).toEqual({ n: 1 });
  });

  it('neue Version ersetzt die alte; Änderung nach Auftrag braucht erneute Zustimmung', async () => {
    const env = await setupWithMembers();
    const { ticket, offer, order } = await createOrder(env);
    const d2 = env.s.offers.createDraft(env.actor(IDS.support), ticket, { startRank: 'Gold II', target: 'Diamant', scope: 'Mehr', price: '79', currency: 'EUR' });
    env.s.offers.completeDraft(env.actor(IDS.support), d2.id, ticket.channel_id, { timeframe: '10 Tage', cancellationTerms: 'Anteilig' });
    const v2 = await env.s.offers.send(env.actor(IDS.support), d2.id, ticket.channel_id);
    expect(v2.version).toBe(2);
    expect(env.ctx.repo.order(order.id)!.target).toBe('Platin I');
    await env.s.offers.accept(env.actor(IDS.customer), v2.id, v2.content_hash.slice(0, 16), ticket.channel_id);
    const updated = env.ctx.repo.order(order.id)!;
    expect(updated.accepted_offer_version).toBe(2);
    expect(updated.target).toBe('Diamant');
    expect(env.ctx.repo.offer(offer.id)!.status).toBe('accepted');

    // Eine ersetzte Version kann nicht mehr angenommen werden
    const d3 = env.s.offers.createDraft(env.actor(IDS.support), ticket, { startRank: 'A', target: 'B', scope: 'C', price: '1', currency: 'EUR' });
    env.s.offers.completeDraft(env.actor(IDS.support), d3.id, ticket.channel_id, { timeframe: 'x', cancellationTerms: 'y' });
    const v3 = await env.s.offers.send(env.actor(IDS.support), d3.id, ticket.channel_id);
    const d4 = env.s.offers.createDraft(env.actor(IDS.support), ticket, { startRank: 'A', target: 'B', scope: 'D', price: '2', currency: 'EUR' });
    env.s.offers.completeDraft(env.actor(IDS.support), d4.id, ticket.channel_id, { timeframe: 'x', cancellationTerms: 'y' });
    await env.s.offers.send(env.actor(IDS.support), d4.id, ticket.channel_id);
    expect(env.ctx.repo.offer(v3.id)!.status).toBe('superseded');
    await expect(env.s.offers.accept(env.actor(IDS.customer), v3.id, v3.content_hash.slice(0, 16), ticket.channel_id)).rejects.toThrow(/nicht mehr gültig/);
  });
});

describe('Aufträge', () => {
  it('erlaubte Statuswechsel und Operator-Grenzen', async () => {
    const env = await setupWithMembers();
    const { order } = await createOrder(env);
    await expect(env.s.orders.setStatus(env.actor(IDS.operator2), order.id, 'in_bearbeitung')).rejects.toThrow(/zuständige Team/);
    await expect(env.s.orders.setStatus(env.actor(IDS.customer), order.id, 'in_bearbeitung')).rejects.toThrow();
    await env.s.orders.setStatus(env.actor(IDS.operator), order.id, 'in_bearbeitung');
    await expect(env.s.orders.setStatus(env.actor(IDS.operator), order.id, 'storniert')).rejects.toThrow(/Support/);
    await expect(env.s.orders.setStatus(env.actor(IDS.operator), order.id, 'angebot_angenommen')).rejects.toThrow(/nicht erlaubt/);
    await env.s.orders.setStatus(env.actor(IDS.operator), order.id, 'pausiert');
    await env.s.orders.setStatus(env.actor(IDS.operator), order.id, 'in_bearbeitung');
    await env.s.orders.setStatus(env.actor(IDS.operator), order.id, 'abgeschlossen');
    const done = env.ctx.repo.order(order.id)!;
    expect(done.status).toBe('abgeschlossen');
    expect(done.completed_at).not.toBeNull();
    await expect(env.s.orders.setStatus(env.actor(IDS.founder), order.id, 'in_bearbeitung')).rejects.toThrow(/nicht erlaubt/);
    const events = env.ctx.db.prepare("SELECT COUNT(*) AS n FROM order_events WHERE order_id = ? AND type = 'status'").get(order.id) as { n: number };
    expect(events.n).toBe(4);
  });

  it('Zahlungsstatus nur durch Admin/Founder, getrennt vom Auftragsstatus', async () => {
    const env = await setupWithMembers();
    const { order } = await createOrder(env);
    await expect(env.s.orders.setPayment(env.actor(IDS.support), order.id, 'bezahlt')).rejects.toThrow(/Admins/);
    await expect(env.s.orders.setPayment(env.actor(IDS.operator), order.id, 'bezahlt')).rejects.toThrow(/Admins/);
    await expect(env.s.orders.setPayment(env.actor(IDS.customer), order.id, 'bezahlt')).rejects.toThrow(/Admins/);
    const o = await env.s.orders.setPayment(env.actor(IDS.admin), order.id, 'bezahlt');
    expect(o.payment_status).toBe('bezahlt');
    expect(o.status).toBe('angebot_angenommen');
  });

  it('interne Notizen erscheinen nie in Kundenansichten oder Kundenexporten', async () => {
    const env = await setupWithMembers();
    const { order, ticket } = await createOrder(env);
    env.s.orders.addNote(env.actor(IDS.operator), order.id, 'GEHEIME-INTERNE-NOTIZ');
    expect(() => env.s.orders.addNote(env.actor(IDS.customer), order.id, 'x')).toThrow();
    expect(() => env.s.orders.notes(env.actor(IDS.customer), order)).toThrow();
    const customerView = JSON.stringify(env.s.orders.view(env.actor(IDS.customer), order.id));
    expect(customerView).not.toContain('GEHEIME-INTERNE-NOTIZ');
    expect(JSON.stringify(orderCustomerView(order, ticket, 'Europe/Berlin'))).not.toContain('GEHEIME');
    const teamView = JSON.stringify(env.s.orders.view(env.actor(IDS.support), order.id));
    expect(teamView).toContain('GEHEIME-INTERNE-NOTIZ');
    expect(() => env.s.orders.view(env.actor(IDS.customer2), order.id)).toThrow(/nicht beteiligt/);

    const custExport = await env.s.exports.exportTicket(env.actor(IDS.customer), ticket, 'customer');
    expect(custExport.data.toString()).not.toContain('GEHEIME-INTERNE-NOTIZ');
    await expect(env.s.exports.exportTicket(env.actor(IDS.customer), ticket, 'internal')).rejects.toThrow();
    await expect(env.s.exports.exportTicket(env.actor(IDS.customer2), ticket, 'customer')).rejects.toThrow();
    const intExport = await env.s.exports.exportTicket(env.actor(IDS.support), ticket, 'internal');
    expect(intExport.data.toString()).toContain('GEHEIME-INTERNE-NOTIZ');
  });

  it('Auftragsübersicht enthält keine Kundendaten oder Preise', async () => {
    const env = await setupWithMembers();
    await createOrder(env);
    const rendered = JSON.stringify(env.s.overview.render());
    expect(rendered).not.toContain(IDS.customer);
    expect(rendered).not.toContain('49,99');
    expect(rendered).toContain('Warzone Ranked');
  });
});
