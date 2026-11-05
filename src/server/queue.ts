// Persistent, throttled queue for every money-moving PayPal call.
// - The op key doubles as the PayPal-Request-Id, so a retry after a crash can never double-charge.
// - Throttled with a token bucket (the sandbox rate-limits aggressively).
// - Retries only RETRYABLE failures (429 / 5xx / network) with exponential backoff (or PayPal's Retry-After).
// - Handlers write each call's PayPal trace (endpoint, status, debug_id, ms, masked request id) to the ledger;
//   a terminal failure reaches onTerminal with the failed call's trace on `failure.trace`.
import { db, now } from "./db";
import { classify, type PayPalFailure } from "./paypal";

export type OpKind = "authorize" | "capture" | "void" | "track" | "refund";

export interface OpRow {
  key: string;
  kind: OpKind;
  entry_id: string;
  payload: string;
  status: "pending" | "done" | "failed";
  attempts: number;
  next_at: number;
  last_error: string | null;
}

export function enqueue(kind: OpKind, key: string, entryId: string, payload: Record<string, unknown> = {}): void {
  db.prepare(
    "INSERT INTO ops(key, kind, entry_id, payload, status, attempts, next_at, created_at, updated_at) VALUES(?, ?, ?, ?, 'pending', 0, ?, ?, ?) ON CONFLICT(key) DO NOTHING",
  ).run(key, kind, entryId, JSON.stringify(payload), now(), now(), now());
}

export interface Handlers {
  run(op: OpRow): Promise<void>;
  /** Returning `rearmMs` keeps the op alive: the same key (same PayPal-Request-Id) runs again after that long. */
  onTerminal(op: OpRow, failure: PayPalFailure): void | { rearmMs: number } | Promise<void | { rearmMs: number }>;
}

const PER_MINUTE = Number(process.env.PAYPAL_OPS_PER_MINUTE ?? 40);
let tokens = PER_MINUTE;
let lastRefill = Date.now();
function takeToken(): boolean {
  const t = Date.now();
  tokens = Math.min(PER_MINUTE, tokens + ((t - lastRefill) / 60_000) * PER_MINUTE);
  lastRefill = t;
  if (tokens >= 1) {
    tokens -= 1;
    return true;
  }
  return false;
}

let running = false;

export async function tick(h: Handlers): Promise<boolean> {
  if (running) return false;
  const op = db.prepare("SELECT * FROM ops WHERE status = 'pending' AND next_at <= ? ORDER BY created_at LIMIT 1").get(now()) as OpRow | undefined;
  if (!op) return false;
  if (!takeToken()) return false;
  running = true;
  db.prepare("UPDATE ops SET attempts = attempts + 1, updated_at = ? WHERE key = ?").run(now(), op.key);
  try {
    // hard deadline per op so one hung call can never stall the whole queue
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        h.run(op),
        new Promise((_, rej) => {
          timer = setTimeout(() => rej(Object.assign(new Error("op deadline exceeded"), { name: "TimeoutError" })), 90_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    db.prepare("UPDATE ops SET status = 'done', last_error = NULL, updated_at = ? WHERE key = ?").run(now(), op.key);
  } catch (e) {
    const f = classify(e);
    const attempts = op.attempts + 1;
    const retry = (f.cls === "RETRYABLE" || f.cls === "WAIT") && attempts < 8;
    if (retry) {
      const backoff = f.retryAfterMs ?? (f.status === 429 ? 60_000 : Math.min(60_000, 1000 * 2 ** attempts));
      db.prepare("UPDATE ops SET next_at = ?, last_error = ?, updated_at = ? WHERE key = ?").run(now() + backoff, `${f.status} ${f.issue} debug=${f.debugId ?? "-"}`, now(), op.key);
    } else {
      const error = `${f.status} ${f.issue}: ${f.description} debug=${f.debugId ?? "-"}`.slice(0, 500);
      // The op stays `pending` until its terminal handler finished, so a crash in between replays it instead of leaving
      // a winner in `won` (or an entry in `authorizing`) forever.
      try {
        const next = await h.onTerminal(op, f);
        if (next?.rearmMs) db.prepare("UPDATE ops SET attempts = 0, next_at = ?, last_error = ?, updated_at = ? WHERE key = ?").run(now() + next.rearmMs, error, now(), op.key);
        else db.prepare("UPDATE ops SET status = 'failed', last_error = ?, updated_at = ? WHERE key = ?").run(error, now(), op.key);
      } catch (err) {
        console.error("onTerminal failed", err);
        db.prepare("UPDATE ops SET next_at = ?, last_error = ?, updated_at = ? WHERE key = ?").run(now() + 60_000, error, now(), op.key);
      }
    }
  } finally {
    running = false;
  }
  return true;
}

export function startWorker(h: Handlers): () => void {
  const timer = setInterval(() => {
    void tick(h);
  }, 400);
  return () => clearInterval(timer);
}

export function pendingOps(): number {
  return (db.prepare("SELECT COUNT(*) n FROM ops WHERE status = 'pending'").get() as { n: number }).n;
}

/** Pending ops for one entry (a ledger/PayPal mismatch while one is queued is "in flight", not an error). */
export function pendingOpsFor(entryId: string): OpKind[] {
  return (db.prepare("SELECT kind FROM ops WHERE entry_id = ? AND status = 'pending'").all(entryId) as { kind: OpKind }[]).map((r) => r.kind);
}

/** Number of ops of one kind ever created for an entry (used to mint a fresh PayPal-Request-Id for a new attempt). */
export function opCount(entryId: string, kind: OpKind): number {
  return (db.prepare("SELECT COUNT(*) n FROM ops WHERE entry_id = ? AND kind = ?").get(entryId, kind) as { n: number }).n;
}
