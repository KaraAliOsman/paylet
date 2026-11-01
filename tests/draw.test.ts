// P0-03 draw guards and P2-10 public randomness (drand quicknet, fetch mocked by tests/helpers/fakeDrand.ts):
// freeze → reveal in two phases, the committed round, the next round when drand fails, the seed-only fallback said out
// loud, and the public /verify data that lets anyone recompute the draw.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { pp } from "./helpers/fakePaypal";
import { drand, installFakeDrand } from "./helpers/fakeDrand";

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
let dr: typeof import("../src/server/drand");
let shared: typeof import("../src/shared/draw");
let app: typeof import("../src/server/index")["app"];

beforeAll(async () => {
  installFakeDrand();
  domain = await import("../src/server/domain");
  queue = await import("../src/server/queue");
  models = await import("../src/server/models");
  db = await import("../src/server/db");
  dr = await import("../src/server/drand");
  shared = await import("../src/shared/draw");
  app = (await import("../src/server/index")).app;
});

beforeEach(() => {
  drand.failures.clear();
  drand.down = false;
  drand.calls.length = 0;
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

let payer = 0;
async function dropWithHolds(n: number, opts: { units?: number; kind?: "showcase" | "judge" } = {}) {
  const drop = await domain.createDrop({ ...domain.SHOWCASE, units: opts.units ?? 1, kind: opts.kind ?? "showcase", negativeTest: false });
  const entries: { entryId: string; orderId: string }[] = [];
  for (let i = 0; i < n; i++) {
    const s = await domain.startEntry(drop.slug, "human");
    pp.approve(s.orderId, `DRAW-${++payer}`);
    await domain.finalize(s.orderId);
    entries.push(s);
  }
  await drain();
  return { drop, entries };
}

/** An AI suggestion the seller has not decided yet, over the given entries. */
function suggest(dropId: string, entryIds: string[], kind: "operator" | "household" = "operator") {
  const cid = models.id("clu", 6);
  db.db
    .prepare("INSERT INTO clusters(id, drop_id, kind, status, method, confidence, evidence_json, explanation, member_ids, created_at) VALUES(?, ?, ?, 'suggested', 'ai', 0.9, '[]', 'same suite', ?, ?)")
    .run(cid, dropId, kind, JSON.stringify(entryIds), Date.now());
  return cid;
}

const events = (dropId: string) => db.db.prepare("SELECT kind, message, real, data_json FROM events WHERE drop_id = ? ORDER BY id").all(dropId) as { kind: string; message: string; real: number; data_json: string | null }[];
const drawAs = (slug: string, key: string, body: unknown = {}) =>
  app.request(`/api/seller/${slug}/draw`, { method: "POST", headers: { "x-seller-key": key, "content-type": "application/json" }, body: JSON.stringify(body) });

describe("P0-03 draw guards", () => {
  it("409 pending_reviews while an AI suggestion is undecided, with the exact copy, and the drop stays open", async () => {
    const { drop, entries } = await dropWithHolds(3);
    suggest(drop.id, [entries[0].entryId, entries[1].entryId]);
    const res = await drawAs(drop.slug, drop.seller_token);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "pending_reviews", message: "1 AI suggestion is still pending: 2 accounts would each keep a ticket. Review it first." });
    expect(models.getDrop(drop.id)!.status).toBe("open");
    expect((await (await app.request(`/api/drops/${drop.slug}`)).json()).pendingReviews).toBe(1);
  });

  it("pluralises the copy and ignores suggestions whose members no longer hold a ticket", async () => {
    const { drop, entries } = await dropWithHolds(5);
    suggest(drop.id, [entries[0].entryId, entries[1].entryId]);
    suggest(drop.id, [entries[2].entryId, entries[3].entryId, entries[4].entryId]);
    suggest(drop.id, ["ent_gone_1", "ent_gone_2"]); // members without a ticket: nothing left to decide
    await expect(domain.freeze(drop.id)).rejects.toMatchObject({ code: "pending_reviews", message: "2 AI suggestions are still pending: 5 accounts would each keep a ticket. Review them first." });
  });

  it("a decided suggestion unblocks the draw (dismissed: each keeps a ticket; the ledger says so in plain words)", async () => {
    const { drop, entries } = await dropWithHolds(2);
    const cid = suggest(drop.id, [entries[0].entryId, entries[1].entryId]);
    domain.decideCluster(drop.id, cid, "dismissed");
    expect(events(drop.id).at(-1)!.message).toBe("Seller dismissed the suggested reseller network of 2 PayPal accounts: each keeps its own ticket.");
    const res = await drawAs(drop.slug, drop.seller_token);
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("frozen");
    await domain.whenRevealed(drop.id);
    expect(models.getDrop(drop.id)!.status).not.toBe("open");
  });

  it("force skips the review on a seller's own drop, and the ledger says the suggestions were not reviewed", async () => {
    const { drop, entries } = await dropWithHolds(2);
    suggest(drop.id, [entries[0].entryId, entries[1].entryId]);
    const res = await drawAs(drop.slug, drop.seller_token, { force: true });
    expect(res.status).toBe(200);
    await domain.whenRevealed(drop.id);
    const warn = events(drop.id).find((e) => e.kind === "review_skipped")!;
    expect(warn.message).toBe("The seller drew without reviewing. 1 AI suggestion was not reviewed before the draw, so those 2 accounts keep their own tickets.");
    expect(JSON.parse(warn.data_json!).tone).toBe("warn");
  });

  it("judge drops never accept force: the review comes first", async () => {
    const { drop, entries } = await dropWithHolds(2, { kind: "judge" });
    suggest(drop.id, [entries[0].entryId, entries[1].entryId]);
    const res = await drawAs(drop.slug, drop.seller_token, { force: true });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("pending_reviews");
    expect(body.message).toMatch(/Judge drops can't skip the review\.$/);
    expect(models.getDrop(drop.id)!.status).toBe("open");
  });

  it("409 no_eligible_entries on a drop where nobody holds a ticket (agent links without a person do not count)", async () => {
    const drop = await domain.createDrop({ ...domain.SHOWCASE, units: 1 });
    await domain.startEntry(drop.slug, "agent", "scalper-bot-01"); // approval link, no hold
    const res = await drawAs(drop.slug, drop.seller_token);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("no_eligible_entries");
    expect(models.getDrop(drop.id)!.status).toBe("open");
  });

  it("409 holds_pending while PayPal is still placing a hold", async () => {
    const drop = await domain.createDrop({ ...domain.SHOWCASE, units: 1 });
    const s = await domain.startEntry(drop.slug, "human");
    pp.approve(s.orderId, `DRAW-${++payer}`);
    await domain.finalize(s.orderId); // authorizing: the authorize op is queued, not run
    const res = await drawAs(drop.slug, drop.seller_token);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("holds_pending");
    await drain();
  });

  it("closing time: an empty drop settles with nothing to draw; pending reviews get a grace period, then the draw says so", async () => {
    const empty = await domain.createDrop({ ...domain.SHOWCASE, units: 1, kind: "judge" });
    const agent = await domain.startEntry(empty.slug, "agent", "scalper-bot-01");
    db.db.prepare("UPDATE drops SET closes_at = ? WHERE id = ?").run(Date.now() - 1000, empty.id);

    const { drop, entries } = await dropWithHolds(3, { kind: "judge" });
    suggest(drop.id, [entries[0].entryId, entries[1].entryId]);
    db.db.prepare("UPDATE drops SET closes_at = ? WHERE id = ?").run(Date.now() - 1000, drop.id);

    await domain.sweep();
    expect(models.getDrop(empty.id)!.status).toBe("settled");
    expect(models.getEntry(agent.entryId)!).toMatchObject({ status: "expired", note: "No person approved in PayPal: no hold was placed." });
    expect(events(empty.id).at(-1)!.message).toBe("Closing time: nobody held a ticket, so there was nothing to draw. Nobody was charged.");
    expect(models.getDrop(drop.id)!.status).toBe("open"); // the seller still has REVIEW_GRACE_MS to decide

    db.db.prepare("UPDATE drops SET closes_at = ? WHERE id = ?").run(Date.now() - domain.REVIEW_GRACE_MS - 1000, drop.id);
    await domain.sweep();
    await domain.whenRevealed(drop.id);
    await drain();
    expect(models.getDrop(drop.id)!.status).toBe("settled");
    expect(events(drop.id).find((e) => e.kind === "review_skipped")!.message).toMatch(/^Closing time: drawn automatically\. 1 AI suggestion was not reviewed before the draw/);
  });

  it("proof drops are never drawn automatically", async () => {
    const drop = await domain.createDrop({ ...domain.SHOWCASE, units: 1, kind: "proof" });
    db.db.prepare("UPDATE drops SET closes_at = ? WHERE id = ?").run(Date.now() - 60 * 60_000, drop.id);
    await domain.sweep();
    expect(models.getDrop(drop.id)!.status).toBe("open");
  });
});

describe("P2-10 drand: freeze, then reveal with public randomness", () => {
  it("commits a future round at the freeze, keeps the seed secret until the reveal, and the draw follows SHA-256(seed:randomness)", async () => {
    const { drop } = await dropWithHolds(4, { units: 2 });
    const t = Date.now();
    const f = await domain.freeze(drop.id);
    expect(f.status).toBe("frozen");
    expect(f.round).toBe(Math.floor((t + 6000) / 1000 / 3 - 1692803367 / 3) + 1);
    expect(dr.roundTime(f.round!)).toBeGreaterThan(t); // published after the freeze
    expect(dr.roundTime(f.round!)).toBeLessThanOrEqual(t + 6100);

    const frozen = await (await app.request(`/api/drops/${drop.slug}`)).json();
    expect(frozen).toMatchObject({ status: "frozen", seed: null, finalSeed: null });
    expect(frozen.frozenList).toHaveLength(4);
    expect(frozen.randomness).toEqual({
      source: "drand-quicknet",
      round: f.round,
      value: null,
      chainHash: "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971",
      url: `https://api.drand.sh/52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971/public/${f.round}`,
    });
    // the sweeper must not release the held entries of a frozen drop: they are the ballot
    await domain.sweep();
    expect(models.listEntries(drop.id).filter((e) => e.status === "held")).toHaveLength(4);

    const r = (await domain.scheduleReveal(drop.id))!;
    await drain();
    expect(drand.calls[0]).toBe(frozen.randomness.url);
    const d = await (await app.request(`/api/drops/${drop.slug}`)).json();
    expect(d.randomness.value).toBe(drand.valueOf(f.round!));
    expect(d.seed).toMatch(/^[0-9a-f]{64}$/);
    // what a browser does on /verify
    expect(await shared.sha256Hex(d.seed)).toBe(d.seedHash);
    expect(await shared.sha256Hex(shared.canonicalList(d.frozenList))).toBe(d.frozenHash);
    const finalSeed = await shared.sha256Hex(`${d.seed}:${d.randomness.value}`);
    expect(d.finalSeed).toBe(finalSeed);
    const again = await shared.computeDraw(finalSeed, d.frozenList, d.units, d.waitlistSize);
    expect(r.winners).toEqual(again.winners);
    expect(r.waitlist).toEqual(again.waitlist);

    const msgs = events(drop.id).map((e) => e.message);
    expect(msgs).toContain(`Randomness: League of Entropy drand round ${f.round!.toLocaleString("en-US")}, published after the list was frozen. Not even Paylet knew the winners in advance.`);
    expect(msgs.find((m) => m.startsWith("List frozen:"))).toMatch(/^List frozen: 4 eligible entries \(SHA-256 [0-9a-f]{12}…\)\. The winners come from drand round [\d,]+, published about \d s from now, after the freeze\.$/);
  });

  it("if a round can't be fetched after 3 tries, the next round is used and the ledger warns", async () => {
    const { drop } = await dropWithHolds(3);
    const f = await domain.freeze(drop.id);
    drand.failures.set(f.round!, 3);
    await domain.scheduleReveal(drop.id);
    const d = models.getDrop(drop.id)!;
    expect(d.status).not.toBe("frozen");
    expect(d.randomness_round).toBe(f.round! + 1);
    expect(d.randomness_value).toBe(drand.valueOf(f.round! + 1));
    expect(drand.calls.slice(0, 3).map((u) => new URL(u).host)).toEqual(["api.drand.sh", "api2.drand.sh", "drand.cloudflare.com"]);
    const warn = events(drop.id).find((e) => e.kind === "drand_next_round")!;
    expect(warn.message).toMatch(/could not be fetched after 3 tries, so the draw uses the next round/);
    expect(JSON.parse(warn.data_json!).tone).toBe("warn");
    await drain();
  });

  it("drand down: the list stays frozen (warned once); after 15 minutes the draw falls back to the seed alone, said out loud", async () => {
    const { drop } = await dropWithHolds(2);
    await domain.freeze(drop.id);
    drand.down = true;
    expect(await domain.scheduleReveal(drop.id)).toBeNull();
    expect(models.getDrop(drop.id)!.status).toBe("frozen");
    expect(events(drop.id).filter((e) => e.kind === "drand_unreachable")).toHaveLength(1);

    db.db.prepare("UPDATE drops SET frozen_at = ? WHERE id = ?").run(Date.now() - domain.DRAND_GIVE_UP_MS - 1000, drop.id);
    await domain.scheduleReveal(drop.id);
    await drain();
    const d = await (await app.request(`/api/drops/${drop.slug}`)).json();
    expect(d.status).toBe("settled");
    expect(d.randomness).toBeNull();
    expect(d.finalSeed).toBeNull();
    expect(events(drop.id).find((e) => e.kind === "drand_fallback")!.message).toMatch(/uses the committed seed alone\. That is weaker/);
    const again = await shared.computeDraw(d.seed, d.frozenList, d.units, d.waitlistSize);
    const winner = models.listEntries(drop.id).find((e) => e.status === "captured")!;
    expect(again.winners).toEqual([winner.public_id]);
  });

  it("/verify lists every frozen entry's recorded outcome and every exclusion with its reason", async () => {
    const drop = await domain.createDrop({ ...domain.SHOWCASE, units: 1, negativeTest: true });
    const ids: { entryId: string }[] = [];
    for (const p of ["V-A", "V-B", "V-C", "V-D", "V-A"]) {
      const s = await domain.startEntry(drop.slug, "human");
      pp.approve(s.orderId, `${p}-${payer}`);
      await domain.finalize(s.orderId);
      ids.push(s);
    }
    await drain();
    const cid = suggest(drop.id, [ids[2].entryId, ids[3].entryId], "household");
    domain.decideCluster(drop.id, cid, "confirmed");
    expect(events(drop.id).at(-1)!.message).toBe("Seller confirmed a household of 2 PayPal accounts: they now share one ticket.");
    await domain.draw(drop.id);
    await drain();
    const v = await (await app.request(`/api/drops/${drop.slug}/verify`)).json();
    expect(v.status).toBe("settled");
    expect(v.frozenList).toHaveLength(3); // A, B and the household's first entry
    const pid = (i: number) => models.getEntry(ids[i].entryId)!.public_id;
    expect(v.excluded).toEqual(expect.arrayContaining([{ publicId: pid(3), reason: "merged" }, { publicId: pid(4), reason: "duplicate" }]));
    expect(v.outcome.map((o: { publicId: string }) => o.publicId).sort()).toEqual([...v.frozenList].sort());
    const failed = v.outcome.find((o: { status: string }) => o.status === "capture_failed");
    expect(failed.note).toMatch(/negative test/);
    expect(v.outcome.filter((o: { status: string }) => o.status === "captured")).toHaveLength(1);
    expect(v.randomness.value).toBe(drand.valueOf(v.randomness.round));
    expect(await (await app.request(`/api/drops/${drop.slug}/verify-data`)).json()).toEqual(v);
    // merged entries got a templated, PII-free explanation
    expect(models.getEntry(ids[3].entryId)!.explanation).toMatch(/^The seller confirmed that this PayPal account belongs to the same household as 1 other entry/);
  });
});
