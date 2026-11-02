/** Fachliche Konstanten. Anzeigenamen sind deutsch, interne Schlüssel stabil. */

export const GAMES = ['warzone', 'multiplayer'] as const;
export type Game = (typeof GAMES)[number];

export const GAME_LABEL: Record<Game, string> = {
  warzone: 'Call of Duty: Warzone Ranked',
  multiplayer: 'Call of Duty: Multiplayer Ranked',
};

export const GAME_SHORT: Record<Game, string> = {
  warzone: 'Warzone Ranked',
  multiplayer: 'Multiplayer Ranked',
};

export const TICKET_KINDS = ['warzone', 'multiplayer', 'support'] as const;
export type TicketKind = (typeof TICKET_KINDS)[number];

export const TICKET_KIND_LABEL: Record<TicketKind, string> = {
  warzone: 'Warzone Ranked',
  multiplayer: 'Multiplayer Ranked',
  support: 'Allgemeiner Support',
};

export const TICKET_KIND_SLUG: Record<TicketKind, string> = {
  warzone: 'wz',
  multiplayer: 'mp',
  support: 'support',
};

export function isGame(kind: string): kind is Game {
  return (GAMES as readonly string[]).includes(kind);
}

export type TicketStatus = 'creating' | 'open' | 'closed' | 'failed' | 'channel_deleted';
export type TicketPhase = 'anfrage' | 'angebot_gesendet' | 'angebot_angenommen';

export const ORDER_STATUSES = [
  'angebot_angenommen',
  'wartet',
  'in_bearbeitung',
  'pausiert',
  'abgeschlossen',
  'storniert',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** Gesamter Vorgangsstatus inkl. der Phasen vor einem Auftrag. */
export type ProcessStatus = TicketPhase | OrderStatus;

export const PROCESS_STATUS_LABEL: Record<ProcessStatus, string> = {
  anfrage: 'Anfrage',
  angebot_gesendet: 'Angebot gesendet',
  angebot_angenommen: 'Angebot angenommen',
  wartet: 'Wartet auf Bearbeitung',
  in_bearbeitung: 'In Bearbeitung',
  pausiert: 'Pausiert',
  abgeschlossen: 'Abgeschlossen',
  storniert: 'Storniert',
};

export const PAYMENT_STATUSES = ['offen', 'bezahlt', 'teilweise_erstattet', 'erstattet'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const PAYMENT_STATUS_LABEL: Record<PaymentStatus, string> = {
  offen: 'Offen',
  bezahlt: 'Manuell als bezahlt bestätigt',
  teilweise_erstattet: 'Teilweise erstattet',
  erstattet: 'Erstattet',
};

export const OFFER_STATUS_LABEL: Record<string, string> = {
  draft: 'Entwurf',
  sent: 'Gesendet – wartet auf Antwort',
  accepted: 'Angenommen',
  declined: 'Abgelehnt',
  superseded: 'Durch neuere Version ersetzt',
  withdrawn: 'Zurückgezogen',
};

export const PROOF_STATUS_LABEL: Record<string, string> = {
  pending: 'Wartet auf Freigaben',
  declined: 'Vom Kunden abgelehnt',
  publishing: 'Wird veröffentlicht',
  published: 'Veröffentlicht',
  withdrawn: 'Zurückgenommen',
  cancelled: 'Verworfen',
};

export const CURRENCIES = ['EUR', 'USD', 'CHF', 'GBP'] as const;
export type Currency = (typeof CURRENCIES)[number];

export const PLATFORMS = ['PC', 'PlayStation', 'Xbox'] as const;

/** Farben: dunkles Design, Rot als Akzent. */
export const COLORS = {
  accent: 0xe53935,
  accentDark: 0xb71c1c,
  neutral: 0x2b2d31,
  success: 0x43a047,
  warning: 0xffa000,
  muted: 0x6d6f78,
  booster: 0xf47fff,
} as const;

export const BRAND = 'KSA Boosting';
export const BOT_NAME = 'KSA Manager';
