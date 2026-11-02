import { PermissionFlagsBits as P } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { CATEGORIES, CHANNELS, ROLES } from '../src/setup/blueprint.js';
import { PANELS } from '../src/content/panels.js';
import { PLAN_TTL_MS } from '../src/setup/service.js';
import { createEnv, GUILD, IDS, runSetup } from './helpers/context.js';

const founder = { userId: IDS.founder, roleIds: [] };

function totalResources() {
  return ROLES.length + CATEGORIES.length + CHANNELS.length;
}

describe('Setup – Autorisierung und Bestätigung', () => {
  it('nur Founder dürfen das Setup starten', async () => {
    const env = createEnv();
    await expect(env.s.setup.preview({ userId: IDS.member, roleIds: [] }, GUILD, { correct: false, adoptForeign: false })).rejects.toThrow(/Foundern vorbehalten/);
  });

  it('lehnt fremde Server ab', async () => {
    const env = createEnv();
    await expect(env.s.setup.preview(founder, '999999999999999999', { correct: false, adoptForeign: false })).rejects.toThrow(/Zielserver/);
  });

  it('Bestätigung ist an Nutzer, Hash und Ablaufzeit gebunden und nur einmal nutzbar', async () => {
    const env = createEnv();
    const { planId, plan } = await env.s.setup.preview(founder, GUILD, { correct: false, adoptForeign: false });
    const h = plan.hash.slice(0, 16);
    await expect(env.s.setup.confirm({ userId: IDS.founder2, roleIds: [] }, GUILD, planId, h)).rejects.toThrow(/erstellt hat/);
    await expect(env.s.setup.confirm(founder, GUILD, planId, '0000000000000000')).rejects.toThrow(/passt nicht/);
    await expect(env.s.setup.confirm(founder, '999999999999999999', planId, h)).rejects.toThrow(/anderen Server/);
    env.clock.advance(PLAN_TTL_MS + 1);
    await expect(env.s.setup.confirm(founder, GUILD, planId, h)).rejects.toThrow(/abgelaufen/);
  });

  it('Doppelklick: dieselbe Vorschau wird nur einmal ausgeführt', async () => {
    const env = createEnv();
    const { planId, plan } = await env.s.setup.preview(founder, GUILD, { correct: false, adoptForeign: false });
    const h = plan.hash.slice(0, 16);
    const results = await Promise.allSettled([env.s.setup.confirm(founder, GUILD, planId, h), env.s.setup.confirm(founder, GUILD, planId, h)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(env.port.countCalls('createRole')).toBe(ROLES.length);
  });

  it('veraltete Vorschau wird nicht ausgeführt, wenn sich der Server geändert hat', async () => {
    const env = createEnv();
    const { planId, plan } = await env.s.setup.preview(founder, GUILD, { correct: false, adoptForeign: false });
    env.port.addForeignChannel('START', 'category');
    await expect(env.s.setup.confirm(founder, GUILD, planId, plan.hash.slice(0, 16))).rejects.toThrow(/verändert/);
    expect(env.port.countCalls('createRole')).toBe(0);
  });

  it('fehlende Pflichtrechte blockieren das Setup', async () => {
    const env = createEnv();
    env.port.botPermissions &= ~P.ManageRoles;
    const { plan } = await env.s.setup.preview(founder, GUILD, { correct: false, adoptForeign: false });
    expect(plan.blockers.join('\n')).toMatch(/Rollen verwalten/);
  });
});

describe('Setup – idempotent und fortsetzbar', () => {
  it('erstellt alle Rollen, Kategorien, Kanäle und Panels', async () => {
    const env = createEnv();
    env.port.addMember(IDS.founder, 'xKyro');
    const { result } = await runSetup(env);
    expect(result.failed).toEqual([]);
    expect(env.port.roles.size).toBe(ROLES.length);
    expect(env.port.channels.size).toBe(CATEGORIES.length + CHANNELS.length);
    for (const p of PANELS) expect(env.ctx.registry.get(`panel:${p.key}`)?.status).toBe('done');
    expect(env.port.automod.length).toBe(3);
    // Founder bekommt die Rolle per Nutzer-ID
    expect(env.port.members.get(IDS.founder)!.roleIds).toContain(env.ctx.registry.roleId('founder'));
    // Keine Rolle erhält Server-Rechte, insbesondere kein Administrator
    for (const r of env.port.roles.values()) expect(r.permissions).toBe(0n);
  });

  it('zweiter Lauf erzeugt keine Duplikate', async () => {
    const env = createEnv();
    await runSetup(env);
    const roles = env.port.roles.size;
    const channels = env.port.channels.size;
    const messages = env.port.messages.size;
    const { preview } = await runSetup(env);
    expect(preview.plan.items).toEqual([]);
    expect(env.port.roles.size).toBe(roles);
    expect(env.port.channels.size).toBe(channels);
    expect(env.port.messages.size).toBe(messages);
  });

  it('setzt nach Teilausfall fort, ohne Doppelungen', async () => {
    const env = createEnv();
    env.port.failNext('createChannel', { count: 5, message: 'Rate-Limit/Netzwerk' });
    const first = await runSetup(env);
    expect(first.result.failed.length).toBeGreaterThan(0);
    const second = await runSetup(env);
    expect(second.result.failed).toEqual([]);
    expect(env.port.channels.size).toBe(CATEGORIES.length + CHANNELS.length);
    const names = [...env.port.channels.values()].map((c) => `${c.parentId}:${c.name}`);
    expect(new Set(names).size).toBe(names.length);
  });

  it('übernimmt eine beim Absturz erstellte Ressource statt sie doppelt anzulegen', async () => {
    const env = createEnv();
    // Kanal wird in Discord angelegt, aber die Antwort geht verloren (Absturz/Netzwerk)
    env.port.failNext('createChannel', { mode: 'after', message: 'Verbindung verloren' });
    await runSetup(env);
    const before = env.port.channels.size;
    const second = await runSetup(env);
    expect(second.preview.plan.items.some((i) => i.op === 'adopt_category' || i.op === 'adopt_channel')).toBe(true);
    expect(env.port.channels.size).toBe(before + (CATEGORIES.length + CHANNELS.length - before));
    expect(env.port.channels.size).toBe(CATEGORIES.length + CHANNELS.length);
  });

  it('übernimmt gleichnamige fremde Kanäle nicht ungeprüft', async () => {
    const env = createEnv();
    const foreign = env.port.addForeignChannel('📜・regeln', 'text');
    const { preview } = await runSetup(env);
    expect(preview.plan.warnings.join('\n')).toMatch(/nicht übernommen/);
    expect(env.ctx.registry.channelId('regeln')).not.toBe(foreign);
    expect(env.port.channels.get(foreign)!.overwrites).toEqual([]);
  });

  it('übernimmt fremde Ressourcen nur mit ausdrücklicher Option', async () => {
    const env = createEnv();
    const foreign = env.port.addForeignChannel('📜・regeln', 'text');
    await runSetup(env, { correct: false, adoptForeign: true });
    expect(env.ctx.registry.channelId('regeln')).toBe(foreign);
  });

  it('erstellt gelöschte Ressourcen neu und meldet verschobene', async () => {
    const env = createEnv();
    await runSetup(env);
    const faq = env.ctx.registry.channelId('faq')!;
    env.port.channels.delete(faq);
    const allgemein = env.ctx.registry.channelId('allgemein')!;
    env.port.channels.get(allgemein)!.parentId = env.ctx.registry.categoryId('team')!;
    const diag = await env.s.setup.diagnose(founder, GUILD);
    expect(diag.problems.join('\n')).toMatch(/faq: wurde gelöscht/);
    expect(diag.problems.join('\n')).toMatch(/verschoben/);
    const { preview } = await runSetup(env);
    expect(preview.plan.items.some((i) => i.op === 'create_channel' && i.key === 'faq' && i.recreate)).toBe(true);
    expect(preview.plan.warnings.join('\n')).toMatch(/verschoben/);
    expect(env.port.channels.get(allgemein)!.parentId).toBe(env.ctx.registry.categoryId('team'));
    await runSetup(env, { correct: true, adoptForeign: false });
    expect(env.port.channels.get(allgemein)!.parentId).toBe(env.ctx.registry.categoryId('community'));
  });

  it('verknüpft die verwaltete Discord-Booster-Rolle statt eine doppelte anzulegen', async () => {
    const env = createEnv();
    const managedId = env.port.newId();
    env.port.roles.set(managedId, { id: managedId, name: 'Server Booster', position: 5, managed: true, isBoosterRole: true, botId: null, color: 0, hoist: true, mentionable: false, permissions: 0n });
    await runSetup(env);
    expect(env.ctx.registry.roleId('booster')).toBe(managedId);
    expect(env.ctx.settings.get('boost.roleMode')).toBe('managed');
    expect([...env.port.roles.values()].filter((r) => r.name === 'Server Booster')).toHaveLength(1);
  });

  it('Ticket-Kategorien und interne Bereiche sind für @everyone unsichtbar', async () => {
    const env = createEnv();
    await runSetup(env);
    for (const key of ['tickets_open', 'tickets_archive', 'team'] as const) {
      const c = env.port.channels.get(env.ctx.registry.categoryId(key)!)!;
      const everyone = c.overwrites.find((o) => o.id === GUILD)!;
      expect(everyone.deny & P.ViewChannel).toBe(P.ViewChannel);
    }
    const teamlog = env.port.channels.get(env.ctx.registry.channelId('teamlog')!)!;
    expect(teamlog.overwrites.some((o) => o.id === env.ctx.registry.roleId('operator'))).toBe(false);
    const proofs = env.port.channels.get(env.ctx.registry.channelId('proofs')!)!;
    const ev = proofs.overwrites.find((o) => o.id === GUILD)!;
    expect(ev.deny & P.SendMessages).toBe(P.SendMessages);
    expect(total()).toBeGreaterThan(0);
    function total() {
      return totalResources();
    }
  });
});
