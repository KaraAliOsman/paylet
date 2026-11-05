// "Ask PayPal" (P1-03): re-check every real hold of a drop against PayPal's own records, so "losers are never charged"
// is stated by PayPal, not by our ledger. Public, read-only (GETs only), cached 60 s per drop, globally capped.
// Rows carry masked ids and statuses only: no names, emails or full PayPal ids.
import { fromPayPal } from "../shared/money";
import { orderBinding } from "./domain";
import { emit, listEntries, type DropRow, type EntryRow } from "./models";
import { classify, getAuthorization, getCapture } from "./paypal";
import { pendingOpsFor } from "./queue";
import { maskId } from "./trace";

export interface PaypalCheckRow {
  publicId: string;
  authorization: string;
  paypalStatus: string;
  heldCents: number;
  capturedCents: number;
  ledgerStatus: string;
  matchesLedger: boolean;
  /** PayPal's own record of the hold names this public entry id and this drop's seed commitment */
  boundToDrop: boolean;
  /** when PayPal says the hold was created (its clock, not ours) */
  paypalCreatedAt: string | null;
}
export interface PaypalCheck {
  checkedAt: number;
  rows: PaypalCheckRow[];
  totals: { captured: number; voided: number; mismatches: number; bound: number; realHolds: number };
}

export const CHECK_CACHE_MS = 60_000;
const MAX_ROWS = 40;
const MAX_FRESH_PER_MINUTE = 10; // across all drops: protects the shared sandbox app from being hammered
const cache = new Map<string, PaypalCheck>();
const inflight = new Map<string, Promise<PaypalCheck>>();
let fresh: number[] = [];

/** Which authorization (and capture) states PayPal should report for an entry in a given ledger status. */
function expected(e: EntryRow): { auth: string[]; capture?: string[] } {
  switch (e.status) {
    case "held":
    case "waitlist":
    case "won":
    case "authorizing":
      return { auth: ["CREATED", "PENDING"] };
    case "captured":
      return { auth: ["CAPTURED", "PARTIALLY_CAPTURED"], capture: ["COMPLETED"] };
    case "refunded":
      return { auth: ["CAPTURED", "PARTIALLY_CAPTURED"], capture: ["REFUNDED", "PARTIALLY_REFUNDED"] };
    default: // lost, voided, merged, capture_failed, expired, error: the hold must be gone
      return { auth: ["VOIDED", "EXPIRED"] };
  }
}

async function checkEntry(e: EntryRow, seedHash: string): Promise<PaypalCheckRow> {
  const row: PaypalCheckRow = {
    publicId: e.public_id,
    authorization: maskId(e.authorization_id) ?? "…",
    paypalStatus: "",
    heldCents: 0,
    capturedCents: 0,
    ledgerStatus: e.status,
    matchesLedger: false,
    boundToDrop: false,
    paypalCreatedAt: null,
  };
  try {
    const a = await getAuthorization(e.authorization_id!);
    row.paypalStatus = a.status;
    row.boundToDrop = a.customId === orderBinding(e.public_id, seedHash);
    row.paypalCreatedAt = a.createdAt ?? null;
    row.heldCents = fromPayPal(a.amount);
    const want = expected(e);
    let ok = want.auth.includes(a.status);
    if (want.capture && e.capture_id) {
      const c = await getCapture(e.capture_id);
      row.capturedCents = c.amountCents;
      if (c.status !== "COMPLETED") row.paypalStatus = `${a.status} · capture ${c.status}`;
      ok = ok && want.capture.includes(c.status) && (e.captured_cents == null || c.amountCents === e.captured_cents);
    } else if (want.capture) {
      ok = false; // the ledger says captured but holds no capture id
    }
    // a void/capture/refund that is queued but not sent yet: PayPal still shows the previous state, which is expected
    const queued = pendingOpsFor(e.id);
    if (!ok && queued.length && ["CREATED", "PENDING"].includes(a.status)) {
      ok = true;
      row.ledgerStatus = `${e.status} (PayPal ${queued[0]} queued)`;
    }
    row.matchesLedger = ok;
  } catch (err) {
    const f = classify(err);
    row.paypalStatus = `UNAVAILABLE (${f.status || ""} ${f.issue})`.replace("( ", "(");
    row.matchesLedger = false;
  }
  return row;
}

async function runCheck(drop: DropRow): Promise<PaypalCheck> {
  const held = listEntries(drop.id).filter((e) => e.source !== "simulated" && e.authorization_id && !e.authorization_id.startsWith("SIM-"));
  const real = held.slice(0, MAX_ROWS);
  const rows: PaypalCheckRow[] = new Array(real.length);
  let next = 0;
  // three at a time: fast enough for a judge drop, gentle on the sandbox rate limit
  await Promise.all(
    Array.from({ length: Math.min(3, real.length) }, async () => {
      while (next < real.length) {
        const i = next++;
        rows[i] = await checkEntry(real[i], drop.seed_hash);
      }
    }),
  );
  const isCaptured = (s: string) => s.startsWith("CAPTURED") || s.startsWith("PARTIALLY_CAPTURED");
  const result: PaypalCheck = {
    checkedAt: Date.now(),
    rows,
    totals: {
      captured: rows.filter((r) => isCaptured(r.paypalStatus)).length,
      voided: rows.filter((r) => r.paypalStatus === "VOIDED").length,
      mismatches: rows.filter((r) => !r.matchesLedger).length,
      bound: rows.filter((r) => r.boundToDrop).length,
      realHolds: held.length,
    },
  };
  if (rows.length) {
    emit(
      drop.id,
      "paypal_check",
      `Asked PayPal about ${rows.length} real hold${rows.length === 1 ? "" : "s"}: ${result.totals.captured} captured, ${result.totals.voided} voided, ${
        result.totals.mismatches ? `${result.totals.mismatches} not matching the ledger` : "all matching the ledger"
      }.`,
      true,
      { trace: { method: "GET", endpoint: "/v2/payments/authorizations/{id}", paypalStatus: result.totals.mismatches ? "MISMATCH" : "MATCH" } },
    );
  }
  return result;
}

/** Cached 60 s per drop; concurrent callers share one in-flight check. Throws "rate_limited" past the global cap. */
export async function paypalCheck(drop: DropRow, opts: { force?: boolean } = {}): Promise<PaypalCheck & { cached: boolean }> {
  const hit = cache.get(drop.id);
  if (hit && !opts.force && Date.now() - hit.checkedAt < CHECK_CACHE_MS) return { ...hit, cached: true };
  const running = inflight.get(drop.id);
  if (running) return { ...(await running), cached: true };
  const t = Date.now();
  fresh = fresh.filter((x) => t - x < 60_000);
  if (fresh.length >= MAX_FRESH_PER_MINUTE) {
    if (hit) return { ...hit, cached: true };
    throw Object.assign(new Error("rate_limited"), { code: "rate_limited" });
  }
  fresh.push(t);
  const p = runCheck(drop).finally(() => inflight.delete(drop.id));
  inflight.set(drop.id, p);
  const value = await p;
  cache.set(drop.id, value);
  if (cache.size > 500) cache.delete(cache.keys().next().value!);
  return { ...value, cached: false };
}

/** Test hook. */
export function _resetPaypalCheck(): void {
  cache.clear();
  inflight.clear();
  fresh = [];
}
