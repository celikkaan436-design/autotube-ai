import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

/**
 * Konsistentes SQLite-Backup im laufenden Betrieb (Online-Backup-API von SQLite,
 * berücksichtigt den WAL-Inhalt). Aufruf: npm run backup -- [Zielordner]
 * Standard-Ziel: ./backups – liegt außerhalb von Git und ist nicht öffentlich.
 */
async function main(): Promise<void> {
  try {
    process.loadEnvFile('.env');
  } catch {
    /* .env optional */
  }
  const source = path.resolve(process.env.DATABASE_PATH ?? './data/ksa.sqlite');
  const targetDir = path.resolve(process.argv[2] ?? './backups');
  mkdirSync(targetDir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(targetDir, `ksa-${stamp}.sqlite`);
  const db = new Database(source, { readonly: true, fileMustExist: true });
  try {
    await db.backup(target);
  } finally {
    db.close();
  }
  // Backup als eigenständige Einzeldatei (ohne -wal/-shm) ablegen und prüfen.
  const check = new Database(target);
  check.pragma('journal_mode = DELETE');
  const result = check.prepare<[], { integrity_check: string }>('PRAGMA integrity_check').get();
  check.close();
  chmodSync(target, 0o600);
  if (result?.integrity_check !== 'ok') {
    console.error(`Backup erstellt, aber Integritätsprüfung meldet: ${result?.integrity_check}`);
    process.exit(1);
  }
  console.log(`Backup erstellt und geprüft: ${target}`);
}

main().catch((err: unknown) => {
  console.error('Backup fehlgeschlagen:', err instanceof Error ? err.message : err);
  process.exit(1);
});
