// The money loop's unhappy paths, PayPal replaced by a stateful fake (tests/helpers/fakePaypal.ts) that throws real
// SDK ApiErrors: negative testing, PENDING captures, webhooks that change state, refunds, tracking, declined funding
// sources, retries and payer verification.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { apiError, pp, webhookHeaders } from "./helpers/fakePaypal";
import { installFakeDrand } from "./helpers/fakeDrand";

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
let db: typeof import("../src/server/db");
let app: typeof import("../src/server/index")["app"];

beforeAll(async () => {
  installFakeDrand();
  domain = await import("../src/server/domain");
  queue = await import("../src/server/queue");
  models = await import("../src/server/models");
  db = await import("../src/server/db");
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

/** A drop with `payers.length` real entrants, all approved and held. */
async function dropWithHolds(payers: string[], opts: { units?: number; negativeTest?: boolean } = {}) {
  const drop = await domain.createDrop({ ...domain.SHOWCASE, units: opts.units ?? 1, negativeTest: opts.negativeTest ?? false });
  const entries = [];
  for (const p of payers) {
    const s = await domain.startEntry(drop.slug, "human");
    pp.approve(s.orderId, p);
    expect((await domain.finalize(s.orderId)).outcome).toBe("authorizing");
    entries.push(s);
  }
  await drain();
  return { drop, entries };
}

const entry = (id: string) => models.getEntry(id)!;
const events = (dropId: string) => db.db.prepare("SELECT kind, message, real, data_json FROM events WHERE drop_id = ? ORDER BY id").all(dropId) as { kind: string; message: string; real: number; data_json: string | null }[];

async function webhook(event_type: string, resource: Record<string, unknown>, id = `WH-${Math.random().toString(36).slice(2, 12).toUpperCase()}`) {
  pp.verify = true;
  const res = await app.request("/webhooks/paypal", { method: "POST", headers: webhookHeaders(), body: JSON.stringify({ id, event_type, resource }) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, id };
}

describe("P2-03 negative testing with PayPal-Mock-Response", () => {
  it("a real winner's capture is declined by PayPal (422 TRANSACTION_REFUSED), its live hold is voided, the waitlist gets the unit", async () => {
    const { drop, entries } = await dropWithHolds(["NEG-A", "NEG-B"], { negativeTest: true });
    const r = await domain.draw(drop.id);
    await drain();
    const winner = models.listEntries(drop.id).find((e) => e.public_id === r.winners[0])!;
    const other = entries.map((x) => entry(x.entryId)).find((e) => e.id !== winner.id)!;
    expect(winner.status).toBe("capture_failed");
    expect(pp.calls).toContain(`capture ${winner.authorization_id} mock=TRANSACTION_REFUSED key=cap:${winner.authorization_id}:1`);
    expect(pp.auths.get(winner.authorization_id!)!.status).toBe("VOIDED"); // we voided the hold PayPal left alive
    expect(other.status).toBe("captured");
    expect(models.getDrop(drop.id)!.status).toBe("settled");
    const neg = events(drop.id).find((e) => e.kind === "negative_test")!;
    expect(neg.message).toMatch(/PayPal-Mock-Response: TRANSACTION_REFUSED\) → 422 TRANSACTION_REFUSED/);
    expect(neg.message).toMatch(/still shows the hold as CREATED/);
    const trace = JSON.parse(neg.data_json!).trace;
    expect(trace).toMatchObject({ method: "POST", httpStatus: 422, paypalStatus: "TRANSACTION_REFUSED", debugId: "8f3a2b1c0d" });
    expect(trace.endpoint).toMatch(/^\/v2\/payments\/authorizations\/…\w{4}\/capture$/);
  });

  it("authorize INSTRUMENT_DECLINED: back to awaiting_person with the payer-action link, re-approval places the hold", async () => {
    const drop = await domain.createDrop({ ...domain.SHOWCASE });
    const s = await domain.startEntry(drop.slug, "human");
    pp.approve(s.orderId, "DECLINED-FAN");
    pp.failNext("authorize", apiError(422, "INSTRUMENT_DECLINED"));
    await domain.finalize(s.orderId);
    await drain();
    let e = entry(s.entryId);
    expect(e.status).toBe("awaiting_person");
    expect(e.note).toBe("PayPal couldn't use that funding source. Approve again to choose another.");
    expect(e.payer_hash).toBeNull(); // no hold, so the account is not "taken"
    expect(domain.participantView(e.id).approveUrl).toMatch(/sandbox\.paypal\.com\/checkoutnow\?token=/);
    // background re-checks wait for the person instead of re-authorizing the same declined instrument
    db.db.prepare("UPDATE entries SET updated_at = 0, created_at = ? WHERE id = ?").run(Date.now() - 60_000, e.id);
    await domain.sweep();
    expect(entry(s.entryId).status).toBe("awaiting_person");
    // the person approves again (return URL / onApprove): a fresh PayPal-Request-Id, and the hold is placed
    expect((await domain.finalize(s.orderId)).outcome).toBe("authorizing");
    await drain();
    e = entry(s.entryId);
    expect(e.status).toBe("held");
    expect(pp.calls).toContain(`authorize ${s.orderId} key=auth:${e.id}:2`);
    expect(domain.participantView(e.id).approveUrl).toBeNull();
  });
});

describe("P1-05 webhooks change state; PENDING is reconciled", () => {
  it("PENDING capture → PAYMENT.CAPTURE.COMPLETED webhook → captured → settled", async () => {
    const { drop, entries } = await dropWithHolds(["PEND-A"]);
    pp.failNext("capture", "PENDING");
    await domain.draw(drop.id);
    await drain();
    let e = entry(entries[0].entryId);
    expect(e.status).toBe("won");
    expect(e.capture_id).toBeTruthy();
    expect(models.getDrop(drop.id)!.status).toBe("drawn");
    pp.captures.get(e.capture_id!)!.status = "COMPLETED";
    const w = await webhook("PAYMENT.CAPTURE.COMPLETED", { id: e.capture_id, status: "COMPLETED", amount: { value: "72.50", currency_code: "USD" } });
    expect(w.status).toBe(200);
    e = entry(e.id);
    expect(e.status).toBe("captured");
    expect(e.captured_cents).toBe(7250);
    expect(models.getDrop(drop.id)!.status).toBe("settled");
    const line = events(drop.id).find((x) => x.kind === "webhook")!;
    expect(line.message).toBe(`Webhook PAYMENT.CAPTURE.COMPLETED (signature verified) → ${e.public_id} captured.`);
    expect(JSON.parse(line.data_json!).trace).toMatchObject({ event: "PAYMENT.CAPTURE.COMPLETED", verified: true, endpoint: "/v1/notifications/verify-webhook-signature" });
  });

  it("PENDING capture with no webhook: the sweeper asks PayPal after 2 minutes", async () => {
    const { drop, entries } = await dropWithHolds(["PEND-B"]);
    pp.failNext("capture", "PENDING");
    await domain.draw(drop.id);
    await drain();
    const e = entry(entries[0].entryId);
    await domain.reconcilePendingCaptures();
    expect(entry(e.id).status).toBe("won"); // too early: under 2 minutes
    pp.captures.get(e.capture_id!)!.status = "COMPLETED";
    db.db.prepare("UPDATE entries SET updated_at = ? WHERE id = ?").run(Date.now() - 121_000, e.id);
    await domain.reconcilePendingCaptures();
    expect(entry(e.id).status).toBe("captured");
    expect(entry(e.id).note).toBeNull(); // "Payment pending…" cleared
    expect(models.getDrop(drop.id)!.status).toBe("settled");
    expect(events(drop.id).some((x) => /Re-checked with PayPal: the pending capture .* is COMPLETED/.test(x.message))).toBe(true);
  });

  it("PENDING then PAYMENT.CAPTURE.DENIED → capture_failed, hold voided, waitlist promoted", async () => {
    const { drop } = await dropWithHolds(["DEN-A", "DEN-B"]);
    pp.failNext("capture", "PENDING");
    const r = await domain.draw(drop.id);
    await drain();
    const winner = models.listEntries(drop.id).find((e) => e.public_id === r.winners[0])!;
    const waiter = models.listEntries(drop.id).find((e) => e.public_id === r.waitlist[0])!;
    expect(winner.status).toBe("won");
    pp.captures.get(winner.capture_id!)!.status = "DECLINED";
    pp.auths.get(winner.authorization_id!)!.status = "CREATED"; // a denied capture leaves the hold
    const w = await webhook("PAYMENT.CAPTURE.DENIED", { id: winner.capture_id, status: "DECLINED" });
    expect(w.status).toBe(200);
    await drain();
    expect(entry(winner.id).status).toBe("capture_failed");
    expect(pp.auths.get(winner.authorization_id!)!.status).toBe("VOIDED");
    expect(entry(waiter.id).status).toBe("captured");
    expect(models.getDrop(drop.id)!.status).toBe("settled");
  });

  it("a redelivered webhook (same event id) is not processed twice", async () => {
    const { drop, entries } = await dropWithHolds(["DUP-A"]);
    pp.failNext("capture", "PENDING");
    await domain.draw(drop.id);
    await drain();
    const e = entry(entries[0].entryId);
    const first = await webhook("PAYMENT.CAPTURE.COMPLETED", { id: e.capture_id, amount: { value: "72.50" } }, "WH-DUPLICATE-0001");
    const second = await webhook("PAYMENT.CAPTURE.COMPLETED", { id: e.capture_id, amount: { value: "72.50" } }, "WH-DUPLICATE-0001");
    expect(first.body).toEqual({ ok: true });
    expect(second.body).toEqual({ ok: true, duplicate: true });
    expect(events(drop.id).filter((x) => x.kind === "webhook")).toHaveLength(1);
    expect(events(drop.id).filter((x) => x.kind === "settled")).toHaveLength(1);
  });

  it("if routing fails the event is forgotten, so PayPal's redelivery is processed", async () => {
    const drop = await domain.createDrop({ ...domain.SHOWCASE });
    const s = await domain.startEntry(drop.slug, "agent", "wren");
    pp.approve(s.orderId, "RETRY-FAN");
    pp.failNext("getOrder", apiError(503, "SERVICE_UNAVAILABLE"));
    const a = await webhook("CHECKOUT.ORDER.APPROVED", { id: s.orderId }, "WH-ROUTE-FAIL-01");
    expect(a.status).toBe(500);
    expect(entry(s.entryId).status).toBe("awaiting_person");
    const b = await webhook("CHECKOUT.ORDER.APPROVED", { id: s.orderId }, "WH-ROUTE-FAIL-01");
    expect(b.status).toBe(200);
    expect(entry(s.entryId).status).toBe("authorizing");
    expect(events(drop.id).find((x) => x.kind === "webhook")!.message).toMatch(/CHECKOUT\.ORDER\.APPROVED \(signature verified\) → E-\w+ approved, placing the hold/);
  });

  it("PAYMENT.AUTHORIZATION.VOIDED: a held entry loses its ticket; merged/captured entries keep their status", async () => {
    const { entries } = await dropWithHolds(["VOID-A"]);
    const e = entry(entries[0].entryId);
    await webhook("PAYMENT.AUTHORIZATION.VOIDED", { id: e.authorization_id, status: "VOIDED" });
    expect(entry(e.id).status).toBe("voided");
    db.db.prepare("UPDATE entries SET status = 'merged' WHERE id = ?").run(e.id);
    await webhook("PAYMENT.AUTHORIZATION.VOIDED", { id: e.authorization_id, status: "VOIDED" });
    expect(entry(e.id).status).toBe("merged");
  });

  it("CUSTOMER.DISPUTE.CREATED only writes a ledger line", async () => {
    const { drop, entries } = await dropWithHolds(["DISPUTE-A"]);
    await domain.draw(drop.id);
    await drain();
    const e = entry(entries[0].entryId);
    expect(e.status).toBe("captured");
    const w = await webhook("CUSTOMER.DISPUTE.CREATED", { dispute_id: "PP-D-1234", disputed_transactions: [{ seller_transaction_id: e.capture_id }] });
    expect(w.status).toBe(200);
    expect(entry(e.id).status).toBe("captured");
    expect(events(drop.id).at(-1)!.message).toMatch(/CUSTOMER\.DISPUTE\.CREATED .* dispute opened/);
  });
});

describe("P2-01 tracking and refunds", () => {
  it("seller marks shipped, then refunds; PayPal calls are idempotent and the webhook confirms", async () => {
    const { drop, entries } = await dropWithHolds(["SHIP-A"]);
    await domain.draw(drop.id);
    await drain();
    const e = entry(entries[0].entryId);
    expect(e.status).toBe("captured");
    const key = { "x-seller-key": drop.seller_token, "content-type": "application/json" };
    const post = (path: string, body: unknown) => app.request(`/api/seller/${drop.slug}/entries/${e.id}/${path}`, { method: "POST", headers: key, body: JSON.stringify(body) });

    expect((await post("ship", { carrier: "DHL" })).status).toBe(400);
    expect((await post("ship", { tracking: "x" })).status).toBe(400);
    expect(await (await post("ship", { carrier: "USPS", tracking: "9400 1000 0000 0000 1234 56" })).json()).toEqual({ ok: true });
    expect(await (await post("ship", { carrier: "USPS", tracking: "9400100000000000123456" })).json()).toEqual({ ok: true }); // same request again: no-op
    await drain();
    expect(pp.calls.filter((c) => c.startsWith("track"))).toHaveLength(1);
    expect(domain.participantView(e.id).shipping).toEqual({ carrier: "USPS", tracking: "9400100000000000123456" });
    expect((await post("ship", { tracking: "1Z999AA10123456784" })).status).toBe(409); // already shipped with another number

    const mcp = await app.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "entry_status", arguments: { entry_ref: e.id } } }),
    });
    expect((await mcp.json()).result.structuredContent).toMatchObject({ status: "shipped", shipping: { carrier: "USPS" }, captured_usd: 72.5 });

    expect(await (await post("refund", { reason: "Kiln accident <script>" })).json()).toEqual({ ok: true });
    expect(await (await post("refund", {})).json()).toEqual({ ok: true }); // double click: still one refund
    await drain();
    expect(pp.calls.filter((c) => c.startsWith("refund"))).toEqual([`refund ${e.capture_id} key=refund:${e.capture_id}`]);
    const r = entry(e.id);
    expect(r.status).toBe("refunded");
    expect(r.refunded_cents).toBe(7250);
    const line = events(drop.id).find((x) => x.kind === "refunded")!;
    expect(line.message).toBe(`Refunded $72.50 to ${e.public_id} (Kiln accident script). The buyer owes nothing.`); // markup stripped
    expect(JSON.parse(line.data_json!).trace.endpoint).toMatch(/^\/v2\/payments\/captures\/…\w{4}\/refund$/);

    const w = await webhook("PAYMENT.CAPTURE.REFUNDED", { id: r.refund_id, amount: { value: "72.50" }, links: [{ rel: "up", href: `https://api.sandbox.paypal.com/v2/payments/captures/${e.capture_id}` }] });
    expect(w.status).toBe(200);
    expect(events(drop.id).at(-1)!.message).toBe(`Webhook PAYMENT.CAPTURE.REFUNDED (signature verified) → ${e.public_id} refund confirmed.`);
    const view = domain.participantView(e.id);
    expect(view).toMatchObject({ status: "refunded", refundedCents: 7250, capturedCents: 7250 });
    const mcp2 = await app.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "entry_status", arguments: { entry_ref: e.id } } }),
    });
    expect((await mcp2.json()).result.structuredContent).toMatchObject({ status: "refunded", refunded_usd: 72.5 });
    const pub = domain.publicDrop(models.getDrop(drop.id)!);
    expect(pub.stats).toMatchObject({ refunded: 1, captured: 1, capturedCents: 0 });
  });

  it("refund and ship are refused for entries that were never paid", async () => {
    const { drop, entries } = await dropWithHolds(["NOPAY-A"]);
    const key = { "x-seller-key": drop.seller_token, "content-type": "application/json" };
    const res = await app.request(`/api/seller/${drop.slug}/entries/${entries[0].entryId}/refund`, { method: "POST", headers: key, body: "{}" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("not_captured");
    const other = await domain.createDrop({ ...domain.SHOWCASE });
    const wrongDrop = await app.request(`/api/seller/${other.slug}/entries/${entries[0].entryId}/ship`, { method: "POST", headers: { ...key, "x-seller-key": other.seller_token }, body: "{}" });
    expect(wrongDrop.status).toBe(404);
  });

  it("a refund PayPal rejects because the capture was already refunded elsewhere is reconciled, not reported as failed", async () => {
    const { drop, entries } = await dropWithHolds(["DASH-A"]);
    await domain.draw(drop.id);
    await drain();
    const e = entry(entries[0].entryId);
    pp.captures.get(e.capture_id!)!.status = "REFUNDED"; // refunded from the PayPal dashboard
    pp.failNext("refund", apiError(422, "CAPTURE_FULLY_REFUNDED"));
    domain.refundEntry(drop.id, e.id, "dashboard");
    await drain();
    expect(entry(e.id).status).toBe("refunded");
    expect(events(drop.id).at(-1)!.message).toMatch(/confirmed by PayPal \(capture REFUNDED\)/);
  });

  it("a refund issued from the PayPal dashboard reaches the ledger through the webhook", async () => {
    const { drop, entries } = await dropWithHolds(["DASH-B"]);
    await domain.draw(drop.id);
    await drain();
    const e = entry(entries[0].entryId);
    await webhook("PAYMENT.CAPTURE.REFUNDED", { id: "REFUNDFROMDASH01", amount: { value: "72.50" }, links: [{ rel: "up", href: `https://api.sandbox.paypal.com/v2/payments/captures/${e.capture_id}` }] });
    expect(entry(e.id)).toMatchObject({ status: "refunded", refunded_cents: 7250, refund_id: "REFUNDFROMDASH01" });
  });

  it("simulated winners get labelled, local ship/refund (no PayPal call)", async () => {
    const drop = await domain.createDrop({ ...domain.SHOWCASE, units: 2 });
    domain.addSimulatedCrowd(drop.slug, 99);
    await domain.draw(drop.id);
    await drain();
    const sim = models.listEntries(drop.id).find((e) => e.status === "captured")!;
    const before = pp.calls.length;
    domain.shipEntry(drop.id, sim.id, {});
    domain.refundEntry(drop.id, sim.id, "test");
    expect(pp.calls.length).toBe(before);
    expect(entry(sim.id).status).toBe("refunded");
    expect(events(drop.id).filter((x) => x.kind === "shipped_sim" || x.kind === "refund_sim").every((x) => x.real === 0)).toBe(true);
  });
});

