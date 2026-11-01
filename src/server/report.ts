// Public, PII-free numbers: the Drop report (P1-07) and the landing page counters (/api/stats).
import { db } from "./db";
import { listEntries, type DropRow, type EntryRow } from "./models";

export interface DropReport {
  units: number;
  unitsToDistinctPayers: number;
  capturedCents: number;
  shippingReleasedCents: number;
  holdsVoided: number;
  chargedToLosersCents: number;
  failedPayments: number;
  waitlistRecoverySeconds: number | null;
  agentRequests: number;
  agentHoldsWithoutPerson: number;
  networkAccounts: number;
  networkTickets: number;
  sameAccountDuplicates: number;
  payerVerified: number;
  /** any real PayPal money (a real hold) in this drop */
  real: boolean;
  /** simulated entrants included in the numbers above (0 = every number is real PayPal sandbox money) */
  simulatedEntrants: number;
}

const PAID = new Set(["captured", "refunded"]);
/** an entry whose hold was released without a charge (or is being released: `lost` while its void is queued) */
const RELEASED = new Set(["voided", "lost", "merged", "capture_failed"]);

/** Computed from the ledger, never hard-coded: `chargedToLosersCents` and `agentHoldsWithoutPerson` must come out 0. */
export function dropReport(d: DropRow): DropReport {
  const entries = listEntries(d.id);
  const paid = entries.filter((e) => PAID.has(e.status));
  const hadHold = (e: EntryRow) => e.hold_cents != null && e.status !== "duplicate";
  const promoted = paid.filter((e) => e.promoted_at != null && e.settled_at != null);
  const operator = db.prepare("SELECT member_ids FROM clusters WHERE drop_id = ? AND status = 'confirmed' AND kind = 'operator'").all(d.id) as { member_ids: string }[];
  return {
    units: d.units,
    unitsToDistinctPayers: new Set(paid.map((e) => e.payer_hash ?? e.id)).size,
    capturedCents: paid.reduce((s, e) => s + (e.captured_cents ?? 0) - (e.refunded_cents ?? 0), 0),
    shippingReleasedCents: paid.reduce((s, e) => s + Math.max(0, (e.hold_cents ?? 0) - (e.captured_cents ?? 0)), 0),
    holdsVoided: entries.filter((e) => hadHold(e) && RELEASED.has(e.status)).length,
    // anyone who did not end up with the item, but was charged: must be 0
    chargedToLosersCents: entries.filter((e) => !PAID.has(e.status) && e.status !== "won").reduce((s, e) => s + (e.captured_cents ?? 0), 0),
    failedPayments: entries.filter((e) => e.status === "capture_failed").length,
    waitlistRecoverySeconds: promoted.length ? Math.max(0, Math.round((promoted[0].settled_at! - promoted[0].promoted_at!) / 1000)) : null,
    agentRequests: entries.filter((e) => e.source === "agent").length,
    // a hold on an agent's entry that no person approved in PayPal: must be 0
    agentHoldsWithoutPerson: entries.filter((e) => e.source === "agent" && hadHold(e) && e.approved_at == null).length,
    networkAccounts: operator.reduce((s, c) => s + (JSON.parse(c.member_ids) as string[]).length, 0),
    networkTickets: operator.length,
    sameAccountDuplicates: entries.filter((e) => e.status === "duplicate").length,
    payerVerified: entries.filter((e) => e.payer_verified === 1).length,
    real: entries.some((e) => e.source !== "simulated" && e.hold_cents != null),
    simulatedEntrants: entries.filter((e) => e.source === "simulated").length,
  };
}

export interface GlobalStats {
  holds: number;
  duplicatesBlocked: number;
  agentRequests: number;
  capturedCents: number;
  voidedHolds: number;
  chargedToLosersCents: number;
  drops: number;
}

let cache: { at: number; value: GlobalStats } | null = null;

/** Landing page counters. Real PayPal sandbox activity only (simulated entrants never count). Cached 5 s. */
export function globalStats(): GlobalStats {
  if (cache && Date.now() - cache.at < 5_000) return cache.value;
  const one = (sql: string) => (db.prepare(sql).get() as { n: number | null }).n ?? 0;
  const real = "source <> 'simulated'";
  const value: GlobalStats = {
    holds: one(`SELECT COUNT(*) n FROM entries WHERE ${real} AND hold_cents IS NOT NULL AND status <> 'duplicate'`),
    duplicatesBlocked: one(`SELECT COUNT(*) n FROM entries WHERE ${real} AND status = 'duplicate'`),
    agentRequests: one("SELECT COUNT(*) n FROM entries WHERE source = 'agent'"),
    capturedCents: one(`SELECT COALESCE(SUM(COALESCE(captured_cents, 0) - COALESCE(refunded_cents, 0)), 0) n FROM entries WHERE ${real} AND status IN ('captured','refunded')`),
    voidedHolds: one(`SELECT COUNT(*) n FROM entries WHERE ${real} AND hold_cents IS NOT NULL AND status IN ('voided','lost','merged','capture_failed')`),
    chargedToLosersCents: one(`SELECT COALESCE(SUM(captured_cents), 0) n FROM entries WHERE ${real} AND status NOT IN ('captured','refunded','won')`),
    drops: one("SELECT COUNT(*) n FROM drops"),
  };
  cache = { at: Date.now(), value };
  return value;
}

/** Test hook. */
export function _resetStatsCache(): void {
  cache = null;
}
