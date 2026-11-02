import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseEnv } from '../src/config/env.js';
import { parseSettingInput, SettingsService } from '../src/config/settings.js';
import { openDatabase, runMigrations, schemaVersion } from '../src/db/database.js';
import { migrations } from '../src/db/migrations.js';
import { commandDefinitions } from '../src/discord/commands.js';
import { PANELS } from '../src/content/panels.js';
import { createEnv, IDS, RANKED_FORM, runSetup, addStandardMembers } from './helpers/context.js';
import { MEMBER_UPDATE_DELAY_MS } from '../src/services/boosts.js';
import { extractSr } from '../src/services/tickets.js';
import { parsePriceToCents } from '../src/util/money.js';
import { hashObject } from '../src/util/hash.js';
import { scrubSecrets } from '../src/logging/logger.js';
import { sanitizeUserText } from '../src/util/text.js';

describe('Persistenz nach Neustart', () => {
  it('Setup-Ressourcen, Tickets, Angebote und Einstellungen überleben einen Neustart', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ksa-persist-'));
    const dbFile = path.join(dir, 'ksa.sqlite');
    const env = createEnv({ dbFile, dir });
    env.port.addMember(IDS.founder, 'xKyro');
    await runSetup(env);
    addStandardMembers(env);
    env.ctx.settings.set('tickets.maxOpenPerUser', 3, IDS.founder);
    const t = await env.s.tickets.create(env.actor(IDS.customer), 'warzone', RANKED_FORM);
    const d = env.s.offers.createDraft(env.actor(IDS.support), t, { startRank: 'Gold', target: 'Platin', scope: 'x', price: '10', currency: 'EUR' });
    env.ctx.db.close();

    // Neuer Prozess: gleiche Datei, gleicher Discord-Zustand
    const env2 = createEnv({ dbFile, dir, port: env.port, clock: env.clock });
    expect(schemaVersion(env2.db)).toBe(migrations.length);
    expect(env2.ctx.settings.get('tickets.maxOpenPerUser')).toBe(3);
    expect(env2.ctx.repo.ticket(t.id)?.channel_id).toBe(t.channel_id);
    expect(env2.ctx.repo.offer(d.id)?.status).toBe('draft');
    // Ein erneutes Setup erkennt alles wieder – keine Duplikate
    const channels = env.port.channels.size;
    const { preview } = await runSetup(env2);
    expect(preview.plan.items.filter((i) => i.op.startsWith('create') || i.op === 'post_panel')).toEqual([]);
    expect(env.port.channels.size).toBe(channels);
    // Ticketnummern laufen weiter
    const t2 = await env2.s.tickets.create(env2.actor(IDS.customer2), 'multiplayer', RANKED_FORM);
    expect(t2.number).toBe(2);
    env2.ctx.db.close();
  });

  it('Boost-Deduplizierung überlebt einen Neustart (kein zweiter Dank)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ksa-persist-'));
    const dbFile = path.join(dir, 'ksa.sqlite');
    const env = createEnv({ dbFile, dir });
    env.port.addMember(IDS.founder, 'xKyro');
    await runSetup(env);
    addStandardMembers(env);
    await env.s.boosts.baseline(undefined);
    const msgId = env.port.newId();
    await env.s.boosts.onSystemBoostMessage(msgId, IDS.customer, env.clock.now());
    env.s.boosts.stop();
    env.ctx.db.close();
    const env2 = createEnv({ dbFile, dir, port: env.port, clock: env.clock });
    await env2.s.boosts.baseline(env.clock.now());
    await env2.s.boosts.onSystemBoostMessage(msgId, IDS.customer, env.clock.now());
    env.clock.advance(MEMBER_UPDATE_DELAY_MS + 1);
    await env2.s.boosts.processDue();
    const thanks = env.port.messagesIn(env2.ctx.registry.channelId('boost_danke')!);
    expect(thanks).toHaveLength(1);
    env2.s.boosts.stop();
    env2.ctx.db.close();
  });

  it('Migrationen sind idempotent', () => {
    const db = openDatabase({ file: ':memory:' });
    expect(runMigrations(db, migrations)).toEqual([]);
    expect(schemaVersion(db)).toBe(1);
    db.close();
  });
});

