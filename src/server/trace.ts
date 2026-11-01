// PayPal API trace for the public ledger (P1-01).
// Every PayPal call records method, endpoint, HTTP status, PayPal status, debug_id and latency. IDs are always
// masked to their last 4 characters ("…7K2Q") before they are stored, so neither the ledger nor the database
// event log ever exposes a full PayPal order/authorization/capture id, an internal entry id, or any PII.

export interface Trace {
  method: string;
  endpoint: string;
  httpStatus?: number;
  paypalStatus?: string;
  /** masked PayPal resource id */
  id?: string;
  /** masked PayPal-Request-Id (idempotency key) */
  requestId?: string;
  debugId?: string;
  ms?: number;
  /** webhook event type */
  event?: string;
  verified?: boolean;
}

/** "5TY05013RG002845M" → "…845M". Short or empty values are returned masked as a whole. */
export function maskId(id: string | null | undefined): string | undefined {
  if (!id) return undefined;
  const s = String(id);
  return s.length <= 4 ? "…" : `…${s.slice(-4)}`;
}

/** Masks every long segment of an idempotency key: "cap:5TY05013RG002845M:1" → "cap:…845M:1". */
export function maskKey(key: string | null | undefined): string | undefined {
  if (!key) return undefined;
  return key
    .split(":")
    .map((seg) => (seg.length > 8 ? maskId(seg)! : seg))
    .join(":");
}

const STRING_FIELDS = ["method", "endpoint", "paypalStatus", "id", "requestId", "debugId", "event"] as const;

/** Whitelist filter for anything read back from events.data_json: only known trace fields, only safe types. */
export function publicTrace(raw: unknown): Trace | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const t = raw as Record<string, unknown>;
  if (typeof t.method !== "string" || typeof t.endpoint !== "string") return undefined;
  const out: Record<string, unknown> = {};
  for (const k of STRING_FIELDS) if (typeof t[k] === "string") out[k] = (t[k] as string).slice(0, 160);
  // defence in depth: ids must already be masked; drop anything that is not
  for (const k of ["id", "requestId"] as const) if (typeof out[k] === "string" && !(out[k] as string).includes("…")) delete out[k];
  if (typeof t.httpStatus === "number" && Number.isFinite(t.httpStatus)) out.httpStatus = t.httpStatus;
  if (typeof t.ms === "number" && Number.isFinite(t.ms)) out.ms = Math.round(t.ms);
  if (typeof t.verified === "boolean") out.verified = t.verified;
  return out as unknown as Trace;
}

/** Reads `trace` out of an events.data_json string. */
export function traceFromData(dataJson: string | null | undefined): Trace | undefined {
  if (!dataJson) return undefined;
  try {
    return publicTrace((JSON.parse(dataJson) as { trace?: unknown }).trace);
  } catch {
    return undefined;
  }
}

/** `tone` stored with an event ("warn" for degraded paths: a rate-limited swarm, drand unreachable, unreviewed AI
 *  suggestions at the draw), exposed in the public ledger next to the trace. */
export function toneOf(dataJson: string | null | undefined): "warn" | undefined {
  if (!dataJson) return undefined;
  try {
    return (JSON.parse(dataJson) as { tone?: unknown }).tone === "warn" ? "warn" : undefined;
  } catch {
    return undefined;
  }
}
