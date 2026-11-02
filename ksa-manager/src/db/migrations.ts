/**
 * Versionierte Migrationen. Jede Migration läuft genau einmal in einer Transaktion.
 * Bestehende Migrationen niemals nachträglich ändern – nur neue anhängen.
 * Alle Discord-IDs werden als TEXT gespeichert, Zeitstempel als Unix-Millisekunden.
 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    sql: `
CREATE TABLE bot_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE settings (
  guild_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, key)
);

CREATE TABLE setup_resources (
  guild_id TEXT NOT NULL,
  key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('role','category','text','voice','panel','automod')),
  discord_id TEXT,
  channel_id TEXT,
  content_hash TEXT,
  status TEXT NOT NULL CHECK (status IN ('in_progress','done','failed')),
  adopted INTEGER NOT NULL DEFAULT 0,
  managed_by_discord INTEGER NOT NULL DEFAULT 0,
  attempt_started_at INTEGER,
  last_error TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, key)
);
CREATE UNIQUE INDEX idx_setup_resources_discord_id ON setup_resources(guild_id, kind, discord_id) WHERE discord_id IS NOT NULL;

CREATE TABLE setup_plans (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  plan_hash TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  options_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','running','done','failed','cancelled','expired','stale')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  finished_at INTEGER,
  result_json TEXT
);

CREATE TABLE counters (
  guild_id TEXT NOT NULL,
  name TEXT NOT NULL,
  value INTEGER NOT NULL,
  PRIMARY KEY (guild_id, name)
);

CREATE TABLE tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('warzone','multiplayer','support')),
  customer_id TEXT NOT NULL,
  channel_id TEXT UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('creating','open','closed','failed','channel_deleted')),
  phase TEXT NOT NULL DEFAULT 'anfrage' CHECK (phase IN ('anfrage','angebot_gesendet','angebot_angenommen')),
  claimed_by TEXT,
  assigned_operator_id TEXT,
  current_rank TEXT,
  current_sr INTEGER,
  target_rank TEXT,
  platform TEXT,
  timeframe TEXT,
  details TEXT,
  subject TEXT,
  summary_message_id TEXT,
  customer_left INTEGER NOT NULL DEFAULT 0,
  close_reason TEXT,
  closed_by TEXT,
  closed_at INTEGER,
  reopen_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (guild_id, number)
);
CREATE INDEX idx_tickets_customer ON tickets(guild_id, customer_id, status);
CREATE INDEX idx_tickets_status ON tickets(guild_id, status);

CREATE TABLE offers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id),
  version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','sent','accepted','declined','superseded','withdrawn')),
  game TEXT NOT NULL CHECK (game IN ('warzone','multiplayer')),
  start_rank TEXT NOT NULL,
  target TEXT NOT NULL,
  scope TEXT NOT NULL,
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  currency TEXT NOT NULL,
  timeframe TEXT,
  cancellation_terms TEXT,
  content_hash TEXT NOT NULL,
  message_id TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  sent_at INTEGER,
  decided_at INTEGER,
  decided_by TEXT,
  UNIQUE (ticket_id, version)
);

CREATE TABLE orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  ticket_id INTEGER NOT NULL UNIQUE REFERENCES tickets(id),
  customer_id TEXT NOT NULL,
  game TEXT NOT NULL CHECK (game IN ('warzone','multiplayer')),
  start_rank TEXT NOT NULL,
  target TEXT NOT NULL,
  accepted_offer_id INTEGER NOT NULL REFERENCES offers(id),
  accepted_offer_version INTEGER NOT NULL,
  accepted_offer_hash TEXT NOT NULL,
  operator_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('angebot_angenommen','wartet','in_bearbeitung','pausiert','abgeschlossen','storniert')),
  payment_status TEXT NOT NULL DEFAULT 'offen' CHECK (payment_status IN ('offen','bezahlt','teilweise_erstattet','erstattet')),
  progress_percent INTEGER NOT NULL DEFAULT 0 CHECK (progress_percent BETWEEN 0 AND 100),
  progress_note TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  cancelled_at INTEGER
);
CREATE INDEX idx_orders_status ON orders(guild_id, status);
CREATE INDEX idx_orders_customer ON orders(guild_id, customer_id);

CREATE TABLE order_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  actor_id TEXT NOT NULL,
  type TEXT NOT NULL,
  from_value TEXT,
  to_value TEXT,
  details TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_order_events_order ON order_events(order_id);

CREATE TABLE order_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  author_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_order_notes_order ON order_notes(order_id);

CREATE TABLE proof_candidates (
  token TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id),
  message_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  attachments_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE proofs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  ticket_id INTEGER NOT NULL REFERENCES tickets(id),
  status TEXT NOT NULL CHECK (status IN ('pending','declined','publishing','published','withdrawn','cancelled')),
  version INTEGER NOT NULL DEFAULT 1,
  version_hash TEXT NOT NULL,
  public_text TEXT NOT NULL,
  show_operator INTEGER NOT NULL DEFAULT 0,
  operator_display_name TEXT,
  customer_display TEXT NOT NULL DEFAULT 'anonymous' CHECK (customer_display IN ('anonymous','display_name')),
  customer_display_name TEXT,
  preview_message_id TEXT,
  review_message_id TEXT,
  created_by TEXT NOT NULL,
  publish_nonce TEXT,
  publish_attempts INTEGER NOT NULL DEFAULT 0,
  publish_started_at INTEGER,
  public_channel_id TEXT,
  public_message_id TEXT,
  published_at INTEGER,
  withdrawn_at INTEGER,
  withdrawn_by TEXT,
  withdraw_reason TEXT,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_proofs_one_active ON proofs(order_id) WHERE status IN ('pending','declined','publishing');
CREATE INDEX idx_proofs_status ON proofs(guild_id, status);

CREATE TABLE proof_images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  proof_id INTEGER NOT NULL REFERENCES proofs(id),
  position INTEGER NOT NULL,
  source_message_id TEXT NOT NULL,
  source_attachment_id TEXT NOT NULL,
  original_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  ext TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  storage_path TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (proof_id, sha256)
);
CREATE INDEX idx_proof_images_sha ON proof_images(sha256);

CREATE TABLE proof_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  proof_id INTEGER NOT NULL REFERENCES proofs(id),
  version INTEGER NOT NULL,
  version_hash TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('customer','team')),
  decision TEXT NOT NULL CHECK (decision IN ('approved','declined','revoked')),
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_proof_decisions_one_approval ON proof_decisions(proof_id, version, kind) WHERE decision = 'approved';

CREATE TABLE reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id),
  customer_id TEXT NOT NULL,
  stars INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
  text TEXT,
  publish_consent INTEGER NOT NULL CHECK (publish_consent IN (0,1)),
  display_mode TEXT NOT NULL CHECK (display_mode IN ('anonymous','display_name')),
  display_name TEXT,
  public_channel_id TEXT,
  public_message_id TEXT,
  published_at INTEGER,
  text_hidden INTEGER NOT NULL DEFAULT 0,
  hidden_by TEXT,
  hidden_reason TEXT,
  hidden_at INTEGER,
  withdrawn_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE boost_member_state (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  premium_since INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE boost_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('system_message','member_update')),
  source_key TEXT NOT NULL UNIQUE,
  occurred_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','thanked','merged','stale','failed','disabled')),
  due_at INTEGER NOT NULL,
  merged_into INTEGER REFERENCES boost_events(id),
  thank_message_id TEXT,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  processed_at INTEGER
);
CREATE INDEX idx_boost_events_user ON boost_events(guild_id, user_id, occurred_at);
CREATE INDEX idx_boost_events_status ON boost_events(status, due_at);

CREATE TABLE cooldowns (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  until INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id, action)
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  details TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_audit_created ON audit_log(guild_id, created_at);
`,
  },
];