describe('Konfiguration', () => {
  const base = {
    DISCORD_TOKEN: 'x'.repeat(24) + '.' + 'y'.repeat(6) + '.' + 'z'.repeat(30),
    DISCORD_CLIENT_ID: '123456789012345678',
    DISCORD_GUILD_ID: '1530667075536814110',
    OWNER_IDS: '1551640828185940140,1047235303146008598,1008361725336231986',
  };
  it('validiert Umgebungsvariablen und übernimmt die festen IDs', () => {
    const c = parseEnv(base);
    expect(c.guildId).toBe('1530667075536814110');
    expect(c.ownerIds).toEqual(['1551640828185940140', '1047235303146008598', '1008361725336231986']);
    expect(c.timezone).toBe('Europe/Berlin');
    expect(c.enableMessageContent).toBe(true);
    expect(c.logoUrl).toBeUndefined();
  });
  it('weist ungültige Werte ab, ohne den Token preiszugeben', () => {
    expect(() => parseEnv({ ...base, OWNER_IDS: 'xKyro' })).toThrow(/OWNER_IDS/);
    expect(() => parseEnv({ ...base, LOGO_URL: 'http://unsicher.example/logo.png' })).toThrow();
    expect(() => parseEnv({ ...base, TIMEZONE: 'Mond/Basis' })).toThrow(/Zeitzone/);
    try {
      parseEnv({ ...base, DISCORD_CLIENT_ID: 'abc' });
    } catch (e) {
      expect(String(e)).not.toContain(base.DISCORD_TOKEN);
    }
  });
  it('parst und validiert /config-Werte', () => {
    expect(parseSettingInput('tickets.maxOpenPerUser', '3')).toBe(3);
    expect(() => parseSettingInput('tickets.maxOpenPerUser', '99')).toThrow();
    expect(parseSettingInput('boost.thanksEnabled', 'nein')).toBe(false);
    expect(parseSettingInput('games.warzone.ranks', 'Bronze, Silber , Gold')).toEqual(['Bronze', 'Silber', 'Gold']);
    expect(parseSettingInput('games.season', '-')).toBe('');
    const db = openDatabase({ file: ':memory:' });
    const s = new SettingsService(db, '1');
    expect(s.get('games.warzone.ranks')).toEqual([]);
    expect(s.get('games.season')).toBe('');
    db.close();
  });
});

describe('Hilfsfunktionen und Befehle', () => {
  it('Preise und SR werden robust geparst', () => {
    expect(parsePriceToCents('49,99')).toBe(4999);
    expect(parsePriceToCents('1.234,50 €')).toBe(123450);
    expect(parsePriceToCents('120')).toBe(12000);
    expect(parsePriceToCents('-5')).toBeNull();
    expect(parsePriceToCents('abc')).toBeNull();
    expect(extractSr('Gold II, 4.300 SR')).toBe(4300);
    expect(extractSr('Platin')).toBeNull();
  });
  it('Logs schwärzen Tokens und signierte Anhang-URLs', () => {
    const tok = 'M'.repeat(24) + '.ABCDEF.' + 'q'.repeat(30);
    expect(scrubSecrets(`Fehler mit ${tok}`)).not.toContain(tok);
    expect(scrubSecrets('https://cdn.discordapp.com/attachments/1/2/a.png?ex=1&is=2&hm=3')).not.toContain('hm=3');
  });
  it('Nutzereingaben werden entschärft', () => {
    expect(sanitizeUserText('Hallo @everyone <@&123456789012345678> [klick](https://x.y)', 200)).toBe('Hallo @​everyone [Erwähnung entfernt] klick');
  });
  it('Befehlsdefinitionen sind gültig und vollständig', () => {
    const defs = commandDefinitions();
    const names = defs.map((d) => d.name);
    for (const n of ['setup', 'health', 'help', 'panel', 'config', 'ticket', 'angebot', 'auftrag', 'proof', 'bewertung', 'serverboost', 'Als Proof einreichen']) expect(names).toContain(n);
    expect(JSON.stringify(defs).length).toBeLessThan(8000 * defs.length);
  });
  it('Panels halten Discord-Limits ein und enthalten keine erfundenen Preise', () => {
    const ctx = {
      guildId: '1',
      channels: {},
      roles: {},
      booster: { roleId: '1', hoist: true, managed: false },
      settings: { maxOpenTickets: 2, requireRulesAcceptance: true, warzoneRanks: [], multiplayerRanks: [], season: '', extraBoostPerks: [] },
    };
    for (const p of PANELS) {
      const payload = p.render(ctx);
      const text = JSON.stringify(payload);
      expect(text).not.toMatch(/\d+[,.]\d{2}\s?€|€\s?\d/);
      expect(text).not.toMatch(/100 ?%|garantiert|bannfrei|offizielle? Partner/i);
      let total = 0;
      for (const e of payload.embeds ?? []) {
        expect((e.description ?? '').length).toBeLessThanOrEqual(4096);
        for (const f of e.fields ?? []) expect(f.value.length).toBeLessThanOrEqual(1024);
        total += (e.title?.length ?? 0) + (e.description?.length ?? 0) + (e.fields ?? []).reduce((n, f) => n + f.name.length + f.value.length, 0) + (e.footer?.text.length ?? 0);
      }
      expect(total).toBeLessThanOrEqual(6000);
      expect(hashObject(payload)).toBe(hashObject(p.render(ctx)));
    }
  });
});