describe("queue retries and configuration errors", () => {
  it("a 429 with Retry-After reschedules the op instead of failing it", async () => {
    const drop = await domain.createDrop({ ...domain.SHOWCASE });
    const s = await domain.startEntry(drop.slug, "human");
    pp.approve(s.orderId, "RATE-A");
    pp.failNext("authorize", apiError(429, "RATE_LIMIT_REACHED", { retryAfter: 7 }));
    await domain.finalize(s.orderId);
    const t0 = Date.now();
    await queue.tick(domain.handlers);
    const op = db.db.prepare("SELECT * FROM ops WHERE entry_id = ?").get(s.entryId) as { status: string; attempts: number; next_at: number; last_error: string };
    expect(op.status).toBe("pending");
    expect(op.attempts).toBe(1);
    expect(op.next_at - t0).toBeGreaterThanOrEqual(6_900);
    expect(op.next_at - t0).toBeLessThan(9_000);
    expect(op.last_error).toMatch(/^429 RATE_LIMIT_REACHED/);
    db.db.prepare("UPDATE ops SET next_at = 0 WHERE entry_id = ?").run(s.entryId);
    await drain();
    expect(entry(s.entryId).status).toBe("held");
  });

  it("a capture blocked by a configuration error (401) is retried later and does not burn the waitlist", async () => {
    const { drop } = await dropWithHolds(["CFG-A", "CFG-B"]);
    pp.failNext("capture", apiError(401, "AUTHENTICATION_FAILURE"));
    const r = await domain.draw(drop.id);
    await drain();
    const winner = models.listEntries(drop.id).find((e) => e.public_id === r.winners[0])!;
    const waiter = models.listEntries(drop.id).find((e) => e.public_id === r.waitlist[0])!;
    expect(winner.status).toBe("won");
    expect(waiter.status).toBe("waitlist");
    const op = db.db.prepare("SELECT status, next_at FROM ops WHERE key = ?").get(`cap:${winner.authorization_id}:1`) as { status: string; next_at: number };
    expect(op.status).toBe("pending");
    expect(op.next_at).toBeGreaterThan(Date.now() + 9 * 60_000);
    expect(events(drop.id).at(-1)!.kind).toBe("capture_blocked");
  });

  it("a void PayPal already performed is idempotent (already released, never an error)", async () => {
    const { drop } = await dropWithHolds(["IDEM-A", "IDEM-B"]);
    await domain.draw(drop.id);
    await drain();
    const loser = models.listEntries(drop.id).find((e) => e.status === "voided")!;
    expect(pp.auths.get(loser.authorization_id!)!.status).toBe("VOIDED");
    // the sweeper re-arms a void (or PayPal voided it from the dashboard): PayPal says VOIDED → "already released"
    queue.enqueue("void", `void:${loser.authorization_id}:replay`, loser.id, { reason: "replay" });
    await drain();
    expect(entry(loser.id).status).toBe("voided");
    expect(events(drop.id).at(-1)!.message).toMatch(/already released, never charged/);
  });

  it("an approval that lands after the drop closed places no hold", async () => {
    const drop = await domain.createDrop({ ...domain.SHOWCASE });
    const s = await domain.startEntry(drop.slug, "agent", "late-agent");
    db.db.prepare("UPDATE drops SET closes_at = ? WHERE id = ?").run(Date.now() - 1000, drop.id);
    pp.approve(s.orderId, "LATE-FAN");
    expect((await domain.finalize(s.orderId)).outcome).toBe("closed");
    await drain();
    expect(entry(s.entryId).status).toBe("expired");
    expect(pp.calls.some((c) => c.startsWith(`authorize ${s.orderId}`))).toBe(false);
  });

  it("drawing while a hold is still being placed answers 409 holds_pending", async () => {
    const drop = await domain.createDrop({ ...domain.SHOWCASE });
    const s = await domain.startEntry(drop.slug, "human");
    pp.approve(s.orderId, "PENDING-HOLD");
    await domain.finalize(s.orderId); // authorizing, op not run yet
    const res = await app.request(`/api/seller/${drop.slug}/draw`, { method: "POST", headers: { "x-seller-key": drop.seller_token } });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("holds_pending");
    await drain();
  });
});

