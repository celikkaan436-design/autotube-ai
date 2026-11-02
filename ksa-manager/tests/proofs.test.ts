import { existsSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createEnv, createOrder, IDS, setupWithMembers, type TestEnv } from './helpers/context.js';
import { makeJpeg, makePng } from './helpers/images.js';

let seedCounter = 10;

async function completedOrderWithImages(env: TestEnv, images = 2, complete = true) {
  const { ticket, order } = await createOrder(env);
  if (complete) {
    await env.s.orders.setStatus(env.actor(IDS.operator), order.id, 'in_bearbeitung');
    await env.s.orders.setStatus(env.actor(IDS.operator), order.id, 'abgeschlossen');
  }
  const atts = Array.from({ length: images }, (_, n) => ({ name: `ergebnis-${n + 1}.png`, contentType: 'image/png', data: makePng((seedCounter++ % 240) + 1) }));
  const msg = env.port.postUserMessage(ticket.channel_id!, IDS.operator, atts);
  return { ticket: env.ctx.repo.ticket(ticket.id)!, order: env.ctx.repo.order(order.id)!, msg };
}

async function submitAll(env: TestEnv, ticketChannel: string, msgId: string, actorId = IDS.operator) {
  const info = env.port.toInfo(env.port.messages.get(msgId)!);
  const { token, attachments } = await env.s.proofs.beginSubmission(env.actor(actorId), ticketChannel, info);
  return env.s.proofs.selectImages(env.actor(actorId), token, ticketChannel, attachments.map((a) => a.id));
}

function publicPosts(env: TestEnv) {
  return env.port.messagesIn(env.ctx.registry.channelId('proofs')!).filter((m) => (m.payload.embeds ?? []).some((e) => e.title === 'Auftrag abgeschlossen'));
}

async function approveAll(env: TestEnv, proofId: number, channelId: string) {
  const p = env.ctx.repo.proof(proofId)!;
  await env.s.proofs.customerDecision(env.actor(IDS.customer), p.id, p.version, p.version_hash.slice(0, 16), channelId, 'approved');
  const p2 = env.ctx.repo.proof(proofId)!;
  return env.s.proofs.teamApprove(env.actor(IDS.support), p2.id, p2.version, p2.version_hash.slice(0, 16));
}

