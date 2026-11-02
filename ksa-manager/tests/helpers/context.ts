import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pino } from 'pino';
import { SettingsService } from '../../src/config/settings.js';
import { openDatabase, type Db } from '../../src/db/database.js';
import type { Actor } from '../../src/domain/permissions.js';
import { AuditService } from '../../src/services/audit.js';
import type { AppContext } from '../../src/services/context.js';
import { createServices, type Services } from '../../src/services/index.js';
import { ResourceRegistry } from '../../src/services/registry.js';
import { Repo } from '../../src/services/repo.js';
import { KeyedMutex } from '../../src/util/mutex.js';
import { FakeClock, FakePort } from './fakePort.js';

export const GUILD = '1530667075536814110';
export const FOUNDERS = ['1551640828185940140', '1047235303146008598', '1008361725336231986'] as const;
export const IDS = {
  founder: FOUNDERS[0],
  founder2: FOUNDERS[1],
  admin: '200000000000000001',
  support: '200000000000000002',
  support2: '200000000000000003',
  operator: '200000000000000004',
  operator2: '200000000000000005',
  customer: '200000000000000006',
  customer2: '200000000000000007',
  member: '200000000000000008',
} as const;

export interface TestEnv {
  ctx: AppContext;
  s: Services;
  port: FakePort;
  clock: FakeClock;
  db: Db;
  dir: string;
  actor(userId: string): Actor;
}

export function createEnv(opts: { dbFile?: string; port?: FakePort; clock?: FakeClock; dir?: string } = {}): TestEnv {
  const clock = opts.clock ?? new FakeClock();
  const port = opts.port ?? new FakePort(clock, GUILD);
  const dir = opts.dir ?? mkdtempSync(path.join(tmpdir(), 'ksa-test-'));
  const db = openDatabase({ file: opts.dbFile ?? ':memory:' });
  const log = pino({ level: 'silent' });
  const registry = new ResourceRegistry(db, GUILD);
  const ctx: AppContext = {
    config: {
      guildId: GUILD,
      ownerIds: [...FOUNDERS],
      timezone: 'Europe/Berlin',
      logoUrl: undefined,
      proofStorageDir: path.join(dir, 'proofs'),
      enableMessageContent: true,
    },
    db,
    log,
    port,
    clock,
    settings: new SettingsService(db, GUILD),
    registry,
    locks: new KeyedMutex(),
    audit: new AuditService(db, GUILD, clock, log, () => port, registry),
    repo: new Repo(db, GUILD),
  };
  const s = createServices(ctx, { setupPaceMs: 0, overviewDebounceMs: 0 });
  const env: TestEnv = {
    ctx,
    s,
    port,
    clock,
    db,
    dir,
    actor: (userId: string) => ({ userId, roleIds: [...(port.members.get(userId)?.roleIds ?? [])] }),
  };
  return env;
}

/** Führt /setup vollständig aus (Vorschau + Bestätigung) als Founder. */
export async function runSetup(env: TestEnv, options = { correct: false, adoptForeign: false }) {
  const founder = { userId: IDS.founder, roleIds: [] };
  const preview = await env.s.setup.preview(founder, GUILD, options);
  const res = await env.s.setup.confirm(founder, GUILD, preview.planId, preview.plan.hash.slice(0, 16));
  return { preview, ...res };
}

/** Legt die Standard-Testmitglieder mit ihren Rollen an (nach dem Setup). */
export function addStandardMembers(env: TestEnv): void {
  const r = (k: Parameters<typeof env.ctx.registry.roleId>[0]) => env.ctx.registry.roleId(k)!;
  env.port.addMember(IDS.founder, 'xKyro');
  env.port.addMember(IDS.founder2, 'xSyro');
  env.port.addMember(IDS.admin, 'Admin', [r('admin')]);
  env.port.addMember(IDS.support, 'Support Eins', [r('support')]);
  env.port.addMember(IDS.support2, 'Support Zwei', [r('support')]);
  env.port.addMember(IDS.operator, 'Operator A', [r('operator')]);
  env.port.addMember(IDS.operator2, 'Operator B', [r('operator')]);
  env.port.addMember(IDS.customer, 'Kunde A', [r('community')]);
  env.port.addMember(IDS.customer2, 'Kunde B', [r('community')]);
  env.port.addMember(IDS.member, 'Mitglied', []);
}

export async function setupWithMembers(): Promise<TestEnv> {
  const env = createEnv();
  env.port.addMember(IDS.founder, 'xKyro');
  await runSetup(env);
  addStandardMembers(env);
  return env;
}

export const RANKED_FORM = {
  currentRank: 'Gold II, 4.300 SR',
  targetRank: 'Platin I',
  platform: 'PC',
  timeframe: 'zwei Wochen',
  details: 'Keine Besonderheiten',
};

/** Ticket → Angebot → Annahme → Auftrag. */
export async function createOrder(env: TestEnv, opts: { assignOperator?: boolean } = {}) {
  const ticket = await env.s.tickets.create(env.actor(IDS.customer), 'warzone', RANKED_FORM);
  if (opts.assignOperator !== false) await env.s.tickets.assignOperator(env.actor(IDS.support), ticket.id, ticket.channel_id, IDS.operator);
  const t = env.ctx.repo.ticket(ticket.id)!;
  const draft = env.s.offers.createDraft(env.actor(IDS.support), t, { startRank: 'Gold II', target: 'Platin I', scope: 'Rangaufstieg', price: '49,99', currency: 'EUR' });
  env.s.offers.completeDraft(env.actor(IDS.support), draft.id, t.channel_id, { timeframe: '7 Tage', cancellationTerms: 'Anteilige Erstattung' });
  const sent = await env.s.offers.send(env.actor(IDS.support), draft.id, t.channel_id);
  const { order } = await env.s.offers.accept(env.actor(IDS.customer), sent.id, sent.content_hash.slice(0, 16), t.channel_id);
  return { ticket: env.ctx.repo.ticket(ticket.id)!, offer: env.ctx.repo.offer(sent.id)!, order };
}
