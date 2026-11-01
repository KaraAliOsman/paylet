// The real PayPal layer (src/server/paypal.ts), with the SDK controllers stubbed at their prototypes and fetch stubbed
// for the raw REST calls: traces, PayPal-Mock-Response, idempotent void / tracking, refunds, error classification,
// byte-for-byte webhook verification and the webhook event PATCH.
import { ApiError, OrdersController, PaymentsController } from "@paypal/paypal-server-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as paypal from "../src/server/paypal";

const ok = <T>(result: T, statusCode = 200, headers: Record<string, string> = { "paypal-debug-id": "dbg-ok-1" }) =>
  ({ result, statusCode, headers, body: "", request: {} }) as never;
const fail = (statusCode: number, issue: string, headers: Record<string, string> = {}) =>
  new ApiError(
    {
      request: { method: "POST", url: "https://api-m.sandbox.paypal.com/x" },
      response: { statusCode, headers: { "paypal-debug-id": "dbg-fail-9", ...headers }, body: JSON.stringify({ name: "X", debug_id: "dbg-fail-9", details: [{ issue, description: issue }] }) },
    } as never,
    `HTTP ${statusCode}`,
  );

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("traced SDK calls", () => {
  it("a successful capture returns a trace: endpoint and ids masked, HTTP status, PayPal status, debug id", async () => {
    const spy = vi.spyOn(PaymentsController.prototype, "captureAuthorizedPayment").mockResolvedValue(ok({ id: "3C679366HH908993F", status: "COMPLETED", amount: { value: "44.50" } }, 201));
    const r = await paypal.captureAuthorization("0VF52814937998046", 4450, "cap:0VF52814937998046:1", "PAYLET-x-1");
    expect(r).toMatchObject({ captureId: "3C679366HH908993F", status: "COMPLETED" });
    expect(r.trace).toMatchObject({
      method: "POST",
      endpoint: "/v2/payments/authorizations/…8046/capture",
      httpStatus: 201,
      paypalStatus: "COMPLETED",
      id: "…993F",
      requestId: "cap:…8046:1",
      debugId: "dbg-ok-1",
    });
    const args = spy.mock.calls[0][0] as { paypalRequestId: string; paypalMockResponse?: string; body: { amount: { value: string }; finalCapture: boolean } };
    expect(args.paypalRequestId).toBe("cap:0VF52814937998046:1");
    expect(args.paypalMockResponse).toBeUndefined();
    expect(args.body).toMatchObject({ amount: { value: "44.50" }, finalCapture: true });
  });

  it("negative test: sends PayPal-Mock-Response and a 422 carries its trace (status, issue, debug_id) to classify()", async () => {
    const spy = vi.spyOn(PaymentsController.prototype, "captureAuthorizedPayment").mockRejectedValue(fail(422, "TRANSACTION_REFUSED"));
    const err = await paypal.captureAuthorization("0VF52814937998046", 4450, "cap:0VF52814937998046:1", "inv", { mock: "TRANSACTION_REFUSED" }).catch((e) => e);
    expect((spy.mock.calls[0][0] as { paypalMockResponse: string }).paypalMockResponse).toBe('{"mock_application_codes":"TRANSACTION_REFUSED"}');
    const f = paypal.classify(err);
    expect(f).toMatchObject({ status: 422, issue: "TRANSACTION_REFUSED", cls: "TERMINAL", debugId: "dbg-fail-9" });
    expect(f.trace).toMatchObject({ endpoint: "/v2/payments/authorizations/…8046/capture", httpStatus: 422, paypalStatus: "TRANSACTION_REFUSED", debugId: "dbg-fail-9" });
  });

  it("void is idempotent: already VOIDED → no POST; PREVIOUSLY_VOIDED → success", async () => {
    const get = vi.spyOn(PaymentsController.prototype, "getAuthorizedPayment").mockResolvedValue(ok({ status: "VOIDED" }));
    const post = vi.spyOn(PaymentsController.prototype, "voidPayment");
    expect(await paypal.voidAuthorizationSafe("AUTHVOIDED0001", "void:AUTHVOIDED0001")).toMatchObject({ status: "VOIDED", already: true });
    expect(post).not.toHaveBeenCalled();
    get.mockResolvedValue(ok({ status: "CREATED" }));
    post.mockRejectedValue(fail(422, "PREVIOUSLY_VOIDED"));
    expect(await paypal.voidAuthorizationSafe("AUTHVOIDED0001", "void:AUTHVOIDED0001")).toMatchObject({ status: "VOIDED", already: true });
    get.mockResolvedValue(ok({ status: "CAPTURED" }));
    expect((await paypal.voidAuthorizationSafe("AUTHVOIDED0001", "void:AUTHVOIDED0001")).status).toBe("CAPTURED"); // never "voided" after a capture
  });

  it("tracking: POST /track with notify_payer, and a second call for the same number is a no-op", async () => {
    const get = vi.spyOn(OrdersController.prototype, "getOrder").mockResolvedValue(ok({ purchaseUnits: [{ shipping: { trackers: [] } }] }));
    const track = vi.spyOn(OrdersController.prototype, "createOrderTracking").mockResolvedValue(ok({ purchaseUnits: [{ shipping: { trackers: [{ id: "CAP1-9400100000", status: "SHIPPED" }] } }] }, 201));
    const r = await paypal.addTracking("ORDER1ABCDEF", "CAP1", "9400100000", "USPS");
    expect(r).toMatchObject({ already: false, trace: { endpoint: "/v2/checkout/orders/…CDEF/track", httpStatus: 201, paypalStatus: "SHIPPED" } });
    expect(track.mock.calls[0][0]).toMatchObject({ id: "ORDER1ABCDEF", body: { captureId: "CAP1", trackingNumber: "9400100000", carrier: "USPS", notifyPayer: true } });
    get.mockResolvedValue(ok({ purchaseUnits: [{ shipping: { trackers: [{ id: "CAP1-9400100000" }] } }] }));
    expect((await paypal.addTracking("ORDER1ABCDEF", "CAP1", "9400100000", "USPS")).already).toBe(true);
    expect(track).toHaveBeenCalledTimes(1);
  });

  it("refund: full refund keyed by PayPal-Request-Id", async () => {
    const spy = vi.spyOn(PaymentsController.prototype, "refundCapturedPayment").mockResolvedValue(ok({ id: "1JU08902781691411", status: "COMPLETED", amount: { value: "44.50" } }, 201));
    const r = await paypal.refundCapture("3C679366HH908993F", "refund:3C679366HH908993F", "Refund from the maker.");
    expect(r).toMatchObject({ refundId: "1JU08902781691411", status: "COMPLETED", amountCents: 4450, trace: { endpoint: "/v2/payments/captures/…993F/refund", requestId: "refund:…993F" } });
    expect(spy.mock.calls[0][0]).toMatchObject({ captureId: "3C679366HH908993F", paypalRequestId: "refund:3C679366HH908993F", body: { noteToPayer: "Refund from the maker." } });
  });

  it("identity exposes account_status for payer verification", async () => {
    vi.spyOn(OrdersController.prototype, "getOrder").mockResolvedValue(ok({ status: "APPROVED", payer: { payerId: "PAYERX" }, paymentSource: { paypal: { accountId: "PAYERX", accountStatus: "VERIFIED" } } }));
    expect(await paypal.getOrderIdentity("ORDERIDENT01")).toMatchObject({ status: "APPROVED", payerId: "PAYERX", accountStatus: "VERIFIED" });
  });
});

