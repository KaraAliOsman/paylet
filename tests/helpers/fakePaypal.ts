// A small stateful stand-in for PayPal's sandbox, used by the backend tests through
//   vi.mock("../src/server/paypal", async (orig) => ({ ...(await orig()), ...(await import("./helpers/fakePaypal")).fakeApi }))
// It keeps orders, authorizations, captures, refunds and trackers, returns traces like the real layer, and fails by
// throwing REAL SDK ApiError objects, so the real classify() and the real queue/backoff code paths are exercised.
import { ApiError } from "@paypal/paypal-server-sdk";
import { maskId, maskKey, type Trace } from "../../src/server/trace";

type Fail = Error | "PENDING" | "DECLINED";

export const pp = {
  seq: 0,
  calls: [] as string[],
  orders: new Map<string, { payer?: string; status: string; accountStatus?: string; binding?: string }>(),
  auths: new Map<string, { status: string; cents: number; order: string; customId?: string }>(),
  captures: new Map<string, { status: string; cents: number; auth: string; order: string }>(),
  refunds: new Map<string, { capture: string; cents: number; key: string }>(),
  trackers: new Map<string, string[]>(), // orderId → tracker ids
  /** one-shot failures per operation: authorize | capture | void | refund | track | getOrder | getCapture */
  fail: new Map<string, Fail[]>(),
  verify: false,
  verifyCalls: [] as { raw: string; webhookId: string }[],
  /** the fan approves an order in PayPal as `payer` */
  approve(orderId: string, payer: string, accountStatus = "VERIFIED") {
    const o = pp.orders.get(orderId)!;
    o.payer = payer;
    o.status = "APPROVED";
    o.accountStatus = accountStatus;
  },
  failNext(op: string, f: Fail) {
    pp.fail.set(op, [...(pp.fail.get(op) ?? []), f]);
  },
};

