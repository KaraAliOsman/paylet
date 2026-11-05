// P1-07 Drop report + /api/stats (computed from the ledger, real-only where promised) and the seller console's
// AiSummary / Cluster contract (P2-04 backend): kept-apart pairs leave the server with public ids only, normalizedKey is
// stored, a degraded review says so. resolve() is mocked with the shape workstream C returns.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { pp } from "./helpers/fakePaypal";
import { installFakeDrand } from "./helpers/fakeDrand";

vi.hoisted(() => {
  process.env.PAYPAL_OPS_PER_MINUTE = "100000";
});
vi.mock("../src/server/paypal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/server/paypal")>()),
  ...(await import("./helpers/fakePaypal")).fakeApi,
}));
const er = vi.hoisted(() => ({ next: null as null | ((ids: { id: string; label?: string }[]) => Record<string, unknown>) }));
vi.mock("../src/server/er/resolve", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/server/er/resolve")>();
  return {
    ...orig,
    resolve: vi.fn(async (list: { id: string; label?: string }[], opts: { useLlm: boolean }) => (er.next ? er.next(list) : orig.resolve(list as never, opts))),
  };
});

let domain: typeof import("../src/server/domain");
let queue: typeof import("../src/server/queue");
let models: typeof import("../src/server/models");
let report: typeof import("../src/server/report");
let app: typeof import("../src/server/index")["app"];

