// Shapes follow research/CONTRACT.md. Fields that the backend adds over time are optional here so the UI keeps
// working against older servers (and degrades to empty states when an endpoint does not exist yet).

export type DropStatus = "open" | "frozen" | "drawn" | "settled";

export interface Randomness {
  source: "drand-quicknet";
  round: number;
  value: string | null;
  chainHash: string;
  url: string;
}

export interface DropStats {
  realOrders?: number;
  /** legacy name of realOrders */
  requests?: number;
  awaitingPerson: number;
  holds: number;
  duplicatesBlocked: number;
  agents: number;
  captured: number;
  capturedCents?: number;
  shippingReleasedCents?: number;
  voided?: number;
  refunded?: number;
  failedPayments?: number;
  merged: number;
  simulated: number;
  capturedSimulated?: number;
}

export interface PublicDrop {
  id: string;
  slug: string;
  title: string;
  maker: string;
  blurb: string;
  art: string;
  priceCents: number;
  shipHoldCents: number;
  shipActualCents: number;
  units: number;
  closesAt: number;
  status: DropStatus;
  kind: string;
  seedHash: string;
  seed: string | null;
  frozenHash: string | null;
  frozenList?: string[] | null;
  waitlistSize: number;
  randomness?: Randomness | null;
  finalSeed?: string | null;
  pendingReviews?: number;
  negativeTest?: boolean;
  stats: DropStats;
}

export const realOrders = (s: DropStats) => s.realOrders ?? s.requests ?? 0;

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
  | "error"
  | "refunded";

export interface EntryTimeline {
  requestedAt: number;
  approvedAt: number | null;
  heldAt: number | null;
  drawAt: number | null;
  settledAt: number | null;
}

export interface Participant {
  entryId: string;
  publicId: string;
  source: string;
  agentLabel: string | null;
  status: EntryStatus | string;
  holdCents: number | null;
  capturedCents: number | null;
  refundedCents?: number | null;
  note: string | null;
  explanation: string | null;
  approveUrl?: string | null;
  payerVerified?: boolean | null;
  shipping?: { carrier: string; tracking: string } | null;
  timeline?: EntryTimeline;
  drop: { slug: string; title: string; maker: string; status: string; closesAt: number; units: number; art: string };
}

export interface EventTrace {
  method: string;
  endpoint: string;
  httpStatus?: number;
  paypalStatus?: string;
  id?: string;
  requestId?: string;
  debugId?: string;
  ms?: number;
  event?: string;
  verified?: boolean;
}

export interface EventRow {
  id: number;
  ts: number;
  kind: string;
  message: string;
  real: number;
  trace?: EventTrace;
}

export interface VerifyData {
  title: string;
  status: string;
  units: number;
  waitlistSize: number;
  seedHash: string;
  seed: string | null;
  frozenHash: string | null;
  frozenList: string[] | null;
  randomness?: Randomness | null;
  finalSeed?: string | null;
  excluded?: { publicId: string; reason: "merged" | "duplicate" | string }[];
  outcome: { publicId: string; status: string; note?: string }[];
  /** not in the contract; read when present (older servers send neither) */
  closesAt?: number;
}

export interface PaypalCheck {
  checkedAt: number;
  rows: {
    publicId: string;
    authorization: string;
    paypalStatus: string;
    heldCents: number;
    capturedCents: number;
    ledgerStatus: string;
    matchesLedger: boolean;
  }[];
  totals: { captured: number; voided: number; mismatches: number };
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

export interface ProofInfo {
  slug: string | null;
  summary: string | null;
  checkedAt: number | null;
}

export interface AgentHandoff {
  entryRef: string;
  publicId: string;
  title: string;
  holdCents: number;
  approveUrl: string;
  expiresAt: number;
}

export interface AgentTraceItem {
  tool: string;
  summary: string;
  raw: unknown;
}

export interface AgentChatResponse {
  reply: string;
  trace: AgentTraceItem[];
  handoff: AgentHandoff | null;
  error?: true;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Human copy for the error codes in the contract. */
const FRIENDLY: Record<string, string> = {
  seller_key_required: "This seller console needs its private link.",
  drop_not_found: "That drop isn't here anymore.",
  entry_not_found: "That entry isn't here anymore.",
  order_id_required: "Something went wrong confirming your entry. Nothing was charged.",
  internal_error: "Something went wrong on our side. Nothing was charged.",
  rate_limited: "Too many requests in a minute. Wait a moment and try again.",
  pending_reviews: "Review the pending AI suggestions before drawing.",
  no_eligible_entries: "No eligible entries to draw yet.",
  holds_pending: "Some PayPal holds are still being placed. Try again in a few seconds.",
  drop_closed: "This drop is closed.",
  sim_limit: "This drop already has its simulated crowd.",
  swarm_limit: "This drop already met its scalper swarm.",
  analysis_running: "The AI review is already running.",
  judge_drop_quota: "You already have several judge drops today. Reuse one of them.",
  paypal_error: "PayPal didn't accept the request.",
  not_available: "This server doesn't offer that yet.",
  server_unavailable: "The demo server is waking up or restarting. Try again in a moment.",
};

export function friendlyError(e: unknown): string {
  // a specific message from the server wins (e.g. "3 AI suggestions are waiting for your decision"); bare codes get our copy
  if (e instanceof ApiError) return e.message && e.message !== e.code ? e.message : (FRIENDLY[e.code] ?? e.message);
  return e instanceof Error ? e.message : String(e);
}

export async function api<T>(path: string, init?: RequestInit & { json?: unknown; sellerKey?: string }): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json", ...(init?.headers as Record<string, string>) };
  if (init?.json !== undefined) headers["content-type"] = "application/json";
  if (init?.sellerKey) headers["x-seller-key"] = init.sellerKey;
  const res = await fetch(path, { ...init, headers, body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body });
  const text = await res.text();
  let data: Record<string, unknown> = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      // An endpoint this server doesn't have yet answers with the SPA's index.html (GET) or a plain 404/405 (POST).
      if (res.ok || res.status === 404 || res.status === 405) throw new ApiError(404, "not_available", FRIENDLY.not_available);
      // anything else that isn't JSON comes from the hosting proxy (cold start, restart)
      throw new ApiError(res.status, "server_unavailable", FRIENDLY.server_unavailable);
    }
  }
  if (!res.ok) {
    const code = typeof data.error === "string" ? data.error : "error";
    throw new ApiError(res.status, code, typeof data.message === "string" ? data.message : (FRIENDLY[code] ?? `HTTP ${res.status}`));
  }
  return data as T;
}

/** Like api(), but resolves to null when the endpoint (or the resource) does not exist. */
export async function apiOptional<T>(path: string): Promise<T | null> {
  try {
    return await api<T>(path);
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.code === "not_available")) return null;
    throw e;
  }
}

export const usd = (c: number | null | undefined) => (c == null ? "—" : `$${(c / 100).toFixed(2)}`);

/** "$48" for whole dollars, "$44.50" otherwise. */
export const usdShort = (c: number | null | undefined) => (c == null ? "—" : c % 100 === 0 ? `$${c / 100}` : usd(c));

export function timeLeft(ms: number): string {
  if (ms <= 0) return "closed";
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m ${Math.floor((ms % 60000) / 1000)}s`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** "6:30 PM", or "Fri 6:30 PM" when it is not today. */
export function clock(ts: number, withSeconds = false): string {
  const d = new Date(ts);
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", ...(withSeconds ? { second: "2-digit" } : {}) });
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return time;
  return `${d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })} ${time}`;
}

export const nf = (n: number) => n.toLocaleString("en-US");