const id = (prefix: string) => `${prefix}${String(++pp.seq).padStart(4, "0")}X7K2Q${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
const takeFail = (op: string) => pp.fail.get(op)?.shift();
const tr = (method: string, endpoint: string, httpStatus: number, paypalStatus?: string, rid?: string, requestId?: string): Trace => ({
  method,
  endpoint,
  httpStatus,
  paypalStatus,
  id: maskId(rid),
  requestId: maskKey(requestId),
  debugId: "f00dfeed01",
  ms: 7,
});

/** A real SDK ApiError, as PayPal would return it. */
export function apiError(status: number, issue: string, opts: { retryAfter?: number; debugId?: string } = {}): ApiError {
  const body = JSON.stringify({
    name: status === 422 ? "UNPROCESSABLE_ENTITY" : status === 429 ? "RATE_LIMIT_REACHED" : "ERROR",
    message: issue,
    debug_id: opts.debugId ?? "8f3a2b1c0d",
    details: [{ issue, description: `${issue.toLowerCase().replace(/_/g, " ")}` }],
  });
  const headers: Record<string, string> = { "paypal-debug-id": opts.debugId ?? "8f3a2b1c0d" };
  if (opts.retryAfter) headers["retry-after"] = String(opts.retryAfter);
  return new ApiError({ request: { method: "POST", url: "https://api-m.sandbox.paypal.com/test" }, response: { statusCode: status, headers, body } } as never, `HTTP ${status}`);
}

/** Like the real traced(): the failed call's trace rides on the error (status, PayPal issue, debug_id). */
function throwWithTrace(e: Error, trace: Trace): never {
  let issue: string | undefined;
  try {
    issue = (JSON.parse(String((e as { body?: unknown }).body)) as { details?: { issue?: string }[] }).details?.[0]?.issue;
  } catch {
    /* not an ApiError body */
  }
  (e as Error & { paypalTrace?: Trace }).paypalTrace = { ...trace, httpStatus: (e as { statusCode?: number }).statusCode, paypalStatus: issue, debugId: "8f3a2b1c0d" };
  throw e;
}

export const fakeApi = {
  async createHoldOrder(i: { entryId: string; priceCents: number; shipHoldCents: number; binding?: string }) {
    const orderId = id("ORD");
    pp.orders.set(orderId, { status: "PAYER_ACTION_REQUIRED", binding: i.binding });
    pp.calls.push(`create ${orderId}`);
    return { orderId, approveUrl: `https://www.sandbox.paypal.com/checkoutnow?token=${orderId}`, trace: tr("POST", "/v2/checkout/orders", 200, "PAYER_ACTION_REQUIRED", orderId, `create:${i.entryId}`) };
  },
  async getOrderIdentity(orderId: string) {
    const f = takeFail("getOrder");
    if (f instanceof Error) throw f;
    const o = pp.orders.get(orderId);
    if (!o) throw apiError(404, "RESOURCE_NOT_FOUND");
    const p = o.payer;
    return {
      status: o.status,
      payerId: p,
      accountId: p,
      accountStatus: o.accountStatus,
      email: p ? `${p.toLowerCase()}@example.com` : undefined,
      name: p ? `Fan ${p}` : undefined,
      address: p ? { line1: `${p.length * 11} Test St`, zip: "97205", city: "Portland", state: "OR", country: "US" } : undefined,
      trace: tr("GET", `/v2/checkout/orders/${maskId(orderId)}`, 200, o.status, orderId),
    };
  },
  async authorizeOrder(orderId: string, requestId: string) {
    pp.calls.push(`authorize ${orderId} key=${requestId}`);
    const trace = tr("POST", `/v2/checkout/orders/${maskId(orderId)}/authorize`, 201, "CREATED", orderId, requestId);
    const f = takeFail("authorize");
    if (f instanceof Error) throwWithTrace(f, trace);
    const authorizationId = id("AUTH");
    pp.auths.set(authorizationId, { status: "CREATED", cents: 4800, order: orderId, customId: pp.orders.get(orderId)?.binding });
    return { authorizationId, status: "CREATED", amount: "48.00", trace: { ...trace, id: maskId(authorizationId) } };
  },
  async getAuthorization(authorizationId: string) {
    const a = pp.auths.get(authorizationId);
    if (!a) throw apiError(404, "INVALID_RESOURCE_ID");
    return { status: a.status, amount: (a.cents / 100).toFixed(2), customId: a.customId, createdAt: "2026-11-04T20:00:00Z", trace: tr("GET", `/v2/payments/authorizations/${maskId(authorizationId)}`, 200, a.status, authorizationId) };
  },
  async findAuthorization(orderId: string) {
    for (const [id, a] of pp.auths) if (a.order === orderId) return id;
    return null;
  },
  async findCapture(orderId: string) {
    for (const [captureId, c] of pp.captures) if (pp.auths.get(c.auth)?.order === orderId) return { captureId, amountCents: c.cents };
    return null;
  },
  async captureAuthorization(authorizationId: string, cents: number, requestId: string, _invoice: string, opts: { mock?: string } = {}) {
    pp.calls.push(`capture ${authorizationId}${opts.mock ? ` mock=${opts.mock}` : ""} key=${requestId}`);
    const trace = tr("POST", `/v2/payments/authorizations/${maskId(authorizationId)}/capture`, 201, "COMPLETED", authorizationId, requestId);
    if (opts.mock) throwWithTrace(apiError(422, opts.mock), trace); // PayPal-Mock-Response: the hold stays CREATED
    const a = pp.auths.get(authorizationId)!;
    if (a.status === "VOIDED") throwWithTrace(apiError(422, "AUTHORIZATION_VOIDED"), trace);
    const f = takeFail("capture");
    if (f instanceof Error) throwWithTrace(f, trace);
    const captureId = id("CAP");
    const status = f === "PENDING" ? "PENDING" : "COMPLETED";
    pp.captures.set(captureId, { status, cents, auth: authorizationId, order: a.order });
    a.status = "CAPTURED";
    return { captureId, status, amount: (cents / 100).toFixed(2), trace: { ...trace, id: maskId(captureId), paypalStatus: status } };
  },
  async getCapture(captureId: string) {
    const f = takeFail("getCapture");
    if (f instanceof Error) throw f;
    const c = pp.captures.get(captureId);
    if (!c) throw apiError(404, "INVALID_RESOURCE_ID");
    return { status: c.status, amountCents: c.cents, trace: tr("GET", `/v2/payments/captures/${maskId(captureId)}`, 200, c.status, captureId) };
  },
  async refundCapture(captureId: string, requestId: string) {
    pp.calls.push(`refund ${captureId} key=${requestId}`);
    const trace = tr("POST", `/v2/payments/captures/${maskId(captureId)}/refund`, 201, "COMPLETED", captureId, requestId);
    const f = takeFail("refund");
    if (f instanceof Error) throwWithTrace(f, trace);
    const c = pp.captures.get(captureId)!;
    const existing = [...pp.refunds.entries()].find(([, r]) => r.key === requestId);
    if (existing) return { refundId: existing[0], status: "COMPLETED", amountCents: existing[1].cents, trace: { ...trace, httpStatus: 200 } };
    const refundId = id("REF");
    pp.refunds.set(refundId, { capture: captureId, cents: c.cents, key: requestId });
    c.status = "REFUNDED";
    return { refundId, status: "COMPLETED", amountCents: c.cents, trace: { ...trace, id: maskId(refundId) } };
  },
  async addTracking(orderId: string, captureId: string, tracking: string, carrier: string) {
    pp.calls.push(`track ${orderId} ${carrier} ${tracking}`);
    const trace = tr("POST", `/v2/checkout/orders/${maskId(orderId)}/track`, 201, "SHIPPED", captureId, `track:${captureId}`);
    const f = takeFail("track");
    if (f instanceof Error) throwWithTrace(f, trace);
    const trackerId = `${captureId}-${tracking}`;
    const list = pp.trackers.get(orderId) ?? [];
    if (list.includes(trackerId)) return { trackerId, already: true, trace: { ...trace, paypalStatus: "ALREADY_TRACKED" } };
    pp.trackers.set(orderId, [...list, trackerId]);
    return { trackerId, already: false, trace };
  },
  async voidAuthorizationSafe(authorizationId: string, requestId: string) {
    pp.calls.push(`void ${authorizationId} key=${requestId}`);
    const a = pp.auths.get(authorizationId);
    const trace = tr("POST", `/v2/payments/authorizations/${maskId(authorizationId)}/void`, 204, "VOIDED", authorizationId, requestId);
    const f = takeFail("void");
    if (f instanceof Error) throwWithTrace(f, trace);
    if (!a) throw apiError(404, "INVALID_RESOURCE_ID");
    if (a.status === "VOIDED") return { status: "VOIDED", already: true, trace };
    if (a.status === "CAPTURED") return { status: "CAPTURED", already: true, trace };
    a.status = "VOIDED";
    return { status: "VOIDED", trace };
  },
  async verifyWebhookSignature(_headers: Headers, raw: string, webhookId: string) {
    pp.verifyCalls.push({ raw, webhookId });
    return { verified: pp.verify, httpStatus: 200, debugId: "wh0debug", ms: 3 };
  },
  async ensureWebhook() {
    return { id: "", patched: [] as string[] };
  },
};

/** Valid PayPal transmission headers (the signature itself is checked by the mocked verify call). */
export function webhookHeaders(over: Record<string, string> = {}): Headers {
  return new Headers({
    "content-type": "application/json",
    "paypal-transmission-id": "f1e2d3c4-0000-1111-2222-333344445555",
    "paypal-transmission-time": new Date().toISOString(),
    "paypal-transmission-sig": "c2lnbmF0dXJl",
    "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-a5cafa77",
    "paypal-auth-algo": "SHA256withRSA",
    ...over,
  });
}
