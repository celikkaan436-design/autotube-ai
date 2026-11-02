import { z } from 'zod';
import type { Db } from '../db/database.js';
import { CURRENCIES } from '../domain/constants.js';
import { UserError } from '../util/errors.js';

/**
 * Laufzeit-Einstellungen, die Founder per /config ändern können. Gespeichert in
 * SQLite, validiert per zod. Keine erfundenen Werte: Ränge und Saison sind
 * standardmäßig leer und werden vom Team gepflegt.
 */

const list = z.array(z.string().trim().min(1).max(60)).max(40);

const defs = {
  'tickets.maxOpenPerUser': {
    schema: z.number().int().min(1).max(10),
    default: 2,
    label: 'Maximal offene Tickets je Kunde',
  },
  'tickets.createCooldownSeconds': {
    schema: z.number().int().min(0).max(3600),
    default: 120,
    label: 'Wartezeit zwischen zwei Ticket-Erstellungen (Sekunden)',
  },
  'games.warzone.ranks': {
    schema: list,
    default: [] as string[],
    label: 'Warzone-Ränge (kommagetrennt, nur Anzeige/Hinweis)',
  },
  'games.multiplayer.ranks': {
    schema: list,
    default: [] as string[],
    label: 'Multiplayer-Ränge (kommagetrennt, nur Anzeige/Hinweis)',
  },
  'games.season': {
    schema: z.string().trim().max(80),
    default: '',
    label: 'Aktuelle Saison-Bezeichnung (leer = keine Angabe)',
  },
  'offers.defaultCurrency': {
    schema: z.enum(CURRENCIES),
    default: 'EUR' as (typeof CURRENCIES)[number],
    label: 'Standardwährung für Angebote',
  },
  'boost.thanksEnabled': {
    schema: z.boolean(),
    default: true,
    label: 'Automatische Boost-Danksagung aktiv',
  },
  'boost.mentionBooster': {
    schema: z.boolean(),
    default: true,
    label: 'Booster in der Danksagung erwähnen (nur diese Person)',
  },
  'boost.roleMode': {
    schema: z.enum(['managed', 'custom']),
    default: 'custom' as 'managed' | 'custom',
    label: 'Booster-Rolle: managed = Discord-Rolle, custom = eigene Rolle „Server Booster“',
  },
  'boost.extraPerks': {
    schema: list,
    default: [] as string[],
    label: 'Zusätzliche, tatsächlich eingerichtete Booster-Vorteile (kommagetrennt)',
  },
  'community.requireRulesAcceptance': {
    schema: z.boolean(),
    default: true,
    label: 'Bereiche erst nach „Regeln akzeptieren“ sichtbar (wirkt nach /setup start korrigieren:true)',
  },
  'community.welcomeEnabled': {
    schema: z.boolean(),
    default: true,
    label: 'Begrüßung neuer Mitglieder',
  },
  'community.floodGuardEnabled': {
    schema: z.boolean(),
    default: true,
    label: 'Einfacher Flood-Schutz in Community-Kanälen',
  },
  'community.floodMaxMessages': {
    schema: z.number().int().min(3).max(30),
    default: 6,
    label: 'Flood-Schutz: maximale Nachrichten im Zeitfenster',
  },
  'community.floodWindowSeconds': {
    schema: z.number().int().min(2).max(60),
    default: 8,
    label: 'Flood-Schutz: Zeitfenster (Sekunden)',
  },
  'community.floodTimeoutMinutes': {
    schema: z.number().int().min(0).max(60),
    default: 5,
    label: 'Flood-Schutz: Timeout in Minuten (0 = kein Timeout)',
  },
  'proofs.maxImages': {
    schema: z.number().int().min(1).max(10),
    default: 10,
    label: 'Proof: maximale Bildanzahl (Discord erlaubt höchstens 10 Anhänge)',
  },
  'proofs.maxImageMb': {
    schema: z.number().int().min(1).max(20),
    default: 8,
    label: 'Proof: maximale Größe je Bild in MB',
  },
  'retention.archivedTicketDays': {
    schema: z.number().int().min(0).max(3650),
    default: 0,
    label: 'Archivierte Ticketkanäle nach X Tagen löschen (0 = nie automatisch)',
  },
  'retention.proofStagingDays': {
    schema: z.number().int().min(1).max(365),
    default: 30,
    label: 'Unveröffentlichte Proof-Bilder nach X Tagen löschen',
  },
  'retention.closedOrderDays': {
    schema: z.number().int().min(0).max(3650),
    default: 0,
    label: 'Auftragsdetails X Tage nach Abschluss anonymisieren (0 = nie automatisch)',
  },
  'retention.auditDays': {
    schema: z.number().int().min(0).max(3650),
    default: 0,
    label: 'Audit-Einträge nach X Tagen löschen (0 = nie automatisch)',
  },
} as const;

