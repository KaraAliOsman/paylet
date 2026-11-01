// P2-14: webhook requests are checked BEFORE PayPal's signature verification is called (headers, certificate host,
// clock skew, JSON shape, rate limit), and the raw body reaches the verification byte for byte.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { pp, webhookHeaders } from "./helpers/fakePaypal";

vi.mock("../src/server/paypal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/server/paypal")>()),
  ...(await import("./helpers/fakePaypal")).fakeApi,
}));

let app: typeof import("../src/server/index")["app"];
let precheck: typeof import("../src/server/webhooks")["precheckWebhook"];

beforeAll(async () => {
  app = (await import("../src/server/index")).app;
  precheck = (await import("../src/server/webhooks")).precheckWebhook;
});
beforeEach(() => {
  pp.verify = false;
  pp.verifyCalls.length = 0;
});

const body = JSON.stringify({ id: "WH-PRE-0001", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: "CAPNOTOURS01" } });
const post = (headers: Headers, b = body, ip = "203.0.113.9") => {
  headers.set("cf-connecting-ip", ip);
  return app.request("/webhooks/paypal", { method: "POST", headers, body: b });
};

describe("webhook pre-checks (no PayPal call for junk)", () => {
  it.each(["paypal-transmission-id", "paypal-transmission-time", "paypal-transmission-sig", "paypal-cert-url", "paypal-auth-algo"])("missing %s → 400", async (h) => {
    const headers = webhookHeaders();
    headers.delete(h);
    const res = await post(headers);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("missing_paypal_headers");
    expect(pp.verifyCalls).toHaveLength(0);
  });

  it.each([
    "http://api.sandbox.paypal.com/v1/notifications/certs/CERT-1",
    "https://paypal.com.evil.example/certs/CERT-1",
    "https://evilpaypal.com/certs/CERT-1",
    "https://attacker.example/?u=https://api.paypal.com",
    "not a url",
  ])("certificate URL %s → 400", async (url) => {
    const res = await post(webhookHeaders({ "paypal-cert-url": url }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("bad_cert_url");
    expect(pp.verifyCalls).toHaveLength(0);
  });

  it("transmission time outside ±5 minutes → 400", async () => {
    for (const offset of [-6 * 60_000, 6 * 60_000]) {
      const res = await post(webhookHeaders({ "paypal-transmission-time": new Date(Date.now() + offset).toISOString() }));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("stale_transmission");
    }
    expect(precheck(webhookHeaders({ "paypal-transmission-time": new Date(Date.now() - 4 * 60_000).toISOString() }), body)).toBeNull();
    expect(pp.verifyCalls).toHaveLength(0);
  });

  it("a body that is not a PayPal event → 400", async () => {
    expect((await (await post(webhookHeaders(), "{not json")).json()).error).toBe("bad_json");
    expect((await (await post(webhookHeaders(), JSON.stringify({ event_type: "X" }))).json()).error).toBe("bad_event");
    expect(pp.verifyCalls).toHaveLength(0);
  });

  it("a well-formed request reaches PayPal's verification with the raw body byte for byte, and fails closed", async () => {
    const raw = '{"id":"WH-RAW-0001",   "event_type":"PAYMENT.AUTHORIZATION.CREATED","resource":{"id":"AUTHNOTOURS1","note":"caf\\u00e9 ☕ ünïcode"}}';
    const res = await post(webhookHeaders(), raw);
    expect(res.status).toBe(401);
    expect(pp.verifyCalls).toHaveLength(1);
    expect(pp.verifyCalls[0].raw).toBe(raw);
  });

  it("is rate limited per client (60/min)", async () => {
    let last = 0;
    for (let i = 0; i < 61; i++) last = (await post(webhookHeaders(), "{", "198.51.100.77")).status;
    expect(last).toBe(429);
    expect((await post(webhookHeaders(), "{", "198.51.100.78")).status).toBe(400); // another client is unaffected
  });
});
