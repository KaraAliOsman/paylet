// PayPal webhooks. Order of operations (cheapest first, nothing trusted before PayPal vouches for it):
//   1. structural checks (P2-14): the five paypal-* transmission headers are present, the signing certificate is served
//      from https://*.paypal.com, the transmission time is within ±5 minutes, and the body is a JSON event;
//   2. PayPal's own signature verification (POST /v1/notifications/verify-webhook-signature, raw body byte for byte);
//   3. de-duplication by event id (PayPal redelivers);
//   4. state transitions in the domain (P1-05: routeWebhook), each guarded by the entry's current status.
// A verified event that matches an entry writes one ledger line with its trace (P1-01).
import { db, getSetting, now } from "./db";
import { routeWebhook, type WebhookEvent } from "./domain";
import { env } from "./env";
import { emit } from "./models";
import { verifyWebhookSignature } from "./paypal";
import { maskId, type Trace } from "./trace";

export const REQUIRED_HEADERS = ["paypal-transmission-id", "paypal-transmission-time", "paypal-transmission-sig", "paypal-cert-url", "paypal-auth-algo"] as const;
export const MAX_CLOCK_SKEW_MS = 5 * 60_000;

/** Rejection code for a request that must not even reach PayPal's verification endpoint, or null if it may. */
export function precheckWebhook(headers: Headers, raw: string, nowMs = Date.now()): string | null {
  for (const h of REQUIRED_HEADERS) if (!headers.get(h)) return "missing_paypal_headers";
  let cert: URL;
  try {
    cert = new URL(headers.get("paypal-cert-url")!);
  } catch {
    return "bad_cert_url";
  }
  if (cert.protocol !== "https:" || !(cert.hostname === "paypal.com" || cert.hostname.endsWith(".paypal.com"))) return "bad_cert_url";
  const sent = Date.parse(headers.get("paypal-transmission-time")!);
  if (!Number.isFinite(sent) || Math.abs(nowMs - sent) > MAX_CLOCK_SKEW_MS) return "stale_transmission";
  let evt: unknown;
  try {
    evt = JSON.parse(raw);
  } catch {
    return "bad_json";
  }
  const e = evt as WebhookEvent | null;
  if (!e || typeof e !== "object" || typeof e.id !== "string" || !e.id || typeof e.event_type !== "string" || !e.event_type) return "bad_event";
  return null;
}

export async function handlePayPalWebhook(headers: Headers, raw: string): Promise<{ status: 200 | 400 | 401 | 500; body: Record<string, unknown> }> {
  const bad = precheckWebhook(headers, raw);
  if (bad) {
    console.warn("[webhook] rejected before verification:", bad);
    return { status: 400, body: { error: bad } };
  }
  const evt = JSON.parse(raw) as WebhookEvent & { id: string; event_type: string };
  const webhookId = env.PAYPAL_WEBHOOK_ID || getSetting("webhook_id") || "";
  const v = await verifyWebhookSignature(headers, raw, webhookId).catch(() => undefined);
  if (!v?.verified) {
    console.warn("[webhook] rejected unverified event", evt.event_type);
    return { status: 401, body: { error: "signature_verification_failed" } };
  }
  const resourceId = typeof evt.resource?.id === "string" ? evt.resource.id : null;
  const inserted = db
    .prepare("INSERT INTO webhook_events(event_id, type, resource_id, verified, received_at) VALUES(?, ?, ?, 1, ?) ON CONFLICT(event_id) DO NOTHING")
    .run(evt.id, evt.event_type, resourceId, now());
  if (inserted.changes === 0) return { status: 200, body: { ok: true, duplicate: true } };

  let routed: Awaited<ReturnType<typeof routeWebhook>>;
  try {
    routed = await routeWebhook(evt);
  } catch (e) {
    // forget the event so PayPal's redelivery is processed instead of being dropped as a duplicate
    db.prepare("DELETE FROM webhook_events WHERE event_id = ?").run(evt.id);
    console.error("[webhook] routing failed", evt.event_type, String(e).slice(0, 160));
    return { status: 500, body: { error: "internal_error" } };
  }
  if (routed.entry) {
    const trace: Trace = {
      method: "POST",
      endpoint: "/v1/notifications/verify-webhook-signature",
      httpStatus: v.httpStatus,
      paypalStatus: "SUCCESS",
      debugId: v.debugId,
      ms: v.ms,
      event: evt.event_type,
      id: maskId(evt.id),
      verified: true,
    };
    emit(routed.entry.drop_id, "webhook", `Webhook ${evt.event_type} (signature verified) → ${routed.entry.public_id} ${routed.outcome}.`, true, { trace });
  }
  return { status: 200, body: { ok: true } };
}