describe('Proof-Einreichung', () => {
  it('nur aus dem zugehörigen Ticket, nur Team-Nachrichten, nur mit Auftrag', async () => {
    const env = await setupWithMembers();
    const { ticket, msg } = await completedOrderWithImages(env);
    const other = await env.s.tickets.create(env.actor(IDS.customer2), 'warzone', { currentRank: 'a', targetRank: 'b', platform: 'PC', timeframe: '', details: '' });
    const info = env.port.toInfo(msg);
    // Nachricht aus Ticket A, ausgeführt im Ticket B
    await expect(env.s.proofs.beginSubmission(env.actor(IDS.support), other.channel_id, info)).rejects.toThrow(/nicht zu diesem Ticket/);
    // Ticket ohne Auftrag
    const msgOther = env.port.postUserMessage(other.channel_id!, IDS.support, [{ name: 'a.png', contentType: 'image/png', data: makePng(99) }]);
    await expect(env.s.proofs.beginSubmission(env.actor(IDS.support), other.channel_id, env.port.toInfo(msgOther))).rejects.toThrow(/keinem Auftrag/);
    // Fremder Operator und Kunde dürfen nicht einreichen
    await expect(env.s.proofs.beginSubmission(env.actor(IDS.operator2), ticket.channel_id, info)).rejects.toThrow(/zuständige Team/);
    await expect(env.s.proofs.beginSubmission(env.actor(IDS.customer), ticket.channel_id, info)).rejects.toThrow(/zuständige Team/);
    // Kundennachricht wird nicht übernommen
    const customerMsg = env.port.postUserMessage(ticket.channel_id!, IDS.customer, [{ name: 'privat.png', contentType: 'image/png', data: makePng(5) }]);
    await expect(env.s.proofs.beginSubmission(env.actor(IDS.support), ticket.channel_id, env.port.toInfo(customerMsg))).rejects.toThrow(/Nachrichten des Teams/);
  });

  it('prüft Typ, Signatur und Herkunft der Anhänge', async () => {
    const env = await setupWithMembers();
    const { ticket } = await completedOrderWithImages(env, 1);
    const bad = env.port.postUserMessage(ticket.channel_id!, IDS.operator, [
      { name: 'skript.svg', contentType: 'image/svg+xml', data: Buffer.from('<svg/>') },
      { name: 'extern.png', contentType: 'image/png', data: makePng(1), host: 'evil.example.com' },
    ]);
    await expect(env.s.proofs.beginSubmission(env.actor(IDS.operator), ticket.channel_id, env.port.toInfo(bad))).rejects.toThrow(/Keine unterstützten Bilder/);
    const fake = env.port.postUserMessage(ticket.channel_id!, IDS.operator, [{ name: 'fake.png', contentType: 'image/png', data: makeJpeg(1) }]);
    const { token, attachments } = await env.s.proofs.beginSubmission(env.actor(IDS.operator), ticket.channel_id, env.port.toInfo(fake));
    await expect(env.s.proofs.selectImages(env.actor(IDS.operator), token, ticket.channel_id, attachments.map((a) => a.id))).rejects.toThrow(/Dateisignatur/);
  });

  it('übernimmt nur ausgewählte Bilder und entfernt deren Metadaten', async () => {
    const env = await setupWithMembers();
    const { ticket, msg } = await completedOrderWithImages(env, 3);
    const { token, attachments } = await env.s.proofs.beginSubmission(env.actor(IDS.operator), ticket.channel_id, env.port.toInfo(msg));
    const proof = await env.s.proofs.selectImages(env.actor(IDS.operator), token, ticket.channel_id, [attachments[0]!.id, attachments[2]!.id]);
    const images = env.ctx.repo.proofImages(proof.id);
    expect(images).toHaveLength(2);
    expect(images.map((i) => i.source_attachment_id)).toEqual([attachments[0]!.id, attachments[2]!.id]);
    // Auswahl-Token ist nur einmal verwendbar und an den Nutzer gebunden
    await expect(env.s.proofs.selectImages(env.actor(IDS.operator), token, ticket.channel_id, [attachments[1]!.id])).rejects.toThrow(/abgelaufen/);
    const preview = env.port.messages.get(proof.preview_message_id!)!;
    for (const f of preview.payload.files ?? []) expect(f.data.toString('latin1')).not.toContain('example.com');
  });
});

