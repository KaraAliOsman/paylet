import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { env } from "./env";

mkdirSync(env.DATA_DIR, { recursive: true });
export const db = new DatabaseSync(process.env.PAYLET_DB ?? join(env.DATA_DIR, "paylet.sqlite"));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS drops (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  maker TEXT NOT NULL,
  blurb TEXT NOT NULL DEFAULT '',
  art TEXT NOT NULL DEFAULT 'tidepool',
  price_cents INTEGER NOT NULL,
  ship_hold_cents INTEGER NOT NULL,
  ship_actual_cents INTEGER NOT NULL,
  units INTEGER NOT NULL,
  waitlist_size INTEGER NOT NULL DEFAULT 3,
  closes_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',          -- open | drawn | settled
  seed TEXT NOT NULL,                           -- secret until the draw
  seed_hash TEXT NOT NULL,
  frozen_hash TEXT,
  frozen_list TEXT,
  forwarder_policy TEXT NOT NULL DEFAULT 'one_per_address',
  negative_test INTEGER NOT NULL DEFAULT 0,     -- simulate one failed capture at settlement
  seller_token TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'showcase',        -- showcase | judge
  created_at INTEGER NOT NULL,
  drawn_at INTEGER
);

CREATE TABLE IF NOT EXISTS entries (
  id TEXT PRIMARY KEY,
  public_id TEXT NOT NULL,
  drop_id TEXT NOT NULL REFERENCES drops(id),
  source TEXT NOT NULL,                         -- human | agent | simulated
  agent_label TEXT,
  order_id TEXT UNIQUE,
  payer_hash TEXT,
  account_hash TEXT,
  email_hash TEXT,
  display_name TEXT,
  name TEXT,
  email TEXT,
  address_json TEXT,
  status TEXT NOT NULL,                         -- awaiting_person | authorizing | held | duplicate | merged | won | waitlist | lost | captured | voided | capture_failed | expired | error
  authorization_id TEXT,
  hold_cents INTEGER,
  capture_id TEXT,
  captured_cents INTEGER,
  cluster_id TEXT,
  explanation TEXT,
  note TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS entries_one_per_payer ON entries(drop_id, payer_hash) WHERE payer_hash IS NOT NULL AND status <> 'duplicate';
CREATE INDEX IF NOT EXISTS entries_drop ON entries(drop_id, status);

CREATE TABLE IF NOT EXISTS clusters (
  id TEXT PRIMARY KEY,
  drop_id TEXT NOT NULL REFERENCES drops(id),
  kind TEXT NOT NULL,                           -- household | operator
  status TEXT NOT NULL DEFAULT 'suggested',     -- suggested | confirmed | dismissed
  method TEXT NOT NULL,                         -- rules | ai
  confidence REAL NOT NULL,
  evidence_json TEXT NOT NULL,
  explanation TEXT NOT NULL,
  member_ids TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS appeals (
  id TEXT PRIMARY KEY,
  drop_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  message TEXT NOT NULL,
  ai_triage TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ops (
  key TEXT PRIMARY KEY,                         -- also the PayPal-Request-Id
  kind TEXT NOT NULL,                           -- authorize | capture | void
  entry_id TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',       -- pending | done | failed
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ops_pending ON ops(status, next_at);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  drop_id TEXT,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  real INTEGER NOT NULL DEFAULT 0,              -- 1 = backed by a real PayPal sandbox API call
  data_json TEXT
);
CREATE INDEX IF NOT EXISTS events_drop ON events(drop_id, id);

CREATE TABLE IF NOT EXISTS webhook_events (
  event_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  resource_id TEXT,
  verified INTEGER NOT NULL,
  received_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS llm_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  purpose TEXT NOT NULL,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  ms INTEGER
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

export function now(): number {
  return Date.now();
}

export function getSetting(key: string): string | undefined {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}

export function setSetting(key: string, value: string): void {
  db.prepare("INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

export function tx<T>(fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
