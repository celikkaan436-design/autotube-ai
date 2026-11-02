import { pino, type Logger } from 'pino';

export type { Logger };

/**
 * Strukturierte JSON-Logs. Secrets und private Inhalte werden zusätzlich zur
 * Disziplin im Code über Redaction-Pfade geschwärzt.
 * Regel: Niemals Nachrichteninhalte, Modal-Texte, Tokens oder Anhänge-URLs loggen.
 */
export function createLogger(level: string): Logger {
  return pino({
    level,
    base: { app: 'ksa-manager' },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        'token',
        '*.token',
        'authorization',
        '*.authorization',
        'headers.authorization',
        'content',
        '*.content',
        'body',
        '*.body',
        'url',
        '*.url',
        'proxyURL',
        '*.proxyURL',
        'text',
        '*.text',
      ],
      censor: '[entfernt]',
    },
    formatters: {
      level: (label) => ({ level: label }),
    },
  });
}

/** Fehlerobjekt für Logs reduzieren – ohne Request-Bodies, die Inhalte enthalten könnten. */
export function errInfo(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    const anyErr = err as Error & { code?: unknown; status?: unknown; method?: unknown };
    return {
      name: err.name,
      message: scrubSecrets(err.message),
      code: anyErr.code,
      status: anyErr.status,
      method: anyErr.method,
      stack: err.stack?.split('\n').slice(0, 6).map(scrubSecrets).join('\n'),
    };
  }
  return { message: scrubSecrets(String(err)) };
}

const TOKEN_LIKE = /[A-Za-z\d_-]{23,28}\.[A-Za-z\d_-]{6,7}\.[A-Za-z\d_-]{27,}/g;
const SIGNED_URL = /(https:\/\/(?:cdn|media)\.discordapp\.(?:com|net)\/[^\s?]+)\?[^\s]*/g;

export function scrubSecrets(s: string): string {
  return s.replace(TOKEN_LIKE, '[token entfernt]').replace(SIGNED_URL, '$1?[signatur entfernt]');
}
