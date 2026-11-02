import { existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/** Discord-Snowflake: 17–20 Ziffern, immer als String behandelt. */
export const snowflake = z.string().regex(/^\d{17,20}$/, 'muss eine Discord-ID (17–20 Ziffern) sein');

const booleanFlag = (defaultValue: boolean) =>
  z
    .enum(['true', 'false', '1', '0', 'yes', 'no', 'ja', 'nein'])
    .optional()
    .transform((v) => (v === undefined ? defaultValue : ['true', '1', 'yes', 'ja'].includes(v)));

const envSchema = z.object({
  DISCORD_TOKEN: z.string().min(50, 'DISCORD_TOKEN fehlt oder ist zu kurz'),
  DISCORD_CLIENT_ID: snowflake,
  DISCORD_GUILD_ID: snowflake,
  OWNER_IDS: z
    .string()
    .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean))
    .pipe(z.array(snowflake).min(1, 'mindestens eine Founder-ID nötig').max(10)),
  DATABASE_PATH: z.string().min(1).default('./data/ksa.sqlite'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  TIMEZONE: z
    .string()
    .default('Europe/Berlin')
    .refine((tz) => {
      try {
        new Intl.DateTimeFormat('de-DE', { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    }, 'unbekannte Zeitzone'),
  LOGO_URL: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined))
    .pipe(z.url({ protocol: /^https$/ }).optional()),
  PROOF_STORAGE_DIR: z.string().min(1).default('./data/proofs'),
  ENABLE_MESSAGE_CONTENT: booleanFlag(true),
  REGISTER_COMMANDS_ON_START: booleanFlag(true),
  LEAVE_FOREIGN_GUILDS: booleanFlag(true),
});

export interface AppConfig {
  token: string;
  clientId: string;
  guildId: string;
  ownerIds: readonly string[];
  databasePath: string;
  logLevel: z.infer<typeof envSchema>['LOG_LEVEL'];
  timezone: string;
  logoUrl: string | undefined;
  proofStorageDir: string;
  enableMessageContent: boolean;
  registerCommandsOnStart: boolean;
  leaveForeignGuilds: boolean;
}

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Ungültige Konfiguration:\n- ${issues.join('\n- ')}`);
    this.name = 'ConfigError';
  }
}

/** Liest und validiert Umgebungsvariablen. Gibt niemals den Token in Fehlermeldungen aus. */
export function parseEnv(source: NodeJS.ProcessEnv): AppConfig {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.') || 'env'}: ${i.message}`);
    throw new ConfigError(issues);
  }
  const e = result.data;
  return Object.freeze({
    token: e.DISCORD_TOKEN,
    clientId: e.DISCORD_CLIENT_ID,
    guildId: e.DISCORD_GUILD_ID,
    ownerIds: Object.freeze([...new Set(e.OWNER_IDS)]),
    databasePath: path.resolve(e.DATABASE_PATH),
    logLevel: e.LOG_LEVEL,
    timezone: e.TIMEZONE,
    logoUrl: e.LOGO_URL,
    proofStorageDir: path.resolve(e.PROOF_STORAGE_DIR),
    enableMessageContent: e.ENABLE_MESSAGE_CONTENT,
    registerCommandsOnStart: e.REGISTER_COMMANDS_ON_START,
    leaveForeignGuilds: e.LEAVE_FOREIGN_GUILDS,
  });
}

/** Lädt optional eine lokale .env-Datei (Node-eigene Funktion, keine Zusatzbibliothek). */
export function loadEnvFile(file = '.env'): void {
  if (existsSync(file)) {
    process.loadEnvFile(file);
  }
}