type Defs = typeof defs;
export type SettingKey = keyof Defs;
export type SettingValue<K extends SettingKey> = z.infer<Defs[K]['schema']>;
export const SETTING_KEYS = Object.keys(defs) as SettingKey[];

export function settingLabel(key: SettingKey): string {
  return defs[key].label;
}

export function isSettingKey(key: string): key is SettingKey {
  return key in defs;
}

/** Wandelt eine Texteingabe aus /config in den typisierten Wert um. */
export function parseSettingInput<K extends SettingKey>(key: K, raw: string): SettingValue<K> {
  const def = defs[key];
  const input = raw.trim();
  let candidate: unknown;
  const d: unknown = def.default;
  if (typeof d === 'number') {
    if (!/^-?\d+$/.test(input)) throw new UserError('Bitte eine ganze Zahl angeben.');
    candidate = Number(input);
  } else if (typeof d === 'boolean') {
    const v = input.toLowerCase();
    if (['ja', 'true', 'an', 'on', '1'].includes(v)) candidate = true;
    else if (['nein', 'false', 'aus', 'off', '0'].includes(v)) candidate = false;
    else throw new UserError('Bitte „ja“ oder „nein“ angeben.');
  } else if (Array.isArray(d)) {
    candidate = input === '' || input === '-' ? [] : input.split(',').map((s) => s.trim()).filter(Boolean);
  } else {
    candidate = input === '-' ? '' : input;
  }
  const parsed = def.schema.safeParse(candidate);
  if (!parsed.success) {
    throw new UserError(`Ungültiger Wert: ${parsed.error.issues.map((i) => i.message).join(', ')}`);
  }
  return parsed.data as SettingValue<K>;
}

export function formatSettingValue(value: unknown): string {
  if (Array.isArray(value)) return value.length ? value.join(', ') : '(leer)';
  if (typeof value === 'boolean') return value ? 'ja' : 'nein';
  if (value === '') return '(leer)';
  return String(value);
}

export class SettingsService {
  constructor(
    private readonly db: Db,
    private readonly guildId: string,
  ) {}

  get<K extends SettingKey>(key: K): SettingValue<K> {
    const row = this.db
      .prepare<[string, string], { value_json: string }>('SELECT value_json FROM settings WHERE guild_id = ? AND key = ?')
      .get(this.guildId, key);
    const def = defs[key];
    if (!row) return def.default as SettingValue<K>;
    try {
      const parsed = def.schema.safeParse(JSON.parse(row.value_json));
      return (parsed.success ? parsed.data : def.default) as SettingValue<K>;
    } catch {
      return def.default as SettingValue<K>;
    }
  }

  set<K extends SettingKey>(key: K, value: SettingValue<K>, actorId: string, now = Date.now()): void {
    const parsed = defs[key].schema.parse(value);
    this.db
      .prepare(
        `INSERT INTO settings (guild_id, key, value_json, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(guild_id, key) DO UPDATE SET value_json = excluded.value_json, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      )
      .run(this.guildId, key, JSON.stringify(parsed), actorId, now);
  }

  reset(key: SettingKey): void {
    this.db.prepare('DELETE FROM settings WHERE guild_id = ? AND key = ?').run(this.guildId, key);
  }

  isDefault(key: SettingKey): boolean {
    return !this.db.prepare('SELECT 1 FROM settings WHERE guild_id = ? AND key = ?').get(this.guildId, key);
  }

  all(): { key: SettingKey; value: unknown; label: string; isDefault: boolean }[] {
    return SETTING_KEYS.map((key) => ({ key, value: this.get(key), label: defs[key].label, isDefault: this.isDefault(key) }));
  }
}
