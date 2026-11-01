// End-to-end domain flow with PayPal replaced by a stateful fake (no network):
// duplicate account → no hold, failed capture → waitlist promotion, losers voided, webhook signature enforced, MCP reachable,
// and the judge journey end to end through the HTTP API (swarm, guard, decisions, drand reveal, report, verify).
import { beforeAll, describe, expect, it, vi } from "vitest";
import { pp } from "./helpers/fakePaypal";
import { installFakeDrand } from "./helpers/fakeDrand";

vi.hoisted(() => {
  process.env.PAYPAL_OPS_PER_MINUTE = "100000"; // the token bucket would otherwise throttle the drained queue
});
vi.mock("../src/server/paypal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/server/paypal")>()),
  ...(await import("./helpers/fakePaypal")).fakeApi,
}));

let domain: typeof import("../src/server/domain");
let queue: typeof import("../src/server/queue");
let models: typeof import("../src/server/models");
let appMod: typeof import("../src/server/index");

beforeAll(async () => {
  installFakeDrand();
  domain = await import("../src/server/domain");
  queue = await import("../src/server/queue");
  models = await import("../src/server/models");
  appMod = await import("../src/server/index");
});

async function drain() {
  // the worker normally ticks forever; here we tick until the queue stays empty (promotion is async)
  for (let idle = 0, i = 0; i < 400 && idle < 5; i++) {
    if (queue.pendingOps() > 0) {
      idle = 0;
      await queue.tick(domain.handlers);
    } else {
      idle++;
      await new Promise((r) => setTimeout(r, 10));
    }
  }
}

describe("allocation flow", () => {
  it("one hold per PayPal account, failed capture promotes the waitlist, losers are voided", async () => {
    const drop = await domain.createDrop({ ...domain.SHOWCASE, units: 1, negativeTest: true });
    const a = await domain.startEntry(drop.slug, "human");
    const b = await domain.startEntry(drop.slug, "agent", "bot-1");
    const c = await domain.startEntry(drop.slug, "human");
    pp.approve(a.orderId, "PAYER-ALICE");
    pp.approve(b.orderId, "PAYER-ALICE"); // same PayPal account approves an agent's second request
    pp.approve(c.orderId, "PAYER-BRUNO");

    expect((await domain.finalize(a.orderId)).outcome).toBe("authorizing");
    expect((await domain.finalize(b.orderId)).outcome).toBe("duplicate");
    expect((await domain.finalize(c.orderId)).outcome).toBe("authorizing");
    expect((await domain.finalize(a.orderId)).outcome).toBe("already"); // idempotent
    await drain();

    const held = models.listEntries(drop.id).filter((e) => e.status === "held");
    expect(held).toHaveLength(2);
    expect(pp.calls.filter((x) => x.startsWith("authorize") && (x.includes(a.orderId) || x.includes(c.orderId)))).toHaveLength(2);
    expect(pp.calls.some((x) => x.includes(b.orderId) && x.startsWith("authorize"))).toBe(false); // the duplicate never reached /authorize

    const result = await domain.draw(drop.id);
    expect(result.winners).toHaveLength(1);
    await drain();

    const after = models.listEntries(drop.id);
    const captured = after.filter((e) => e.status === "captured");
    const failed = after.filter((e) => e.status === "capture_failed");
    expect(failed).toHaveLength(1); // the injected sandbox negative test
    expect(captured).toHaveLength(1); // the waitlisted entry got the unit with its existing hold
    expect(captured[0].id).not.toBe(failed[0].id);
    expect(models.getDrop(drop.id)!.status).toBe("settled");
    expect(after.find((e) => e.id === b.entryId)!.status).toBe("duplicate");
    // money only moved for the final winner; the failed winner's live hold was voided
    expect(captured[0].captured_cents).toBe(drop.price_cents + drop.ship_actual_cents);
    expect(pp.auths.get(failed[0].authorization_id!)!.status).toBe("VOIDED");
  });

  it("negative test on a simulated winner promotes the waitlist before settling (no early settle race)", async () => {
    const drop = await domain.createDrop({ ...domain.SHOWCASE, units: 2, negativeTest: true });
    domain.addSimulatedCrowd(drop.slug, 4242);
    await domain.draw(drop.id);
    await drain();
    const after = models.listEntries(drop.id);
    expect(after.filter((e) => e.status === "capture_failed")).toHaveLength(1);
    expect(after.filter((e) => e.status === "captured")).toHaveLength(2);
    expect(models.getDrop(drop.id)!.status).toBe("settled");
  });

  it("rejects unsigned webhooks and requires the seller key", async () => {
    const res = await appMod.app.request("/webhooks/paypal", { method: "POST", body: JSON.stringify({ id: "WH-1", event_type: "PAYMENT.CAPTURE.COMPLETED" }) });
    expect(res.status).toBe(400); // no PayPal transmission headers: rejected before verification
    const drop = await domain.createDrop({ ...domain.SHOWCASE });
    const s = await appMod.app.request(`/api/seller/${drop.slug}`);
    expect(s.status).toBe(403);
    const ok = await appMod.app.request(`/api/seller/${drop.slug}`, { headers: { "x-seller-key": drop.seller_token } });
    expect(ok.status).toBe(200);
  });

  it("exposes MCP tools over Streamable HTTP", async () => {
    const res = await appMod.app.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.tools.map((t: { name: string }) => t.name).sort()).toEqual(["enter_drop", "entry_status", "list_drops"]);
  });
});

