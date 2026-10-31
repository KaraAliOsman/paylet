import { createHmac, randomBytes } from "node:crypto";
import { db, now } from "./db";
import { env } from "./env";

export interface DropRow {
  id: string;
  slug: string;
  title: string;
  maker: string;
  blurb: string;
  art: string;
  price_cents: number;
  ship_hold_cents: number;
  ship_actual_cents: number;
  units: number;
  waitlist_size: number;
  closes_at: number;
  status: "open" | "drawn" | "settled";
  seed: string;
  seed_hash: string;
  frozen_hash: string | null;
  frozen_list: string | null;
  forwarder_policy: string;
  negative_test: number;
  seller_token: string;
  kind: string;
  created_at: number;
  drawn_at: number | null;
}

export type EntryStatus =
  | "awaiting_person"
  | "authorizing"
  | "held"
  | "duplicate"
  | "merged"
  | "won"
  | "waitlist"
  | "lost"
  | "captured"
  | "voided"
  | "capture_failed"
  | "expired"
  | "error";

export interface EntryRow {
  id: string;
  public_id: string;
  drop_id: string;
  source: "human" | "agent" | "simulated";
  agent_label: string | null;
  order_id: string | null;
  payer_hash: string | null;
  account_hash: string | null;
  email_hash: string | null;
  display_name: string | null;
  name: string | null;
  email: string | null;
  address_json: string | null;
  status: EntryStatus;
  authorization_id: string | null;
  hold_cents: number | null;
  capture_id: string | null;
  captured_cents: number | null;
  cluster_id: string | null;
  explanation: string | null;
  note: string | null;
  created_at: number;
  updated_at: number;
}

export interface ClusterRow {
  id: string;
  drop_id: string;
  kind: "household" | "operator";
  status: "suggested" | "confirmed" | "dismissed";
  method: "rules" | "ai";
  confidence: number;
  evidence_json: string;
  explanation: string;
  member_ids: string;
  created_at: number;
}

export function id(prefix: string, bytes = 8): string {
  return `${prefix}_${randomBytes(bytes).toString("hex")}`;
}

/** Short human-readable public id, e.g. "E-7K2Q". */
export function publicId(): string {
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  const b = randomBytes(5);
  return "E-" + [...b].map((x) => alphabet[x % alphabet.length]).join("");
}

export function hmac(value: string): string {
  return createHmac("sha256", env.HASH_SECRET).update(value).digest("hex").slice(0, 24);
}

export function getDrop(idOrSlug: string): DropRow | undefined {
  return db.prepare("SELECT * FROM drops WHERE id = ? OR slug = ?").get(idOrSlug, idOrSlug) as DropRow | undefined;
}

export function getEntry(entryId: string): EntryRow | undefined {
  return db.prepare("SELECT * FROM entries WHERE id = ?").get(entryId) as EntryRow | undefined;
}

export function getEntryByOrder(orderId: string): EntryRow | undefined {
  return db.prepare("SELECT * FROM entries WHERE order_id = ?").get(orderId) as EntryRow | undefined;
}

export function listEntries(dropId: string): EntryRow[] {
  return db.prepare("SELECT * FROM entries WHERE drop_id = ? ORDER BY created_at").all(dropId) as unknown as EntryRow[];
}

export function updateEntry(entryId: string, patch: Partial<EntryRow>): void {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  const sets = keys.map((k) => `${k} = ?`).join(", ");
  db.prepare(`UPDATE entries SET ${sets}, updated_at = ? WHERE id = ?`).run(
    ...(keys.map((k) => (patch as Record<string, unknown>)[k] ?? null) as (string | number | null)[]),
    now(),
    entryId,
  );
}

export function emit(dropId: string | null, kind: string, message: string, real: boolean, data?: unknown): void {
  db.prepare("INSERT INTO events(drop_id, ts, kind, message, real, data_json) VALUES(?, ?, ?, ?, ?, ?)").run(
    dropId,
    now(),
    kind,
    message,
    real ? 1 : 0,
    data === undefined ? null : JSON.stringify(data),
  );
}