beforeAll(async () => {
  installFakeDrand();
  domain = await import("../src/server/domain");
  queue = await import("../src/server/queue");
  models = await import("../src/server/models");
  report = await import("../src/server/report");
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

let n = 0;
async function enter(slug: string, payer: string, source: "human" | "agent" = "human") {
  const s = await domain.startEntry(slug, source, source === "agent" ? "Wren (fan's assistant)" : undefined);
  pp.approve(s.orderId, payer, n++ % 2 ? "VERIFIED" : "UNVERIFIED");
  await domain.finalize(s.orderId);
  return s;
}

describe("P1-07 Drop report", () => {
  it("a settled drop with a failed payment: distinct payers, money, voids, recovery time, and the two zeros computed", async () => {
    const drop = await domain.createDrop({ ...domain.SHOWCASE, units: 1, negativeTest: true });
    await enter(drop.slug, "REP-A");
    await enter(drop.slug, "REP-B", "agent");
    await enter(drop.slug, "REP-C");
    await enter(drop.slug, "REP-A", "agent"); // same account: no hold
    await domain.startEntry(drop.slug, "agent", "scalper-bot-01"); // a link nobody approved
    await drain();
    const partial = await (await app.request(`/api/drops/${drop.slug}/report`)).json();
    expect(partial).toMatchObject({ units: 1, capturedCents: 0, holdsVoided: 0, sameAccountDuplicates: 1, agentRequests: 3, real: true, simulatedEntrants: 0 });

    await domain.draw(drop.id);
    await drain();
    const r = (await (await app.request(`/api/drops/${drop.slug}/report`)).json()) as import("../src/server/report").DropReport;
    expect(r).toMatchObject({
      units: 1,
      unitsToDistinctPayers: 1,
      capturedCents: 7250, // $65 + $7.50 actual shipping
      shippingReleasedCents: 450, // of the $12 shipping held
      holdsVoided: 2, // the failed winner's live hold + the loser's
      chargedToLosersCents: 0,
      failedPayments: 1,
      agentRequests: 3,
      agentHoldsWithoutPerson: 0,
      networkAccounts: 0,
      networkTickets: 0,
      sameAccountDuplicates: 1,
      real: true,
    });
    expect(r.waitlistRecoverySeconds).toBeGreaterThanOrEqual(0);
    expect(r.payerVerified).toBe(models.listEntries(drop.id).filter((e) => e.payer_verified === 1).length);
    expect(JSON.stringify(r)).not.toMatch(/REP-|@|ent_/); // no PII, no internal ids
  });

  it("confirmed reseller networks: accounts → tickets", async () => {
    const drop = await domain.createDrop({ ...domain.SHOWCASE, units: 1, negativeTest: false });
    const a = await enter(drop.slug, "NET-1");
    const b = await enter(drop.slug, "NET-2");
    const c = await enter(drop.slug, "NET-3");
    await enter(drop.slug, "SOLO-1");
    await drain();
    const cid = models.id("clu", 6);
    (await import("../src/server/db")).db
      .prepare("INSERT INTO clusters(id, drop_id, kind, status, method, confidence, evidence_json, explanation, member_ids, created_at) VALUES(?, ?, 'operator', 'confirmed', 'ai', 0.93, '[]', 'x', ?, ?)")
      .run(cid, drop.id, JSON.stringify([a.entryId, b.entryId, c.entryId]), Date.now());
    await domain.draw(drop.id);
    await drain();
    const r = report.dropReport(models.getDrop(drop.id)!);
    expect(r).toMatchObject({ networkAccounts: 3, networkTickets: 1, chargedToLosersCents: 0 });
    expect(r.holdsVoided).toBe(3); // 2 merged + 1 loser
  });
});

describe("/api/stats: landing counters, real PayPal activity only", () => {
  it("counts real holds, duplicates, agent requests, captured money and voids; simulated entrants never count", async () => {
    report._resetStatsCache();
    const before = (await (await app.request("/api/stats")).json()) as import("../src/server/report").GlobalStats;
    const drop = await domain.createDrop({ ...domain.SHOWCASE, units: 2, negativeTest: false });
    await enter(drop.slug, "ST-A");
    await enter(drop.slug, "ST-A", "agent"); // duplicate
    domain.addSimulatedCrowd(drop.slug, 777);
    await drain();
    await domain.draw(drop.id, { force: true });
    await drain();
    report._resetStatsCache();
    const after = (await (await app.request("/api/stats")).json()) as import("../src/server/report").GlobalStats;
    const real = models.listEntries(drop.id).find((e) => e.source === "human")!;
    expect(after.holds - before.holds).toBe(1);
    expect(after.duplicatesBlocked - before.duplicatesBlocked).toBe(1);
    expect(after.agentRequests - before.agentRequests).toBe(1);
    expect(after.drops - before.drops).toBe(1);
    expect(after.chargedToLosersCents).toBe(0);
    if (real.status === "captured") expect(after.capturedCents - before.capturedCents).toBe(7250);
    else expect(after.voidedHolds - before.voidedHolds).toBe(1);
  });
});

describe("P2-04 backend: AiSummary and the Cluster contract", () => {
  it("kept-apart pairs leave with public ids, normalizedKey is stored, the summary is persisted per drop", async () => {
    const drop = await domain.createDrop({ ...domain.SHOWCASE, units: 1, negativeTest: false });
    const fans = [];
    for (const p of ["AI-1", "AI-2", "AI-3", "AI-4"]) fans.push(await enter(drop.slug, p));
    await drain();
    const ids = fans.map((f) => f.entryId);
    const pid = (i: number) => models.getEntry(ids[i])!.public_id;
    er.next = () => ({
      clusters: [
        { memberIds: [ids[0], ids[1]], kind: "operator", method: "ai", confidence: 0.93, evidence: [{ field: "address", detail: "same suite" }], explanation: "Same forwarding suite.", normalizedKey: "1200 HARBOR BLVD STE 4B 43215" },
      ],
      links: [[ids[0], ids[1]]],
      llmCalls: 1,
      uncertainPairs: 3,
      // C's resolve speaks public labels; an internal id is mapped defensively
      keptApart: [
        { a: pid(2), b: pid(3), reason: "Apt 2 vs Apt 5: different units, different surnames.", confidence: 0.91 },
        { a: ids[0], b: ids[3], reason: "Different cities.", confidence: 0.88 },
      ],
      unreviewedPairs: 0,
      degraded: null,
    });
    try {
      const key = { "x-seller-key": drop.seller_token };
      const res = await (await app.request(`/api/seller/${drop.slug}/analyze`, { method: "POST", headers: key })).json();
      expect(res).toMatchObject({ clusters: 1, llmCalls: 1, uncertainPairs: 3, degraded: null });
      expect(res.keptApart).toEqual([
        { a: pid(2), b: pid(3), reason: "Apt 2 vs Apt 5: different units, different surnames.", confidence: 0.91 },
        { a: pid(0), b: pid(3), reason: "Different cities.", confidence: 0.88 },
      ]);
      const s = await (await app.request(`/api/seller/${drop.slug}`, { headers: key })).json();
      expect(s.ai).toMatchObject({ uncertainPairs: 3, linked: 1, keptApartCount: 2, degraded: null, model: expect.any(String), ranAt: expect.any(Number) });
      expect(s.ai.keptApart).toEqual(res.keptApart);
      expect(s.usage).toMatchObject({ dailyCap: expect.any(Number), today: expect.any(Number) });
      expect(s.clusters).toEqual([
        {
          id: expect.any(String),
          kind: "operator",
          status: "suggested",
          method: "ai",
          confidence: 0.93,
          evidence: [{ field: "address", detail: "same suite" }],
          explanation: "Same forwarding suite.",
          memberIds: [ids[0], ids[1]],
          normalizedKey: "1200 HARBOR BLVD STE 4B 43215",
          createdAt: expect.any(Number),
          appeals: [],
        },
      ]);
      expect(s.drop.pendingReviews).toBe(1);
      expect(JSON.stringify(s.ai)).not.toContain("ent_");
      const ev = (await (await app.request(`/api/drops/${drop.slug}/events`)).json()).events.find((e: { kind: string }) => e.kind === "er_done");
      expect(ev.message).toMatch(/^AI reviewed 3 uncertain pairs in [\d.]+ s: 1 group needs the seller's decision, 2 pairs kept apart\. Nothing merges until the seller confirms\.$/);
    } finally {
      er.next = null;
    }
  });

  it("a degraded review is said plainly (warn tone), never as a success", async () => {
    const drop = await domain.createDrop({ ...domain.SHOWCASE, units: 1, negativeTest: false });
    await enter(drop.slug, "DEG-1");
    await drain();
    er.next = () => ({ clusters: [], links: [], llmCalls: 0, uncertainPairs: 2, keptApart: [], unreviewedPairs: 2, degraded: "AI unavailable: 2 uncertain pairs were not reviewed." });
    try {
      const res = await (await app.request(`/api/seller/${drop.slug}/analyze`, { method: "POST", headers: { "x-seller-key": drop.seller_token } })).json();
      expect(res.degraded).toBe("AI unavailable: 2 uncertain pairs were not reviewed.");
      const ev = (await (await app.request(`/api/drops/${drop.slug}/events`)).json()).events.find((e: { kind: string }) => e.kind === "er_done");
      expect(ev).toMatchObject({ tone: "warn", message: "AI unavailable: 2 uncertain pairs were not reviewed. 0 groups need the seller's decision. Nothing merges until the seller confirms." });
      expect((await (await app.request(`/api/seller/${drop.slug}`, { headers: { "x-seller-key": drop.seller_token } })).json()).ai.degraded).toBe(res.degraded);
    } finally {
      er.next = null;
    }
  });

  it("the original resolve() (no keptApart/degraded fields) still maps its aiDegraded note", async () => {
    const drop = await domain.createDrop({ ...domain.SHOWCASE, units: 1, negativeTest: false });
    await enter(drop.slug, "OLD-1");
    await drain();
    er.next = () => ({ clusters: [], links: [], llmCalls: 0, uncertainPairs: 1, aiDegraded: "AI_API_KEY not configured" });
    try {
      const res = await (await app.request(`/api/seller/${drop.slug}/analyze`, { method: "POST", headers: { "x-seller-key": drop.seller_token } })).json();
      expect(res).toMatchObject({ keptApart: [], degraded: "AI unavailable (AI_API_KEY not configured). Showing rule-only suggestions." });
    } finally {
      er.next = null;
    }
  });
});
