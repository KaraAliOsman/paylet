// Public API surface for the PayPal trace (P1-01), "Ask PayPal" (P1-03) and the security headers / boot guard (P2-14).
import { beforeAll, describe, expect, it, vi } from "vitest";
import { pp } from "./helpers/fakePaypal";

vi.hoisted(() => {
  process.env.PAYPAL_OPS_PER_MINUTE = "100000";
});
vi.mock("../src/server/paypal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/server/paypal")>()),
  ...(await import("./helpers/fakePaypal")).fakeApi,
}));

let domain: typeof import("../src/server/domain");
let queue: typeof import("../src/server/queue");
let models: typeof import("../src/server/models");
let check: typeof import("../src/server/paypalcheck");
let app: typeof import("../src/server/index")["app"];

beforeAll(async () => {
  domain = await import("../src/server/domain");
  queue = await import("../src/server/queue");
  models = await import("../src/server/models");
  check = await import("../src/server/paypalcheck");
  app = (await import("../src/server/index")).app;
});

async function drain() {
  for (let idle = 0, i = 0; i < 400 && idle < 5; i++) {
    if (queue.pendingOps() > 0) {
      idle = 0;
      await queue.tick(domain.handlers);
    } else {
      idle++;
      await new Promise((r) => setTimeout(r, 5));
    }
  }
}

/** A settled drop: 3 real fans (1 unit, 1 duplicate account), negative test on → one real 422 + waitlist. */
async function settledDrop() {
  const drop = await domain.createDrop({ ...domain.SHOWCASE, units: 1, negativeTest: true });
  const fans = [];
  for (const p of ["TRACE-A", "TRACE-B", "TRACE-C", "TRACE-A"]) {
    const s = await domain.startEntry(drop.slug, p === "TRACE-B" ? "agent" : "human", "wren");
    pp.approve(s.orderId, p);
    await domain.finalize(s.orderId);
    fans.push(s);
  }
  await drain();
  await domain.draw(drop.id);
  await drain();
  expect(models.getDrop(drop.id)!.status).toBe("settled");
  return { drop, fans };
}

describe("P1-01 PayPal trace in the public ledger", () => {
  it("every real event carries a whitelisted trace with masked ids, and nothing else from data_json leaks", async () => {
    const { drop, fans } = await settledDrop();
    const res = await app.request(`/api/drops/${drop.slug}/events`);
    const text = await res.text();
    const { events } = JSON.parse(text) as { events: { kind: string; real: number; trace?: Record<string, unknown> }[] };
    // no full PayPal id, internal entry id, seed or data_json anywhere in the public payload
    const secrets = [...fans.flatMap((f) => [f.orderId, f.entryId]), ...models.listEntries(drop.id).flatMap((e) => [e.authorization_id, e.capture_id].filter(Boolean) as string[])];
    for (const s of secrets) expect(text).not.toContain(s);
    expect(text).not.toContain("data_json");
    expect(text).not.toContain("attempts");

    const byKind = (k: string) => events.find((e) => e.kind === k)!;
    expect(byKind("order_created").trace).toMatchObject({ method: "POST", endpoint: "/v2/checkout/orders", httpStatus: 200, paypalStatus: "PAYER_ACTION_REQUIRED" });
    expect(byKind("hold_placed").trace!.endpoint).toMatch(/^\/v2\/checkout\/orders\/…\w{4}\/authorize$/);
    expect(byKind("hold_placed").trace!.requestId).toMatch(/^auth:…\w{4}$/);
    expect(byKind("captured").trace).toMatchObject({ httpStatus: 201, paypalStatus: "COMPLETED" });
    expect(byKind("captured").trace!.requestId).toMatch(/^cap:…\w{4}:1$/);
    expect(byKind("voided").trace!.endpoint).toMatch(/\/void$/);
    expect(byKind("negative_test").trace).toMatchObject({ httpStatus: 422, paypalStatus: "TRANSACTION_REFUSED", debugId: "8f3a2b1c0d" });
    for (const e of events) {
      if (e.trace?.id) expect(e.trace.id).toMatch(/^…\w{4}$/);
      if (!e.real) expect(e.trace).toBeUndefined();
    }
  });

  it("trace whitelist drops unknown fields and unmasked ids", async () => {
    const { publicTrace, maskKey, maskId } = await import("../src/server/trace");
    expect(publicTrace({ method: "GET", endpoint: "/x", id: "5TY05013RG002845M", requestId: "cap:5TY05013RG002845M:1", email: "a@b.c", httpStatus: 200 })).toEqual({ method: "GET", endpoint: "/x", httpStatus: 200 });
    expect(maskKey("cap:5TY05013RG002845M:1")).toBe("cap:…845M:1");
    expect(maskKey("auth:ent_1a2b3c4d5e6f7a8b:2")).toBe("auth:…7a8b:2");
    expect(maskId("abc")).toBe("…");
    expect(publicTrace("nope")).toBeUndefined();
  });
});

