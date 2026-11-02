/** Kürzt Text auf eine Maximallänge (Discord-Limits) mit Auslassungszeichen. */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * Entschärft Nutzereingaben für Embeds: entfernt Steuerzeichen, neutralisiert
 * Massen-Erwähnungen und Markdown-Links. Erwähnungen werden zusätzlich über
 * allowedMentions technisch unterbunden.
 */
export function sanitizeUserText(input: string, max: number): string {
  const cleaned = input
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/@(everyone|here)/gi, '@​$1')
    .replace(/<@[!&]?\d{17,20}>/g, '[Erwähnung entfernt]')
    .replace(/\[([^\]]{0,200})\]\((https?:\/\/[^)]+)\)/g, '$1')
    .trim();
  return truncate(cleaned, max);
}

export function escapeMarkdown(s: string): string {
  return s.replace(/([\\*_~`|>#\[\]()-])/g, '\\$1');
}

export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function padNumber(n: number, width = 4): string {
  return String(n).padStart(width, '0');
}