// The judge's whole journey through the public API, as /judge drives it: scalper swarm over MCP, a real fan plus the
// same PayPal account again through an agent, the labelled crowd, the AI review, the review guard, the seller's
// decisions, the two-phase draw with public randomness, settlement, the Drop report and /verify.
describe("judge journey through the API (P0-02, P0-03, P2-10, P1-07)", () => {
  it("swarm → fan + duplicate → crowd → AI review → guard → decide → freeze → drand reveal → settled → report → verify", async () => {
    const agent = await import("../src/server/agent");
    const shared = await import("../src/shared/draw");
    agent._setMcpFetch(async (url, init) => appMod.app.request(String(url), init));
    const app = appMod.app;
    const json = (r: Response) => r.json() as Promise<any>;
    const { slug, sellerKey } = await json(await app.request("/api/judge-drop", { method: "POST", headers: { "cf-connecting-ip": "203.0.113.77" } }));
    const key = { "x-seller-key": sellerKey, "content-type": "application/json" };
    const drop = models.getDrop(slug)!;
    expect(drop.kind).toBe("judge");

    // 1. scalper agents: approval links, 0 holds
    const swarm = await agent.runSwarm(slug, 12, { delayMs: 0, backoffMs: [1, 1, 1] });
    expect(swarm.links).toHaveLength(12);

    // 2. a real fan, then the same PayPal account again through an agent → no hold
    const fan = await json(await app.request(`/api/drops/${slug}/entries`, { method: "POST" }));
    pp.approve(fan.orderId, "PAYER-JUDGE");
    expect((await json(await app.request("/api/entries/finalize", { method: "POST", body: JSON.stringify({ orderId: fan.orderId }) }))).outcome).toBe("authorizing");
    const again = await domain.startEntry(slug, "agent", "Wren (fan's assistant)");
    pp.approve(again.orderId, "PAYER-JUDGE");
    expect((await domain.finalize(again.orderId)).outcome).toBe("duplicate");
    await drain();

    // 3. the labelled crowd and the AI review (no model key in tests: rule-only suggestions, said plainly)
    expect((await json(await app.request(`/api/seller/${slug}/simulate`, { method: "POST", headers: key }))).added).toBeGreaterThan(10);
    const sims = models.listEntries(drop.id).filter((e) => e.source === "simulated");
    expect(sims.every((e) => e.created_at >= drop.created_at && e.created_at <= Date.now())).toBe(true); // inside the drop window
    const review = await json(await app.request(`/api/seller/${slug}/analyze`, { method: "POST", headers: key }));
    expect(review.clusters).toBeGreaterThan(0);

    // 4. the guard: a judge drop cannot be drawn (even with force) while suggestions are pending
    const blocked = await app.request(`/api/seller/${slug}/draw`, { method: "POST", headers: key, body: JSON.stringify({ force: true }) });
    expect(blocked.status).toBe(409);
    expect((await json(blocked)).error).toBe("pending_reviews");

    // 5. the seller decides every suggestion: confirm reseller networks, dismiss households
    const seller = await json(await app.request(`/api/seller/${slug}`, { headers: key }));
    for (const c of seller.clusters) {
      const decision = c.kind === "operator" ? "confirmed" : "dismissed";
      expect((await app.request(`/api/seller/${slug}/clusters/${c.id}`, { method: "POST", headers: key, body: JSON.stringify({ decision }) })).status).toBe(200);
    }
    expect((await json(await app.request(`/api/drops/${slug}`))).pendingReviews).toBe(0);

    // 6. freeze now, reveal with drand in the background
    const frozen = await json(await app.request(`/api/seller/${slug}/draw`, { method: "POST", headers: key, body: "{}" }));
    expect(frozen).toMatchObject({ status: "frozen", round: expect.any(Number), revealAt: expect.any(Number) });
    expect(frozen.excluded).toContainEqual({ publicId: again.publicId, reason: "duplicate" });
    await domain.whenRevealed(drop.id);
    await drain();
    const pub = await json(await app.request(`/api/drops/${slug}`));
    expect(pub.status).toBe("settled");
    expect(pub.randomness).toMatchObject({ source: "drand-quicknet", round: frozen.round });
    expect(pub.stats).toMatchObject({ duplicatesBlocked: 1, agents: 13 });

    // 7. the Drop report: two zeros computed from the ledger, networks counted
    const report = await json(await app.request(`/api/drops/${slug}/report`));
    expect(report).toMatchObject({ units: 2, unitsToDistinctPayers: 2, chargedToLosersCents: 0, agentRequests: 13, agentHoldsWithoutPerson: 0, sameAccountDuplicates: 1, real: true, failedPayments: 1 });
    expect(report.simulatedEntrants).toBe(sims.length);

    // 8. /verify: what a browser recomputes
    const v = await json(await app.request(`/api/drops/${slug}/verify`));
    expect(await shared.sha256Hex(v.seed)).toBe(v.seedHash);
    expect(await shared.sha256Hex(shared.canonicalList(v.frozenList))).toBe(v.frozenHash);
    expect(await shared.sha256Hex(`${v.seed}:${v.randomness.value}`)).toBe(v.finalSeed);
    const computed = await shared.computeDraw(v.finalSeed, v.frozenList, v.units, v.waitlistSize);
    const outcome = new Map<string, string>(v.outcome.map((o: { publicId: string; status: string }) => [o.publicId, o.status]));
    // the negative test fails one winner; everyone else drawn first is paid, and nobody outside the winners + waitlist is
    for (const pid of computed.winners) expect(["captured", "capture_failed"]).toContain(outcome.get(pid));
    for (const [pid, st] of outcome) if (st === "captured") expect([...computed.winners, ...computed.waitlist]).toContain(pid);

    // the ledger: human copy, no "SIMULATED" prefix, one line for the bulk simulated releases
    const { events } = await json(await app.request(`/api/drops/${slug}/events?after=0`));
    expect(events.some((e: { message: string }) => /^SIMULATED/i.test(e.message))).toBe(false);
    expect(events.filter((e: { kind: string }) => e.kind === "void_sim").length).toBeLessThanOrEqual(3);
  });
});
