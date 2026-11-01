// End-to-end domain flow with PayPal replaced by a stateful fake (no network):
// duplicate account → no hold, failed capture → waitlist promotion, losers voided, webhook signature enforced, MCP reachable.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { pp } from "./helpers/fakePaypal";

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
