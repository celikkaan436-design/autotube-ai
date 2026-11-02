import Database from 'better-sqlite3';

/** Container-Healthcheck: gesund, wenn der Bot in den letzten 3 Minuten einen Heartbeat geschrieben hat. */
const file = process.env.DATABASE_PATH ?? './data/ksa.sqlite';
try {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  const row = db.prepare<[], { value: string }>("SELECT value FROM bot_state WHERE key = 'last_heartbeat'").get();
  db.close();
  const age = Date.now() - Number(row?.value ?? 0);
  if (!row || age > 3 * 60_000) {
    console.error(`ungesund: letzter Heartbeat vor ${Math.round(age / 1000)} s`);
    process.exit(1);
  }
  process.exit(0);
} catch (err) {
  console.error('ungesund:', err instanceof Error ? err.message : err);
  process.exit(1);
}
