// P1-04 proof drop: owner-only creation, masked PII-free export, idempotent import at boot, the recorded PayPal check,
// /api/proof; and P1-06's GET /api/judge-buyers (code-gated, from the environment only). Fake credentials only.
import { mkdirSync, writeFileSync } from "node:fs";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { pp } from "./helpers/fakePaypal";
import { installFakeDrand } from "./helpers/fakeDrand";

vi.hoisted(() => {
  process.env.PAYPAL_OPS_PER_MINUTE = "100000";
  process.env.SELLER_ADMIN_KEY = "test-owner-key-0123456789";
  process.env.JUDGE_CODE = "judge-test-code";
  process.env.BUYER_EMAIL = "sb-fake-buyer@personal.example.com";
  process.env.BUYER_PASSWORD = "not-a-real-password";
});
vi.mock("../src/server/paypal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/server/paypal")>()),
  ...(await import("./helpers/fakePaypal")).fakeApi,
}));

let domain: typeof import("../src/server/domain");
let queue: typeof import("../src/server/queue");
let models: typeof import("../src/server/models");
let proof: typeof import("../src/server/proof");
let shared: typeof import("../src/shared/draw");
let app: typeof import("../src/server/index")["app"];

beforeAll(async () => {
  installFakeDrand();
  domain = await import("../src/server/domain");
  queue = await import("../src/server/queue");
  models = await import("../src/server/models");
  proof = await import("../src/server/proof");
  shared = await import("../src/shared/draw");
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
const json = (r: Response) => r.json() as Promise<any>;
const owner = { "x-seller-key": "test-owner-key-0123456789", "content-type": "application/json" };

/** What scripts/proof-run.ts does, with the fake PayPal: agent entry + approval, same account again, draw, ship. */
async function proofRun() {
  const { slug, sellerKey } = await json(await app.request("/api/judge-drop", { method: "POST", headers: owner, body: JSON.stringify({ kind: "proof", units: 1 }) }));
  const key = { "x-seller-key": sellerKey, "content-type": "application/json" };
  const a = await domain.startEntry(slug, "agent", "fan's MCP agent");
  pp.approve(a.orderId, "PROOF-BUYER");
  await domain.finalize(a.orderId);
  const b = await domain.startEntry(slug, "human");
  pp.approve(b.orderId, "PROOF-BUYER");
  await domain.finalize(b.orderId);
  await domain.startEntry(slug, "agent", "scalper-bot-01");
  await drain();
  expect((await app.request(`/api/seller/${slug}/draw`, { method: "POST", headers: key, body: "{}" })).status).toBe(200);
  await domain.whenRevealed(models.getDrop(slug)!.id);
  await drain();
  expect((await app.request(`/api/seller/${slug}/entries/${a.entryId}/ship`, { method: "POST", headers: key, body: JSON.stringify({ carrier: "USPS" }) })).status).toBe(200);
  await drain();
  return { slug, key, a, b };
}

describe("P1-04 proof drop", () => {
  it("only the owner key creates one; it never closes or draws by itself", async () => {
    const anon = await json(await app.request("/api/judge-drop", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.90" }, body: JSON.stringify({ kind: "proof" }) }));
    expect(models.getDrop(anon.slug)!.kind).toBe("judge"); // without the owner key: an ordinary judge drop
    const { slug } = await json(await app.request("/api/judge-drop", { method: "POST", headers: owner, body: JSON.stringify({ kind: "proof" }) }));
    const d = models.getDrop(slug)!;
    expect(d).toMatchObject({ kind: "proof", units: 1, negative_test: 0 });
    expect(d.closes_at - Date.now()).toBeGreaterThan(23 * 60 * 60_000);
  });

  it("export is masked and PII-free; import recreates the same public drop; /verify, report and Ask PayPal still work", async () => {
    const { slug, key, a, b } = await proofRun();
    expect((await app.request(`/api/seller/${slug}/export`, { headers: { "x-seller-key": "wrong" } })).status).toBe(403);
    const res = await app.request(`/api/seller/${slug}/export`, { headers: key });
    expect(res.status).toBe(200);
    const text = await res.text();
    const snap = JSON.parse(text) as import("../src/server/proof").ProofSnapshot;
    // nothing private: no full PayPal ids, internal ids, emails or names
    const e = models.getEntry(a.entryId)!;
    for (const secret of [a.orderId, b.orderId, a.entryId, b.entryId, e.authorization_id!, e.capture_id!, e.email!, e.name!, e.tracking_number!, "PROOF-BUYER"]) expect(text).not.toContain(secret);
    expect(proof.auditSnapshot(text)).toEqual([]);
    const winner = snap.entries.find((x) => x.status === "captured")!;
    expect(winner).toMatchObject({ authorization: `…${e.authorization_id!.slice(-4)}`, shipping: { carrier: "USPS", tracking: `…${e.tracking_number!.slice(-4)}` }, capturedCents: 4450, holdCents: 4800 }); // $38 + $6.50 actual shipping, of a $48 hold
    expect(snap.entries.find((x) => x.status === "duplicate")!.holdCents).toBeNull();
    expect(snap.paypalCheck!.totals).toMatchObject({ captured: 1, voided: 0, mismatches: 0 });
    expect(snap.events.find((x) => x.kind === "captured")!.trace).toMatchObject({ endpoint: expect.stringMatching(/\/capture$/), httpStatus: 201 });
    expect(snap.drop.randomnessValue).toMatch(/^[0-9a-f]{64}$/);

    // the import (a fresh deploy): same public data under the same slug
    const copy = { ...snap, drop: { ...snap.drop, slug: `${slug}-copy` } };
    const imported = proof.importProof(copy)!;
    expect(imported).toMatchObject({ kind: "proof", status: "settled" });
    expect(proof.importProof(copy)!.id).toBe(imported.id); // idempotent
    const before = await json(await app.request(`/api/drops/${slug}`));
    const after = await json(await app.request(`/api/drops/${slug}-copy`));
    for (const k of ["seedHash", "seed", "frozenHash", "frozenList", "finalSeed", "stats", "randomness", "status"]) expect(after[k]).toEqual(before[k]);
    expect(after.kind).toBe("proof");
    const r1 = await json(await app.request(`/api/drops/${slug}/report`));
    const r2 = await json(await app.request(`/api/drops/${slug}-copy/report`));
    expect(r2).toEqual(r1);
    const v = await json(await app.request(`/api/drops/${slug}-copy/verify`));
    const final = await shared.sha256Hex(`${v.seed}:${v.randomness.value}`);
    expect(final).toBe(v.finalSeed);
    expect((await shared.computeDraw(final, v.frozenList, v.units, v.waitlistSize)).winners).toEqual([winner.publicId]);
    const evs = (await json(await app.request(`/api/drops/${slug}-copy/events`))).events;
    expect(evs.find((x: { kind: string }) => x.kind === "captured").trace.httpStatus).toBe(201);
    // Ask PayPal on an import answers with what PayPal said during the run (masked ids cannot be re-queried)
    const ask = await json(await app.request(`/api/drops/${slug}-copy/paypal-check`, { headers: { "cf-connecting-ip": "192.0.2.91" } }));
    expect(ask).toMatchObject({ recorded: true, cached: true, checkedAt: snap.paypalCheck!.checkedAt, totals: { captured: 1, voided: 0, mismatches: 0 } });
    expect(pp.calls.filter((c) => c.includes("…"))).toEqual([]); // no PayPal call with a masked id
  });

  it("boot import is idempotent; /api/proof summarises the run", async () => {
    const { slug, key } = await proofRun();
    const snap = await json(await app.request(`/api/seller/${slug}/export`, { headers: key }));
    // simulate a wiped database: only the snapshot remains (other proof drops in this test DB are retired first)
    (await import("../src/server/db")).db.prepare("UPDATE drops SET kind = 'judge' WHERE kind = 'proof'").run();
    mkdirSync("data/test", { recursive: true });
    const path = "data/test/proof-run.test.json";
    writeFileSync(path, JSON.stringify({ ...snap, drop: { ...snap.drop, slug: "ember-glaze-mug-proof" } }));
    const first = proof.ensureProofDrop(path)!;
    expect(first.slug).toBe("ember-glaze-mug-proof");
    expect(proof.ensureProofDrop(path)!.id).toBe(first.id);
    const info = await json(await app.request("/api/proof"));
    expect(info.slug).toBe("ember-glaze-mug-proof");
    expect(info.checkedAt).toBe(snap.paypalCheck.checkedAt);
    expect(info.summary).toMatch(/^A real PayPal sandbox run \(\w{3} \d+, \d{4}\): 3 real PayPal orders · 2 agent requests → 0 holds without a person · 1 same-account duplicate blocked · partial capture \$44\.50 \(\$3\.50 of the hold released\) · tracking added in PayPal · \$0\.00 charged to anyone who lost\. Every hold checked with PayPal at \d{4}-\d\d-\d\d \d\d:\d\d UTC\.$/);
  });

  it("the audit rejects emails, full PayPal ids and internal ids", () => {
    expect(proof.auditSnapshot('{"a":"buyer@example.com"}')).toEqual(["an email address"]);
    expect(proof.auditSnapshot('{"a":"5O190127TN364715T"}')[0]).toMatch(/full PayPal-like id/);
    expect(proof.auditSnapshot('{"a":"ent_0123456789abcdef"}')).toEqual(["an internal entry id"]);
    expect(proof.auditSnapshot('{"a":"…715T","b":"E-7K2Q9","c":"0123456789abcdef0123456789abcdef"}')).toEqual([]);
    expect(() => proof.importProof({ version: 1, drop: { slug: "x" }, entries: [{ note: "mail me at a@b.co" }] } as never)).toThrow(/rejected/);
  });
});

describe("P1-06 GET /api/judge-buyers", () => {
  it("404 without the right code; the sandbox buyer from the environment with it; never cached", async () => {
    const ask = (q: string) => app.request(`/api/judge-buyers${q}`, { headers: { "cf-connecting-ip": "192.0.2.95" } });
    expect((await ask("")).status).toBe(404);
    expect((await ask("?code=wrong-code")).status).toBe(404);
    const ok = await ask("?code=judge-test-code");
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(await ok.json()).toEqual({ buyers: [{ label: "Sandbox buyer", email: "sb-fake-buyer@personal.example.com", password: "not-a-real-password" }] });
  });

  it("is rate limited (no brute-forcing the code)", async () => {
    const ask = () => app.request("/api/judge-buyers?code=guess", { headers: { "cf-connecting-ip": "192.0.2.96" } });
    for (let i = 0; i < 10; i++) expect((await ask()).status).toBe(404);
    expect((await ask()).status).toBe(429);
  });
});
