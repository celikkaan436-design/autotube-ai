import { describe, expect, it } from 'vitest';
import { CORRELATION_WINDOW_MS, FRESHNESS_MS, MEMBER_UPDATE_DELAY_MS } from '../src/services/boosts.js';
import { createOrder, IDS, setupWithMembers, type TestEnv } from './helpers/context.js';

async function completedOrder(env: TestEnv) {
  const r = await createOrder(env);
  await env.s.orders.setStatus(env.actor(IDS.operator), r.order.id, 'in_bearbeitung');
  await env.s.orders.setStatus(env.actor(IDS.operator), r.order.id, 'abgeschlossen');
  return env.ctx.repo.order(r.order.id)!;
}

function reviewPosts(env: TestEnv) {
  return env.port.messagesIn(env.ctx.registry.channelId('bewertungen')!).filter((m) => JSON.stringify(m.payload).includes('Bewertung #'));
}

describe('Bewertungen', () => {
  it('nur nach verifiziertem Abschluss und nur durch den Kunden', async () => {
    const env = await setupWithMembers();
    const { order } = await createOrder(env);
    await expect(env.s.reviews.submit(env.actor(IDS.customer), order.id, { stars: 5, text: null, publication: 'anonymous' })).rejects.toThrow(/nach Abschluss/);
    await env.s.orders.setStatus(env.actor(IDS.operator), order.id, 'in_bearbeitung');
    await env.s.orders.setStatus(env.actor(IDS.operator), order.id, 'abgeschlossen');
    await expect(env.s.reviews.submit(env.actor(IDS.founder), order.id, { stars: 5, text: null, publication: 'anonymous' })).rejects.toThrow(/ausschließlich der Kunde/);
    await expect(env.s.reviews.submit(env.actor(IDS.customer2), order.id, { stars: 5, text: null, publication: 'anonymous' })).rejects.toThrow();
    await expect(env.s.reviews.submit(env.actor(IDS.customer), order.id, { stars: 6, text: null, publication: 'none' })).rejects.toThrow(/1 bis 5/);
  });

  it('genau eine Bewertung je Auftrag – auch bei gleichzeitigen Versuchen', async () => {
    const env = await setupWithMembers();
    const order = await completedOrder(env);
    const r = await Promise.allSettled([
      env.s.reviews.submit(env.actor(IDS.customer), order.id, { stars: 5, text: 'Top', publication: 'anonymous' }),
      env.s.reviews.submit(env.actor(IDS.customer), order.id, { stars: 1, text: 'Doppelt', publication: 'anonymous' }),
    ]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(env.ctx.db.prepare('SELECT COUNT(*) AS n FROM reviews WHERE order_id = ?').get(order.id)).toEqual({ n: 1 });
    expect(reviewPosts(env)).toHaveLength(1);
  });

  it('ohne Zustimmung keine Veröffentlichung; anonym ohne Namen und ohne Ping', async () => {
    const env = await setupWithMembers();
    const order = await completedOrder(env);
    await env.s.reviews.submit(env.actor(IDS.customer), order.id, { stars: 4, text: 'privater Kommentar', publication: 'none' });
    expect(reviewPosts(env)).toHaveLength(0);
    const env2 = await setupWithMembers();
    const o2 = await completedOrder(env2);
    await env2.s.reviews.submit(env2.actor(IDS.customer), o2.id, { stars: 4, text: 'gut @everyone <@123456789012345678>', publication: 'anonymous' });
    const post = reviewPosts(env2)[0]!;
    const json = JSON.stringify(post.payload);
    expect(json).toContain('Verifizierter Kunde');
    expect(json).not.toContain('Kunde A');
    expect(json).not.toContain(IDS.customer);
    expect(json).not.toContain('<@123456789012345678>');
    expect(post.payload.allowedMentions).toEqual({});
  });

  it('Moderation blendet Text aus, Sterne bleiben unverändert, Aktion protokolliert', async () => {
    const env = await setupWithMembers();
    const order = await completedOrder(env);
    const review = await env.s.reviews.submit(env.actor(IDS.customer), order.id, { stars: 2, text: 'unangemessen', publication: 'display_name' });
    await expect(env.s.reviews.setTextHidden(env.actor(IDS.operator), review.id, true, 'x')).rejects.toThrow(/Support-Team/);
    const hidden = await env.s.reviews.setTextHidden(env.actor(IDS.support), review.id, true, 'Beleidigung');
    expect(hidden.stars).toBe(2);
    const post = env.port.messages.get(hidden.public_message_id!)!;
    expect(JSON.stringify(post.payload)).toContain('ausgeblendet');
    expect(JSON.stringify(post.payload)).toContain('(2/5)');
    expect(JSON.stringify(post.payload)).not.toContain('unangemessen');
    expect(env.ctx.audit.list(5).map((a) => a.action)).toContain('review.text_hidden');
  });
});

describe('Discord-Serverboosts', () => {
  const thanks = (env: TestEnv) => env.port.messagesIn(env.ctx.registry.channelId('boost_danke')!);

  it('Systemnachricht + Member-Update für denselben Boost → genau eine Danksagung', async () => {
    const env = await setupWithMembers();
    await env.s.boosts.baseline(undefined);
    const now = env.clock.now();
    const m = { ...env.port.members.get(IDS.customer)!, premiumSince: now };
    env.port.members.set(IDS.customer, m);
    await env.s.boosts.onMemberUpdate(m);
    await env.s.boosts.onSystemBoostMessage(env.port.newId(), IDS.customer, now + 500);
    env.clock.advance(MEMBER_UPDATE_DELAY_MS + 1000);
    await env.s.boosts.processDue();
    expect(thanks(env)).toHaveLength(1);
    const msg = thanks(env)[0]!;
    expect(msg.payload.allowedMentions).toEqual({ users: [IDS.customer] });
    expect(JSON.stringify(msg.payload)).toContain('3 Boosts');
    env.s.boosts.stop();
  });

  it('Member-Update zuerst, Systemnachricht später → weiterhin nur eine Danksagung', async () => {
    const env = await setupWithMembers();
    await env.s.boosts.baseline(undefined);
    const now = env.clock.now();
    const m = { ...env.port.members.get(IDS.customer)!, premiumSince: now };
    env.port.members.set(IDS.customer, m);
    await env.s.boosts.onMemberUpdate(m);
    env.clock.advance(MEMBER_UPDATE_DELAY_MS + 1000);
    await env.s.boosts.processDue();
    expect(thanks(env)).toHaveLength(1);
    env.clock.advance(60_000);
    await env.s.boosts.onSystemBoostMessage(env.port.newId(), IDS.customer, env.clock.now());
    expect(thanks(env)).toHaveLength(1);
    const statuses = env.ctx.db.prepare('SELECT source, status FROM boost_events ORDER BY id').all();
    expect(statuses).toEqual([
      { source: 'member_update', status: 'thanked' },
      { source: 'system_message', status: 'merged' },
    ]);
  });

  it('dieselbe Systemnachricht doppelt (Reconnect/Replay) wird dedupliziert', async () => {
    const env = await setupWithMembers();
    await env.s.boosts.baseline(undefined);
    const id = env.port.newId();
    await env.s.boosts.onSystemBoostMessage(id, IDS.customer, env.clock.now());
    await env.s.boosts.onSystemBoostMessage(id, IDS.customer, env.clock.now());
    expect(thanks(env)).toHaveLength(1);
  });

  it('zusätzlicher Boost einer bereits boostenden Person wird über die Systemnachricht erkannt', async () => {
    const env = await setupWithMembers();
    env.port.members.get(IDS.customer)!.premiumSince = env.clock.now() - 30 * 86_400_000;
    await env.s.boosts.baseline(undefined);
    env.clock.advance(CORRELATION_WINDOW_MS * 2);
    await env.s.boosts.onSystemBoostMessage(env.port.newId(), IDS.customer, env.clock.now());
    expect(thanks(env)).toHaveLength(1);
  });

  it('Neustart: kein Dank für historische oder während der Offline-Zeit begonnene Boosts', async () => {
    const env = await setupWithMembers();
    const lastSeen = env.clock.now() - 60 * 60_000;
    env.port.members.get(IDS.customer)!.premiumSince = env.clock.now() - 10 * 86_400_000; // alt
    env.port.members.get(IDS.customer2)!.premiumSince = env.clock.now() - 5 * 60_000; // während Offline-Zeit
    const report = await env.s.boosts.baseline(lastSeen);
    expect(report.startedWhileOffline).toEqual([IDS.customer2]);
    await env.s.boosts.processDue();
    expect(thanks(env)).toHaveLength(0);
    // Ein späteres Member-Update (z. B. Nickname) mit unverändertem premiumSince löst nichts aus
    await env.s.boosts.onMemberUpdate({ ...env.port.members.get(IDS.customer)!, displayName: 'Neu' });
    env.clock.advance(MEMBER_UPDATE_DELAY_MS + 1);
    await env.s.boosts.processDue();
    expect(thanks(env)).toHaveLength(0);
  });

  it('veraltete Ereignisse werden nicht nachträglich bedankt', async () => {
    const env = await setupWithMembers();
    await env.s.boosts.baseline(undefined);
    await env.s.boosts.onSystemBoostMessage(env.port.newId(), IDS.customer, env.clock.now() - FRESHNESS_MS - 1);
    // Member-Update mit altem premiumSince (z. B. Cache-Lücke) – kein Dank
    await env.s.boosts.onMemberUpdate({ ...env.port.members.get(IDS.customer2)!, premiumSince: env.clock.now() - 2 * FRESHNESS_MS });
    env.clock.advance(MEMBER_UPDATE_DELAY_MS + 1);
    await env.s.boosts.processDue();
    expect(thanks(env)).toHaveLength(0);
  });

  it('Dank deaktiviert → kein Post; Ereignis wird als deaktiviert markiert', async () => {
    const env = await setupWithMembers();
    env.ctx.settings.set('boost.thanksEnabled', false, 'test');
    await env.s.boosts.baseline(undefined);
    await env.s.boosts.onSystemBoostMessage(env.port.newId(), IDS.customer, env.clock.now());
    expect(thanks(env)).toHaveLength(0);
    expect(env.ctx.db.prepare("SELECT status FROM boost_events").get()).toEqual({ status: 'disabled' });
  });

  it('Rollenabgleich: eigene Rolle nur bei bestätigtem Status, keine öffentliche Nachricht beim Ende', async () => {
    const env = await setupWithMembers();
    const role = env.ctx.registry.roleId('booster')!;
    expect(env.ctx.settings.get('boost.roleMode')).toBe('custom');
    await env.s.boosts.baseline(undefined);
    const now = env.clock.now();
    env.port.members.get(IDS.customer)!.premiumSince = now;
    await env.s.boosts.onMemberUpdate(env.port.members.get(IDS.customer)!);
    expect(env.port.members.get(IDS.customer)!.roleIds).toContain(role);
    const before = env.port.messages.size;
    // Ende des Boosts: erst nach frischer Bestätigung entfernen
    env.port.members.get(IDS.customer)!.premiumSince = null;
    await env.s.boosts.onMemberUpdate(env.port.members.get(IDS.customer)!);
    expect(env.port.members.get(IDS.customer)!.roleIds).not.toContain(role);
    env.clock.advance(MEMBER_UPDATE_DELAY_MS + 1);
    await env.s.boosts.processDue();
    // genau eine neue Nachricht: die Danksagung für den Beginn – keine negative Nachricht beim Ende
    expect(env.port.messages.size - before).toBe(1);
    // Sync vergibt fehlende Rolle und entfernt nur bestätigt beendete
    env.port.members.get(IDS.customer2)!.premiumSince = now - 1000;
    env.port.members.get(IDS.member)!.roleIds.push(role);
    const r = await env.s.boosts.syncRoles(env.actor(IDS.admin));
    expect(r).toMatchObject({ added: 1, removed: 1 });
    await expect(env.s.boosts.syncRoles(env.actor(IDS.support))).rejects.toThrow(/Admins/);
  });

  it('verwaltete Discord-Rolle wird nie manipuliert', async () => {
    const env = await setupWithMembers();
    const managedId = env.port.newId();
    env.port.roles.set(managedId, { id: managedId, name: 'Server Booster', position: 3, managed: true, isBoosterRole: true, botId: null, color: 0, hoist: true, mentionable: false, permissions: 0n });
    await expect(env.s.boosts.setRoleMode(env.actor(IDS.admin), 'managed')).rejects.toThrow(/Foundern/);
    await env.s.boosts.setRoleMode(env.actor(IDS.founder), 'managed');
    env.port.members.get(IDS.customer)!.premiumSince = env.clock.now();
    const calls = env.port.countCalls('addRole') + env.port.countCalls('removeRole');
    await env.s.boosts.onMemberUpdate(env.port.members.get(IDS.customer)!);
    await env.s.boosts.syncRoles(env.actor(IDS.admin));
    expect(env.port.countCalls('addRole') + env.port.countCalls('removeRole')).toBe(calls);
  });
});
