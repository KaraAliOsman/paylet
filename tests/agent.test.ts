// P0-04 / P2-02 / P0-10: Wren tells the truth about money (post-filter, deterministic first line, honest error reply),
// hands off to the person (handoff object), answers "how did it go" from entry_status alone, and list_drops only shows
// public drops. The model is scripted (vi.mock of ai.chat); the MCP client is real, routed through app.request.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { pp } from "./helpers/fakePaypal";
import { installFakeDrand } from "./helpers/fakeDrand";

vi.hoisted(() => {
  process.env.PAYPAL_OPS_PER_MINUTE = "100000";
});
vi.mock("../src/server/paypal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/server/paypal")>()),
  ...(await import("./helpers/fakePaypal")).fakeApi,
}));
const script = vi.hoisted(() => ({ replies: [] as (Record<string, unknown> | Error)[] }));
vi.mock("../src/server/ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/server/ai")>()),
  chat: vi.fn(async () => {
    const next = script.replies.shift();
    if (!next || next instanceof Error) throw next ?? new Error("no scripted reply");
    return next;
  }),
}));

let domain: typeof import("../src/server/domain");
let agent: typeof import("../src/server/agent");
let queue: typeof import("../src/server/queue");
let models: typeof import("../src/server/models");
let app: typeof import("../src/server/index")["app"];

beforeAll(async () => {
  installFakeDrand();
  domain = await import("../src/server/domain");
  agent = await import("../src/server/agent");
  queue = await import("../src/server/queue");
  models = await import("../src/server/models");
  app = (await import("../src/server/index")).app;
  agent._setMcpFetch(async (url, init) => app.request(String(url), init));
});

