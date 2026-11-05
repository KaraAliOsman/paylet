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
  /** the seller grouped this entry with others and the list isn't frozen: it can still be appealed */
  grouped?: boolean;
  appealed?: boolean;
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
  outcome: { publicId: string; status: string; note?: string; simulated?: boolean }[];
  /** not in the contract; read when present (older servers send neither) */
  closesAt?: number;
  frozenAt?: number | null;
  negativeTest?: boolean;
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
    boundToDrop?: boolean;
    paypalCreatedAt?: string | null;
  }[];
  totals: { captured: number; voided: number; mismatches: number; bound?: number; realHolds?: number };
  /** the imported proof run: what PayPal answered when it was checked, not a call made now */
  recorded?: boolean;
  cached?: boolean;
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

// ---------------------------------------------------------------- seller console (GET /api/seller/:slug)

export interface Address {
  line1: string;
  line2?: string;
  city?: string;
  state?: string;
  zip?: string;
}

export interface SellerEntry {
  id: string;
  publicId: string;
  source: "human" | "agent" | "simulated" | string;
  agentLabel: string | null;
  status: EntryStatus | string;
  displayName: string | null;
  name: string | null;
  address: Address | null;
  holdCents: number | null;
  capturedCents: number | null;
  refundedCents?: number | null;
  /** masked "…7K2Q" (contract) */
  authorization?: string | null;
  /** older servers sent the full id; the UI only ever shows it masked */
  authorizationId?: string | null;
  clusterId: string | null;
  note: string | null;
  createdAt?: number;
  payerVerified?: boolean | null;
  shipping?: { carrier: string; tracking: string } | null;
}

export interface Cluster {
  id: string;
  kind: "household" | "operator";
  status: "suggested" | "confirmed" | "dismissed";
  method: "rules" | "ai";
  confidence: number;
  evidence: { field: string; detail: string }[];
  explanation: string;
  memberIds: string[];
  /** e.g. "1200 HARBOR BLVD STE 4B 43215", for the address diff */
  normalizedKey?: string | null;
  /** fans in this group who told the seller it is wrong */
  appeals?: { publicId: string; message: string }[];
}

export interface AiSummary {
  model: string;
  ranAt: number | null;
  uncertainPairs: number;
  linked: number;
  keptApartCount: number;
  keptApart: { a: string; b: string; reason: string; confidence: number }[];
  degraded: string | null;
}

export interface AiUsage {
  calls?: number;
  today: number;
  dailyCap: number;
  model: string;
  ms?: number;
}

export interface SellerData {
  drop: PublicDrop & { negativeTest: boolean };
  entries: SellerEntry[];
  clusters: Cluster[];
  /** v2: the AI review summary; older servers put the usage counters here */
  ai: AiSummary | AiUsage;
  usage?: AiUsage;
}

export const isAiSummary = (a: unknown): a is AiSummary => !!a && typeof a === "object" && "keptApart" in a;

/** Response of POST /api/seller/:slug/analyze (older servers: clusters is a count and there is no degraded/keptApart). */
export interface AnalyzeResult {
  clusters: number | unknown[];
  llmCalls?: number;
  uncertainPairs?: number;
  keptApart?: number | unknown[];
  degraded?: string | boolean | null;
  reason?: string;
  ms?: number;
}

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
  real: boolean;
}

export interface JudgeBuyer {
  label: string;
  email: string;
  password: string;
}

// ---------------------------------------------------------------- seller key: URL fragment (#k=), never the query

const keyStore = (slug: string) => `paylet.k.${slug}`;

/**
 * The seller key travels in the fragment (`/seller/<slug>#k=…`), which browsers never send to a server, and is kept in
 * sessionStorage for reloads. Older `?k=` links still work: the key is moved to the fragment and dropped from the query.
 */
export function readSellerKey(slug: string): string {
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const query = new URLSearchParams(window.location.search);
  const k = hash.get("k") ?? query.get("k");
  if (k) {
    try {
      sessionStorage.setItem(keyStore(slug), k);
    } catch {
      /* private mode: the fragment still works */
    }
    if (query.has("k")) {
      query.delete("k");
      const q = query.toString();
      window.history.replaceState(window.history.state, "", `${window.location.pathname}${q ? `?${q}` : ""}#k=${encodeURIComponent(k)}`);
    }
    return k;
  }
  try {
    const stored = sessionStorage.getItem(keyStore(slug));
    if (stored) return stored;
    // the judge page remembers its own drop (same browser)
    const judge = JSON.parse(localStorage.getItem("paylet.judge") ?? "null") as { slug?: string; sellerKey?: string } | null;
    if (judge?.slug === slug && judge.sellerKey) return judge.sellerKey;
  } catch {
    /* ignore */
  }
  return "";
}

export const sellerHref = (slug: string, key: string) => `/seller/${slug}#k=${encodeURIComponent(key)}`;

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Human copy for the error codes in the contract (P0-06). Never show a raw code or JSON to a person. */
const FRIENDLY: Record<string, string> = {
  seller_key_required: "This console link is missing its key. Open it from /judge.",
  drop_not_found: "This drop no longer exists. Start a new one at /judge.",
  entry_not_found: "That entry isn't here anymore. Nothing was charged.",
  order_id_required: "This PayPal return link is incomplete. Open your entry page instead.",
  internal_error: "Something went wrong on our side. Nothing was charged.",
  rate_limited: "Too many requests. Try again in a minute.",
  pending_reviews: "Some AI suggestions are still pending. Review them first.",
  no_eligible_entries: "Nobody in this drop has a PayPal hold yet, so there's nothing to draw.",
  holds_pending: "Some PayPal holds are still being placed. Try again in a few seconds.",
  drop_closed: "This drop is closed.",
  sim_limit: "This drop already has its simulated crowd.",
  swarm_limit: "This drop already met its scalper swarm.",
  analysis_running: "The AI review is already running. Give it a few seconds.",
  judge_drop_quota: "You already have several judge drops today. Reuse one of them.",
  paypal_error: "PayPal didn't accept the request. Nothing was charged.",
  payload_too_large: "That message is too long.",
  not_available: "This server doesn't offer that yet.",
  server_unavailable: "The demo server is waking up or restarting. Try again in a moment.",
};

/** Friendly copy for an error code (falls back to a generic line, never to the code itself). */
export function friendly(code: string): string {
  return FRIENDLY[code] ?? "Something went wrong. Nothing was charged.";
}

export function friendlyError(e: unknown): string {
  // our copy for every known code; a server message only for codes we don't know (it is already human copy)
  if (e instanceof ApiError) return FRIENDLY[e.code] ?? (e.message && e.message !== e.code && !/^HTTP \d+$/.test(e.message) ? e.message : friendly(e.code));
  if (e instanceof TypeError) return "Couldn't reach Paylet. Check your connection and try again.";
  return e instanceof Error ? e.message : String(e);
}

/** One technical line for a <details> under a friendly message ("HTTP 409 · pending_reviews · 2 AI suggestion(s) not reviewed"). */
export function errorDetails(e: unknown): string {
  if (e instanceof ApiError) return [`HTTP ${e.status}`, e.code, e.message !== e.code && e.message !== FRIENDLY[e.code] ? e.message : ""].filter(Boolean).join(" · ");
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
