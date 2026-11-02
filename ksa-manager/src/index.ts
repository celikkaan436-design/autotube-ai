import { ConfigError, loadEnvFile, parseEnv } from './config/env.js';
import { openDatabase } from './db/database.js';
import { startBot } from './discord/bot.js';
import { createLogger, errInfo } from './logging/logger.js';

/** Einstiegspunkt: Konfiguration → Logger → Datenbank (inkl. Migrationen) → Discord. */
async function main(): Promise<void> {
  // Neue Dateien (Datenbank, WAL, Proof-Bilder, Backups) nur für den Bot-Nutzer lesbar.
  process.umask(0o077);
  loadEnvFile();
  let config;
  try {
    config = parseEnv(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      console.error('Bitte .env anhand von .env.example ausfüllen (siehe README).');
      process.exit(2);
    }
    throw err;
  }
  const log = createLogger(config.logLevel);
  const db = openDatabase({ file: config.databasePath });
  log.info({ database: config.databasePath, guildId: config.guildId, messageContent: config.enableMessageContent }, 'KSA Manager startet');

  const bot = await startBot(config, db, log).catch((err: unknown) => {
    log.fatal({ err: errInfo(err) }, 'Start fehlgeschlagen (Token, Intents oder Netzwerk prüfen)');
    db.close();
    process.exit(1);
  });

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    const timer = setTimeout(() => {
      log.error('Herunterfahren dauert zu lange – erzwinge Ende');
      process.exit(1);
    }, 20_000);
    try {
      await bot.shutdown(signal);
    } catch (err) {
      log.error({ err: errInfo(err) }, 'Fehler beim Herunterfahren');
    } finally {
      db.close();
      clearTimeout(timer);
      log.info('Beendet');
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('unhandledRejection', (reason) => log.error({ err: errInfo(reason) }, 'Unbehandelte Promise-Ablehnung'));
  process.on('uncaughtException', (err) => {
    log.fatal({ err: errInfo(err) }, 'Unbehandelter Fehler');
    void stop('uncaughtException');
  });
}

void main();
