import { CURRENCIES, type Currency } from '../domain/constants.js';

/**
 * Parst einen Preis wie "49,99", "49.99", "1.234,50" oder "120" in Cent.
 * Gibt null zurück, wenn der Wert ungültig, negativ oder unplausibel groß ist.
 */
export function parsePriceToCents(input: string): number | null {
  const s = input.trim().replace(/\s|€|eur|usd|chf|gbp|\$|£/gi, '');
  if (!/^\d{1,3}(?:[.,]?\d{3})*(?:[.,]\d{1,2})?$|^\d+(?:[.,]\d{1,2})?$/.test(s)) return null;
  let normalized: string;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  const decimalSep = Math.max(lastComma, lastDot);
  if (decimalSep !== -1 && s.length - decimalSep - 1 <= 2) {
    const intPart = s.slice(0, decimalSep).replace(/[.,]/g, '');
    const fracPart = s.slice(decimalSep + 1).padEnd(2, '0');
    normalized = `${intPart}.${fracPart}`;
  } else {
    normalized = s.replace(/[.,]/g, '');
  }
  const value = Number(normalized);
  if (!Number.isFinite(value) || value < 0 || value > 1_000_000) return null;
  return Math.round(value * 100);
}

export function parseCurrency(input: string): Currency | null {
  const c = input.trim().toUpperCase().replace('€', 'EUR');
  return (CURRENCIES as readonly string[]).includes(c) ? (c as Currency) : null;
}

export function formatPrice(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat('de-DE', { style: 'currency', currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2).replace('.', ',')} ${currency}`;
  }
}
