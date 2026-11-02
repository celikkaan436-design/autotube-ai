const DISCORD_EPOCH = 1420070400000n;

/** Erstellungszeitpunkt einer Discord-ID (Snowflake) in Millisekunden. */
export function snowflakeTime(id: string): number {
  return Number((BigInt(id) >> 22n) + DISCORD_EPOCH);
}

export function formatDate(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat('de-DE', { timeZone, day: '2-digit', month: '2-digit', year: 'numeric' }).format(ms);
}

export function formatDateTime(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat('de-DE', {
    timeZone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(ms);
}

/** Discord-Zeitstempel, den jeder Client in seiner eigenen Zeitzone anzeigt. */
export function discordTimestamp(ms: number, style: 'f' | 'F' | 'R' | 'd' | 'D' | 't' = 'f'): string {
  return `<t:${Math.floor(ms / 1000)}:${style}>`;
}

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