describe("error classification", () => {
  it.each([
    [fail(429, "RATE_LIMIT_REACHED", { "retry-after": "7" }), { cls: "RETRYABLE", retryAfterMs: 7000 }],
    [fail(503, "SERVICE_UNAVAILABLE"), { cls: "RETRYABLE" }],
    [fail(401, "AUTHENTICATION_FAILURE"), { cls: "CONFIG" }],
    [fail(422, "ORDER_NOT_APPROVED"), { cls: "WAIT" }],
    [fail(422, "AUTHORIZATION_VOIDED"), { cls: "TERMINAL", issue: "AUTHORIZATION_VOIDED" }],
    [Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }), { cls: "RETRYABLE", issue: "NETWORK" }],
  ])("%#", (e, expected) => {
    expect(paypal.classify(e)).toMatchObject(expected);
  });
});

describe("raw REST: webhook verification and registration", () => {
  function stubFetch(handler: (url: string, init: RequestInit) => { status?: number; json?: unknown }) {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        if (url.endsWith("/v1/oauth2/token")) return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
        const r = handler(url, init);
        return new Response(r.json === undefined ? "" : JSON.stringify(r.json), { status: r.status ?? 200, headers: { "paypal-debug-id": "dbg-wh" } });
      }),
    );
    return calls;
  }
  const headers = () =>
    new Headers({
      "paypal-transmission-id": "tid-1",
      "paypal-transmission-time": "2026-11-01T10:00:00Z",
      "paypal-transmission-sig": "sig",
      "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1",
      "paypal-auth-algo": "SHA256withRSA",
    });

  it("splices the raw event into the verification request without re-serialising it", async () => {
    const calls = stubFetch(() => ({ json: { verification_status: "SUCCESS" } }));
    const raw = '{"id":"WH-1",  "event_type":"PAYMENT.CAPTURE.COMPLETED","resource":{"amount":{"value":"44.50"},"note":"ünï ☕"}}';
    const v = await paypal.verifyWebhookSignature(headers(), raw, "WEBHOOK-ID-1");
    expect(v).toMatchObject({ verified: true, httpStatus: 200, debugId: "dbg-wh" });
    const sent = String(calls.find((c) => c.url.endsWith("/verify-webhook-signature"))!.init.body);
    expect(sent.endsWith(`"webhook_id":"WEBHOOK-ID-1","webhook_event":${raw}}`)).toBe(true);
    expect(JSON.parse(sent)).toMatchObject({ transmission_id: "tid-1", cert_url: "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1", auth_algo: "SHA256withRSA" });
  });

  it("fails closed: FAILURE, HTTP errors and a missing webhook id are all 'not verified'", async () => {
    stubFetch(() => ({ json: { verification_status: "FAILURE" } }));
    expect((await paypal.verifyWebhookSignature(headers(), "{}", "W")).verified).toBe(false);
    stubFetch(() => ({ status: 400, json: { name: "VALIDATION_ERROR" } }));
    expect((await paypal.verifyWebhookSignature(headers(), "{}", "W")).verified).toBe(false);
    expect((await paypal.verifyWebhookSignature(headers(), "{}", "")).verified).toBe(false);
  });

  it("PATCHes an existing webhook that lacks some of the events Paylet routes", async () => {
    const calls = stubFetch((url, init) => {
      if (init.method === "GET") return { json: { webhooks: [{ id: "WH-REG-1", url: "https://paylet.example/webhooks/paypal", event_types: [{ name: "CHECKOUT.ORDER.APPROVED" }, { name: "PAYMENT.CAPTURE.COMPLETED" }] }] } };
      return { json: { id: "WH-REG-1" } };
    });
    const r = await paypal.ensureWebhook("https://paylet.example");
    expect(r.id).toBe("WH-REG-1");
    expect(r.patched).toEqual(expect.arrayContaining(["PAYMENT.CAPTURE.REVERSED", "CUSTOMER.DISPUTE.CREATED", "PAYMENT.CAPTURE.REFUNDED"]));
    const patch = calls.find((c) => c.init.method === "PATCH")!;
    expect(patch.url).toMatch(/\/v1\/notifications\/webhooks\/WH-REG-1$/);
    const ops = JSON.parse(String(patch.init.body)) as { op: string; path: string; value: { name: string }[] }[];
    expect(ops[0]).toMatchObject({ op: "replace", path: "/event_types" });
    expect(ops[0].value.map((v) => v.name).sort()).toEqual([...paypal.WEBHOOK_EVENTS].sort());
    expect(await paypal.ensureWebhook("http://localhost:8790")).toEqual({ id: "", patched: [] });
  });

  it("a failed PATCH keeps the existing webhook id (signature verification depends on it)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    stubFetch((url, init) => {
      if (init.method === "GET") return { json: { webhooks: [{ id: "WH-REG-2", url: "https://paylet.example/webhooks/paypal", event_types: [{ name: "CHECKOUT.ORDER.APPROVED" }] }] } };
      return { status: 400, json: { name: "INVALID_REQUEST" } };
    });
    expect(await paypal.ensureWebhook("https://paylet.example")).toEqual({ id: "WH-REG-2", patched: [] });
  });
});