beforeEach(() => {
  script.replies.length = 0;
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

const toolCall = (name: string, args: Record<string, unknown>) => ({
  role: "assistant",
  content: null,
  tool_calls: [{ id: `call_${Math.random().toString(36).slice(2, 8)}`, type: "function", function: { name, arguments: JSON.stringify(args) } }],
});
const say = (content: string) => ({ role: "assistant", content });
const chat = async (content: string) =>
  (await (await app.request("/api/agent/chat", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": `192.0.2.${Math.floor(Math.random() * 250)}` }, body: JSON.stringify({ messages: [{ role: "user", content }] }) })).json()) as import("../src/server/agent").AgentTurn;
const mcp = async (name: string, args: Record<string, unknown>) =>
  (await (
    await app.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "cf-connecting-ip": "192.0.2.200" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    })
  ).json()) as { result: { structuredContent?: Record<string, any>; isError?: boolean; content: { text: string }[] } };

describe("P0-04 Wren's reply filter", () => {
  it("removes markdown links, URLs, PayPal links, markdown decoration and emojis", () => {
    const out = agent.cleanReply(
      "**Done!** 🎉 Approve it here: [Approve in PayPal](https://www.sandbox.paypal.com/checkoutnow?token=5O190127TN364715T) or https://www.sandbox.paypal.com/x 🛍️\n# Next\n* Draw at 6 PM ✅",
      { holdConfirmed: true },
    );
    expect(out).not.toMatch(/https?:|paypal\.com|\*\*|\]\(|#|🎉|🛍|✅/);
    expect(out).toContain("Done!");
    expect(out).toContain("Approve it here: Approve in PayPal");
    expect(out).not.toMatch(/\bor\s*$/m);
    expect(out).toContain("- Draw at 6 PM");
  });

  it("never says \"you're in\" before a hold exists, and never says the hold is only placed if you win", () => {
    expect(agent.cleanReply("You're in! 🎉 Good luck.")).toBe(agent.HONEST_ENTRY);
    expect(agent.cleanReply("You’re all set for the drop.")).toBe(agent.HONEST_ENTRY);
    expect(agent.cleanReply("You are entered.")).toBe(agent.HONEST_ENTRY);
    expect(agent.cleanReply("You're in the ballot.", { holdConfirmed: true })).toBe("You're in the ballot.");
    expect(agent.cleanReply("The $77.00 hold is only placed if you win. Good luck!")).toBe("PayPal places the hold when you approve; you're only charged if you win. Good luck!");
    expect(agent.cleanReply("You're interested in Tidepool?")).toBe("You're interested in Tidepool?");
  });

  it("the system prompt carries the literal money and honesty rules", () => {
    expect(agent.SYSTEM).toContain(`Never say the person is "in", "entered" or "all set". Say: "I've requested your entry. It only counts once you approve the hold in PayPal."`);
    expect(agent.SYSTEM).toContain(`Describe money exactly like this: "PayPal places a $X hold when you approve. You're only charged if you win (price + actual shipping); if you don't, the hold is voided."`);
    expect(agent.SYSTEM).toContain("Never paste URLs; the app shows the PayPal button. No emojis. No markdown links.");
  });
});

describe("P0-04 / P2-02 Wren over MCP", () => {
  it("enters by drop URL, opens with the deterministic line, hands off to the person, never claims a hold", async () => {
    const drop = await domain.createDrop({ ...domain.SHOWCASE, kind: "judge" });
    script.replies.push(
      toolCall("enter_drop", { drop: `https://paylet.onrender.com/d/${drop.slug}` }),
      say("You're in! 🎉 Approve here: [PayPal](https://www.sandbox.paypal.com/checkoutnow?token=ABC). It's only placed if you win."),
    );
    const r = await chat(`Get me into this drop: https://paylet.onrender.com/d/${drop.slug}`);
    expect(r.error).toBeUndefined();
    const e = models.listEntries(drop.id).find((x) => x.source === "agent")!;
    expect(e).toMatchObject({ agent_label: "Wren (fan's assistant)", status: "awaiting_person" });
    expect(r.handoff).toEqual({
      entryRef: e.id,
      publicId: e.public_id,
      title: "Tidepool",
      holdCents: 7700,
      approveUrl: e.approve_url,
      expiresAt: expect.any(Number),
    });
    // the approval must happen before the drop closes (here sooner than PayPal's 3-hour link lifetime)
    expect(Math.abs(r.handoff!.expiresAt - Math.min(e.created_at + 3 * 60 * 60_000, drop.closes_at))).toBeLessThan(1000);
    expect(r.approveUrl).toBe(e.approve_url); // v1 field, still sent
    expect(r.reply).toBe(`Requested entry ${e.public_id} in "Tidepool". Approve the $77.00 hold in PayPal; you're only charged if you win.\n\n${agent.HONEST_ENTRY}`);
    expect(r.reply).not.toMatch(/https?:|🎉|\[/);
    expect(r.trace).toEqual([{ tool: "enter_drop", summary: `enter_drop(${drop.slug}) → awaiting_person`, raw: expect.objectContaining({ args: expect.any(Object) }) }]);
  });

  it("model unreachable before anything happened: the honest error reply (HTTP 200, error: true)", async () => {
    script.replies.push(new Error("AI HTTP 503"));
    const r = await chat("What drops are open?");
    expect(r).toEqual({ reply: "I couldn't reach Paylet just now. Nothing was requested or charged. Try again.", trace: [], handoff: null, error: true });
  });

  it("model fails AFTER the entry was requested: says what happened (the entry exists), no error flag", async () => {
    const drop = await domain.createDrop({ ...domain.SHOWCASE, kind: "judge" });
    script.replies.push(toolCall("enter_drop", { drop: drop.slug }), new Error("AI HTTP 500"));
    const r = await chat(`enter me in ${drop.slug}`);
    expect(r.error).toBeUndefined();
    expect(r.handoff?.title).toBe("Tidepool");
    expect(r.reply).toMatch(/^Requested entry E-\w+ in "Tidepool"\. Approve the \$77\.00 hold in PayPal; you're only charged if you win\.$/);
  });

  it("list_drops never lists judge drops (P0-10); trace summaries are chips", async () => {
    const judge = await domain.createDrop({ ...domain.SHOWCASE, title: "Private Judge Mug", kind: "judge" });
    const show = await domain.ensureShowcase();
    const listed = (await mcp("list_drops", {})).result.structuredContent!.drops as { drop: string }[];
    expect(listed.map((d) => d.drop)).toContain(show.slug);
    expect(listed.map((d) => d.drop)).not.toContain(judge.slug);
    script.replies.push(toolCall("list_drops", {}), say("Tidepool is open."));
    const r = await chat("What drops are open?");
    expect(r.trace[0].summary).toBe(`list_drops → ${listed.length} drop${listed.length === 1 ? "" : "s"}`);
    expect(r.handoff).toBeNull();
  });

  it("enter_drop accepts a drop URL and returns title + expiry; entry_status adds paypal_state", async () => {
    const drop = await domain.createDrop({ ...domain.SHOWCASE, kind: "judge" });
    const out = (await mcp("enter_drop", { drop: `http://localhost:8790/d/${drop.slug}?ref=x`, agent_name: "my-agent" })).result.structuredContent!;
    expect(out).toMatchObject({ title: "Tidepool", status: "awaiting_person", hold_usd: 77 });
    expect(Date.parse(out.expires_at)).toBeLessThanOrEqual(drop.closes_at);
    const st = (await mcp("entry_status", { entry_ref: out.entry_ref })).result.structuredContent!;
    expect(st).toMatchObject({ status: "awaiting_person", paypal_state: null, title: "Tidepool", drop_status: "open" });
  });
});

describe("P2-02 Ask Wren how it went (deterministic, from entry_status)", () => {
  const ask = async (entryRef: string) => app.request("/api/agent/how-it-went", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ entryRef }) });

  it("winner: captured + released; loser: voided, $0; and statuses before the draw", async () => {
    const drop = await domain.createDrop({ ...domain.SHOWCASE, units: 1, negativeTest: false });
    const fans: { entryId: string }[] = [];
    for (const p of ["HOW-A", "HOW-B"]) {
      const s = await domain.startEntry(drop.slug, "agent", "Wren (fan's assistant)");
      pp.approve(s.orderId, p);
      await domain.finalize(s.orderId);
      fans.push(s);
    }
    const waiting = await domain.startEntry(drop.slug, "agent", "Wren (fan's assistant)");
    await drain();
    expect(await (await ask(waiting.entryId)).json()).toEqual({
      reply: "You haven't approved the hold in PayPal yet, so the entry doesn't count. Approve it before the drop closes.",
      status: "awaiting_person",
      trace: [expect.objectContaining({ tool: "entry_status" })],
    });
    expect((await (await ask(fans[0].entryId)).json()).reply).toMatch(/^No draw yet\. Your \$77\.00 hold is in place; the draw is in \d+ minutes\. You're only charged if you win\.$/);

    await domain.draw(drop.id);
    await drain();
    const won = fans.map((f) => models.getEntry(f.entryId)!).find((e) => e.status === "captured")!;
    const lost = fans.map((f) => models.getEntry(f.entryId)!).find((e) => e.status !== "captured")!;
    expect(await (await ask(won.id)).json()).toMatchObject({ reply: "You got one. PayPal captured $72.50 and released $4.50 of your hold.", status: "captured" });
    expect(await (await ask(lost.id)).json()).toMatchObject({ reply: "Not selected. PayPal voided your $77.00 hold. Charged: $0.", status: "voided" });
    expect((await ask("ent_does_not_exist")).status).toBe(404);
  });

  it("every other outcome reads from the ledger, never from a model", () => {
    const base = { public_id: "E-TEST1", hold_usd: 48, captured_usd: null, refunded_usd: null };
    expect(agent.describeOutcome({ ...base, status: "shipped", captured_usd: 44.5, shipping: { carrier: "USPS", tracking: "9400100000123456781234" } })).toBe(
      "You got one. PayPal captured $44.50 and released $3.50 of your hold. It's on its way: USPS tracking ending 1234 (also in your PayPal account).",
    );
    expect(agent.describeOutcome({ ...base, status: "refunded", captured_usd: 44.5, refunded_usd: 44.5 })).toBe("You got one, then the maker refunded $44.50 through PayPal. You owe nothing.");
    expect(agent.describeOutcome({ ...base, status: "merged" })).toMatch(/shared one ticket\. PayPal voided your \$48\.00 hold\. Charged: \$0\.$/);
    expect(agent.describeOutcome({ ...base, status: "capture_failed" })).toMatch(/payment didn't go through.*Charged: \$0\.$/);
    expect(agent.describeOutcome({ ...base, status: "duplicate", hold_usd: null })).toBe("That PayPal account already had an entry in this drop, so no second hold was placed. Charged: $0.");
    expect(agent.describeOutcome({ ...base, status: "held", drop_status: "frozen" })).toMatch(/^The list is frozen and your \$48\.00 hold is in it/);
    expect(agent.describeOutcome({ ...base, status: "expired", hold_usd: null })).toMatch(/no entry\. Charged: \$0\.$/);
  });
});