describe('Proof-Freigabe und Veröffentlichung', () => {
  it('keine Veröffentlichung ohne konkrete Kundenzustimmung und Team-Freigabe', async () => {
    const env = await setupWithMembers();
    const { ticket, msg } = await completedOrderWithImages(env);
    const proof = await submitAll(env, ticket.channel_id!, msg.id);
    expect((await env.s.proofs.tryPublish(proof.id)).published).toBe(false);
    await env.s.proofs.teamApprove(env.actor(IDS.support), proof.id, proof.version, proof.version_hash.slice(0, 16));
    expect(publicPosts(env)).toHaveLength(0);
    // Zustimmung durch Founder oder anderen Kunden zählt nicht
    await expect(env.s.proofs.customerDecision(env.actor(IDS.founder), proof.id, proof.version, proof.version_hash.slice(0, 16), ticket.channel_id, 'approved')).rejects.toThrow(/ausschließlich der Kunde/);
    await expect(env.s.proofs.customerDecision(env.actor(IDS.customer2), proof.id, proof.version, proof.version_hash.slice(0, 16), ticket.channel_id, 'approved')).rejects.toThrow();
    // Operator darf nicht als Team freigeben
    await expect(env.s.proofs.teamApprove(env.actor(IDS.operator), proof.id, proof.version, proof.version_hash.slice(0, 16))).rejects.toThrow(/Support-Team/);
    await env.s.proofs.customerDecision(env.actor(IDS.customer), proof.id, proof.version, proof.version_hash.slice(0, 16), ticket.channel_id, 'approved');
    expect(publicPosts(env)).toHaveLength(1);
    expect(env.ctx.repo.proof(proof.id)!.status).toBe('published');
  });

  it('veröffentlicht erst nach Abschluss des Auftrags', async () => {
    const env = await setupWithMembers();
    const { ticket, order, msg } = await completedOrderWithImages(env, 1, false);
    const proof = await submitAll(env, ticket.channel_id!, msg.id);
    await approveAll(env, proof.id, ticket.channel_id!);
    expect(publicPosts(env)).toHaveLength(0);
    expect(env.s.proofs.readiness(env.ctx.repo.proof(proof.id)!).missing).toContain('Auftrag ist noch nicht abgeschlossen');
    await env.s.orders.setStatus(env.actor(IDS.operator), order.id, 'in_bearbeitung');
    await env.s.orders.setStatus(env.actor(IDS.operator), order.id, 'abgeschlossen');
    expect(publicPosts(env)).toHaveLength(1);
  });

  it('geänderte Bilder oder Angaben erfordern erneute Zustimmung', async () => {
    const env = await setupWithMembers();
    const { ticket, msg } = await completedOrderWithImages(env, 2);
    const v1 = await submitAll(env, ticket.channel_id!, msg.id);
    await env.s.proofs.customerDecision(env.actor(IDS.customer), v1.id, v1.version, v1.version_hash.slice(0, 16), ticket.channel_id, 'approved');
    // Team entfernt ein Bild → neue Version, alte Zustimmung gilt nicht
    const img = env.ctx.repo.proofImages(v1.id)[1]!;
    const v2 = await env.s.proofs.removeImage(env.actor(IDS.support), v1.id, ticket.channel_id, v1.version, img.id);
    expect(v2.version).toBe(v1.version + 1);
    expect(v2.version_hash).not.toBe(v1.version_hash);
    await env.s.proofs.teamApprove(env.actor(IDS.support), v2.id, v2.version, v2.version_hash.slice(0, 16));
    expect(publicPosts(env)).toHaveLength(0);
    // Klick auf die alte Vorschau wird abgelehnt
    await expect(env.s.proofs.customerDecision(env.actor(IDS.customer), v1.id, v1.version, v1.version_hash.slice(0, 16), ticket.channel_id, 'approved')).rejects.toThrow(/veraltet/);
    // Text geändert → wieder neue Version
    const v3 = await env.s.proofs.editText(env.actor(IDS.support), v2.id, ticket.channel_id, v2.version, 'Neuer Text');
    expect(env.s.proofs.readiness(v3).missing).toEqual(expect.arrayContaining(['Zustimmung des Kunden zu dieser Version', 'Team-Freigabe dieser Version']));
    // Alte Vorschau-Nachricht ist deaktiviert
    expect(env.port.messages.get(v2.preview_message_id!)!.payload.components).toEqual([]);
    await approveAll(env, v3.id, ticket.channel_id!);
    const posts = publicPosts(env);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.payload.files).toHaveLength(1);
  });

  it('öffentlicher Beitrag: anonym, ohne Ping, ohne Preis/Ticket-Link/Notizen, Dateien neu hochgeladen', async () => {
    const env = await setupWithMembers();
    const { ticket, order, msg } = await completedOrderWithImages(env, 2);
    env.s.orders.addNote(env.actor(IDS.support), order.id, 'INTERNE-NOTIZ-XYZ');
    const proof = await submitAll(env, ticket.channel_id!, msg.id);
    await approveAll(env, proof.id, ticket.channel_id!);
    const post = publicPosts(env)[0]!;
    const json = JSON.stringify(post.payload.embeds);
    expect(json).not.toContain(IDS.customer);
    expect(json).not.toContain('49,99');
    expect(json).not.toContain(ticket.channel_id!);
    expect(json).not.toContain('INTERNE-NOTIZ');
    expect(json).toContain('Gold II');
    expect(json).toContain('KSA Boosting');
    expect(post.payload.allowedMentions).toEqual({});
    expect(post.payload.content).toBeUndefined();
    expect(post.payload.files).toHaveLength(2);
    for (const f of post.payload.files!) expect(f.data.length).toBeGreaterThan(20);
    const stored = env.ctx.repo.proof(proof.id)!;
    expect(stored.public_message_id).toBe(post.id);
    expect(stored.published_at).not.toBeNull();
    // Link im Ticket und Team-Log-Eintrag
    expect(env.port.messagesIn(ticket.channel_id!).some((m) => (m.payload.content ?? '').includes(post.id))).toBe(true);
    expect(env.port.messagesIn(env.ctx.registry.channelId('teamlog')!).some((m) => JSON.stringify(m.payload).includes('Proof veröffentlicht'))).toBe(true);
    // Temporäre Dateien gelöscht
    expect(existsSync(env.s.proofs.proofDir(proof.id))).toBe(false);
  });

  it('keine doppelten Posts bei parallelen Versuchen und verlorener Discord-Antwort', async () => {
    const env = await setupWithMembers();
    const { ticket, msg } = await completedOrderWithImages(env, 1);
    const proof = await submitAll(env, ticket.channel_id!, msg.id);
    await env.s.proofs.customerDecision(env.actor(IDS.customer), proof.id, proof.version, proof.version_hash.slice(0, 16), ticket.channel_id, 'approved');
    // Nachricht wird gepostet, die Antwort geht aber verloren
    env.port.failNext('sendMessage', { mode: 'after', message: 'Socket hang up' });
    await env.s.proofs.teamApprove(env.actor(IDS.support), proof.id, proof.version, proof.version_hash.slice(0, 16));
    expect(env.ctx.repo.proof(proof.id)!.status).toBe('pending');
    expect(publicPosts(env)).toHaveLength(1);
    const results = await Promise.all([env.s.proofs.tryPublish(proof.id), env.s.proofs.tryPublish(proof.id), env.s.proofs.resumePending()]);
    expect(results[0].published || results[1].published).toBe(true);
    expect(publicPosts(env)).toHaveLength(1);
    expect(env.ctx.repo.proof(proof.id)!.public_message_id).toBe(publicPosts(env)[0]!.id);
  });

  it('gleiche Bilder können nicht erneut veröffentlicht werden', async () => {
    const env = await setupWithMembers();
    const { ticket, msg } = await completedOrderWithImages(env, 1);
    const proof = await submitAll(env, ticket.channel_id!, msg.id);
    await approveAll(env, proof.id, ticket.channel_id!);
    // Zweiter Auftrag, gleiches Bild
    const data = env.port.downloads.get(msg.attachments[0]!.url)!;
    const { ticket: t2, order: o2 } = await (async () => {
      env.clock.advance(200_000);
      const r = await createOrder(env);
      await env.s.orders.setStatus(env.actor(IDS.operator), r.order.id, 'in_bearbeitung');
      await env.s.orders.setStatus(env.actor(IDS.operator), r.order.id, 'abgeschlossen');
      return r;
    })();
    void o2;
    const dup = env.port.postUserMessage(t2.channel_id!, IDS.operator, [{ name: 'gleich.png', contentType: 'image/png', data }]);
    await expect(submitAll(env, t2.channel_id!, dup.id)).rejects.toThrow(/bereits in einem veröffentlichten Proof/);
  });

  it('Rücknahme durch Admin und Widerruf durch den Kunden entfernen den Beitrag', async () => {
    const env = await setupWithMembers();
    const { ticket, msg } = await completedOrderWithImages(env, 1);
    const proof = await submitAll(env, ticket.channel_id!, msg.id);
    await approveAll(env, proof.id, ticket.channel_id!);
    expect(publicPosts(env)).toHaveLength(1);
    await expect(env.s.proofs.withdraw(env.actor(IDS.support), proof.id, 'Test')).rejects.toThrow(/Admins/);
    await expect(env.s.proofs.withdraw(env.actor(IDS.customer), proof.id, 'Test')).rejects.toThrow();
    await env.s.proofs.withdraw(env.actor(IDS.admin), proof.id, 'Kundenwunsch');
    expect(publicPosts(env)).toHaveLength(0);
    const p = env.ctx.repo.proof(proof.id)!;
    expect(p.status).toBe('withdrawn');
    expect(p.withdrawn_by).toBe(IDS.admin);
    expect(env.ctx.audit.list(10, { targetType: 'proof', targetId: String(proof.id) }).map((a) => a.action)).toContain('proof.withdrawn');
  });

  it('Kunde kann seine Freigabe widerrufen – vor und nach der Veröffentlichung', async () => {
    const env = await setupWithMembers();
    const { ticket, msg } = await completedOrderWithImages(env, 1);
    const proof = await submitAll(env, ticket.channel_id!, msg.id);
    await env.s.proofs.customerDecision(env.actor(IDS.customer), proof.id, proof.version, proof.version_hash.slice(0, 16), ticket.channel_id, 'approved');
    await env.s.proofs.customerRevoke(env.actor(IDS.customer), proof.id);
    await env.s.proofs.teamApprove(env.actor(IDS.support), proof.id, proof.version, proof.version_hash.slice(0, 16)).catch(() => undefined);
    expect(publicPosts(env)).toHaveLength(0);
    const p = env.ctx.repo.proof(proof.id)!;
    await env.s.proofs.customerDecision(env.actor(IDS.customer), p.id, p.version, p.version_hash.slice(0, 16), ticket.channel_id, 'approved');
    await env.s.proofs.teamApprove(env.actor(IDS.support), p.id, p.version, p.version_hash.slice(0, 16)).catch(() => undefined);
    await env.s.proofs.tryPublish(p.id);
    expect(publicPosts(env)).toHaveLength(1);
    await expect(env.s.proofs.customerRevoke(env.actor(IDS.customer2), p.id)).rejects.toThrow();
    await env.s.proofs.customerRevoke(env.actor(IDS.customer), p.id);
    expect(publicPosts(env)).toHaveLength(0);
    expect(env.ctx.repo.proof(p.id)!.withdraw_reason).toMatch(/widerrufen/);
  });

  it('nimmt eine unterbrochene Veröffentlichung nach Neustart wieder auf', async () => {
    const env = await setupWithMembers();
    const { ticket, msg } = await completedOrderWithImages(env, 1);
    const proof = await submitAll(env, ticket.channel_id!, msg.id);
    await env.s.proofs.customerDecision(env.actor(IDS.customer), proof.id, proof.version, proof.version_hash.slice(0, 16), ticket.channel_id, 'approved');
    env.port.failNext('sendMessage', { message: 'Discord nicht erreichbar' });
    await env.s.proofs.teamApprove(env.actor(IDS.support), proof.id, proof.version, proof.version_hash.slice(0, 16)).catch(() => undefined);
    expect(env.ctx.repo.proof(proof.id)!.status).not.toBe('published');
    // „Neustart“: neue Service-Instanzen auf derselben Datenbank
    const restarted = createEnv({ port: env.port, clock: env.clock, dir: env.dir });
    restarted.ctx.db.close();
    Object.assign(restarted.ctx, { db: env.ctx.db, registry: env.ctx.registry, settings: env.ctx.settings, repo: env.ctx.repo, audit: env.ctx.audit });
    const { createServices } = await import('../src/services/index.js');
    const s2 = createServices(restarted.ctx, { setupPaceMs: 0, overviewDebounceMs: 0 });
    await s2.proofs.resumePending();
    expect(env.ctx.repo.proof(proof.id)!.status).toBe('published');
    expect(publicPosts(env)).toHaveLength(1);
    expect(readdirSync(env.dir).includes('proofs') ? readdirSync(`${env.dir}/proofs`) : []).toEqual([]);
  });
});