describe("P1-03 Ask PayPal: live re-check of every real hold", () => {
  it("re-checks each real hold with PayPal, matches the ledger, caches 60 s", async () => {
    check._resetPaypalCheck();
    const { drop } = await settledDrop();
    const res = await app.request(`/api/drops/${drop.slug}/paypal-check`, { headers: { "cf-connecting-ip": "192.0.2.10" } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as import("../src/server/paypalcheck").PaypalCheck & { cached: boolean };
    expect(body.cached).toBe(false);
    expect(body.rows).toHaveLength(3); // the duplicate account never got a hold
    expect(body.totals).toEqual({ captured: 1, voided: 2, mismatches: 0 });
    const captured = body.rows.find((r) => r.ledgerStatus === "captured")!;
    expect(captured).toMatchObject({ paypalStatus: "CAPTURED", heldCents: 4800, capturedCents: 7250, matchesLedger: true });
    expect(captured.authorization).toMatch(/^…\w{4}$/);
    expect(body.rows.find((r) => r.ledgerStatus === "capture_failed")).toMatchObject({ paypalStatus: "VOIDED", matchesLedger: true });
    expect(JSON.stringify(body)).not.toMatch(/AUTH\d{4}X7K2Q/); // full ids never leave the server

    const again = (await (await app.request(`/api/drops/${drop.slug}/paypal-check`, { headers: { "cf-connecting-ip": "192.0.2.10" } })).json()) as { cached: boolean; checkedAt: number };
    expect(again.cached).toBe(true);
    expect(again.checkedAt).toBe(body.checkedAt);
  });

  it("shows a mismatch in red instead of hiding it", async () => {
    check._resetPaypalCheck();
    const { drop } = await settledDrop();
    const loser = models.listEntries(drop.id).find((e) => e.status === "voided")!;
    pp.auths.get(loser.authorization_id!)!.status = "CREATED"; // PayPal disagrees with our ledger
    const body = (await (await app.request(`/api/drops/${drop.slug}/paypal-check`, { headers: { "cf-connecting-ip": "192.0.2.11" } })).json()) as import("../src/server/paypalcheck").PaypalCheck;
    expect(body.totals.mismatches).toBe(1);
    expect(body.rows.find((r) => r.publicId === loser.public_id)).toMatchObject({ paypalStatus: "CREATED", ledgerStatus: "voided", matchesLedger: false });
  });

  it("is rate limited per client: 6 a minute", async () => {
    const drop = await domain.createDrop({ ...domain.SHOWCASE });
    const ask = (ip: string) => app.request(`/api/drops/${drop.slug}/paypal-check`, { headers: { "cf-connecting-ip": ip, "x-forwarded-for": `10.0.0.${Math.floor(Math.random() * 250)}` } });
    for (let i = 0; i < 6; i++) expect((await ask("192.0.2.50")).status).toBe(200);
    expect((await ask("192.0.2.50")).status).toBe(429); // a spoofed X-Forwarded-For does not reset the bucket
    expect((await ask("192.0.2.51")).status).toBe(200);
  });
});

describe("P2-14 security headers and boot guard", () => {
  it("serves a CSP that allows PayPal and drand, and no HSTS on plain http", async () => {
    const res = await app.request("/api/health");
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toContain("script-src 'self' https://*.paypal.com https://*.paypalobjects.com");
    expect(csp).toContain("frame-src https://*.paypal.com");
    expect(csp).toMatch(/connect-src [^;]*https:\/\/api\.drand\.sh/);
    expect(csp).toContain("object-src 'none'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("strict-transport-security")).toBeNull(); // PUBLIC_URL is http in tests
  });

  it("refuses to boot a public https deployment with the default HASH_SECRET", async () => {
    const { unsafeConfig, DEFAULT_HASH_SECRET } = await import("../src/server/env");
    expect(unsafeConfig({ PUBLIC_URL: "https://paylet.onrender.com", HASH_SECRET: DEFAULT_HASH_SECRET })).toMatch(/HASH_SECRET/);
    expect(unsafeConfig({ PUBLIC_URL: "http://localhost:8790", HASH_SECRET: DEFAULT_HASH_SECRET })).toBeNull();
    expect(unsafeConfig({ PUBLIC_URL: "https://paylet.onrender.com", HASH_SECRET: "a-long-random-generated-value" })).toBeNull();
  });
});