describe("P2-16 payer verified by PayPal", () => {
  it("stores account_status as payerVerified for the fan and the seller", async () => {
    const drop = await domain.createDrop({ ...domain.SHOWCASE });
    const v = await domain.startEntry(drop.slug, "human");
    const u = await domain.startEntry(drop.slug, "human");
    pp.approve(v.orderId, "KYA-VERIFIED", "VERIFIED");
    pp.approve(u.orderId, "KYA-UNVERIFIED", "UNVERIFIED");
    await domain.finalize(v.orderId);
    await domain.finalize(u.orderId);
    await drain();
    expect(domain.participantView(v.entryId).payerVerified).toBe(true);
    expect(domain.participantView(u.entryId).payerVerified).toBe(false);
    const s = await (await app.request(`/api/seller/${drop.slug}`, { headers: { "x-seller-key": drop.seller_token } })).json();
    const rows = s.entries as { id: string; payerVerified: boolean | null; authorization: string | null }[];
    expect(rows.find((r) => r.id === v.entryId)!.payerVerified).toBe(true);
    expect(rows.find((r) => r.id === u.entryId)!.payerVerified).toBe(false);
    expect(rows.find((r) => r.id === v.entryId)!.authorization).toMatch(/^…\w{4}$/);
    expect(domain.payerVerified(undefined)).toBeNull();
  });
});
