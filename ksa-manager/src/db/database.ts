import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { migrations, type Migration } from './migrations.js';

export type Db = Database.Database;

export interface OpenDbOptions {
  /** Pfad zur SQLite-Datei oder ":memory:" für Tests. */
  file: string;
}

/** Öffnet die Datenbank mit sicheren Standardeinstellungen und führt Migrationen aus. */
export function openDatabase({ file }: OpenDbOptions): Db {
  if (file !== ':memory:') {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  }
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('secure_delete = ON');
  runMigrations(db, migrations);
  return db;
}

export function runMigrations(db: Db, list: readonly Migration[]): number[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  )`);
  const applied = new Set(
    db.prepare<[], { version: number }>('SELECT version FROM schema_migrations').all().map((r) => r.version),
  );
  const sorted = [...list].sort((a, b) => a.version - b.version);
  const ran: number[] = [];
  for (const m of sorted) {
    if (applied.has(m.version)) continue;
    const apply = db.transaction(() => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        m.version,
        m.name,
        Date.now(),
      );
    });
    apply();
    ran.push(m.version);
  }
  return ran;
}

export function schemaVersion(db: Db): number {
  const row = db.prepare<[], { v: number | null }>('SELECT MAX(version) AS v FROM schema_migrations').get();
  return row?.v ?? 0;
}
