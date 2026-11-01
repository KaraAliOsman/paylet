// P0-02: rate limits key on the real client (CF-Connecting-IP / True-Client-IP, else the proxy's X-Forwarded-For hop),
// Paylet's own agents sign their loopback MCP calls (separate bucket), /mcp answers 429 in JSON-RPC, and the scalper
// swarm retries rate-limited calls and ALWAYS reports. The MCP client runs for real, routed through app.request.
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

let domain: typeof import("../src/server/domain");
let agent: typeof import("../src/server/agent");
let db: typeof import("../src/server/db");
let app: typeof import("../src/server/index")["app"];

beforeAll(async () => {
  installFakeDrand();
  domain = await import("../src/server/domain");
  agent = await import("../src/server/agent");
  db = await import("../src/server/db");
  app = (await import("../src/server/index")).app;
  agent._setMcpFetch(async (url, init) => app.request(String(url), init));
});

const listTools = (headers: Record<string, string>) =>
  app.request("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });

async function exhaust(headers: () => Record<string, string>, n: number) {
  for (let i = 0; i < n; i++) expect((await listTools(headers())).status, `request ${i + 1}`).toBe(200);
}

const lastEvent = (dropId: string, kind: string) =>
  db.db.prepare("SELECT message, data_json FROM events WHERE drop_id = ? AND kind = ? ORDER BY id DESC LIMIT 1").get(dropId, kind) as { message: string; data_json: string | null } | undefined;

describe("P0-02 per-client buckets", () => {
  it("a spoofed X-Forwarded-For does not change the CF-Connecting-IP bucket; the 41st call is a JSON-RPC 429 with Retry-After", async () => {
    const spoof = () => ({ "cf-connecting-ip": "198.51.100.7", "x-forwarded-for": `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` });
    await exhaust(spoof, 40);
    const res = await listTools(spoof());
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    expect(await res.json()).toEqual({ jsonrpc: "2.0", error: { code: -32029, message: "rate_limited" }, id: null });
    // another real client is not affected
    expect((await listTools({ "cf-connecting-ip": "198.51.100.8" })).status).toBe(200);
    // True-Client-IP is honoured the same way
    expect((await listTools({ "true-client-ip": "198.51.100.9" })).status).toBe(200);
  });

  it("without Cloudflare headers the bucket is the proxy's (last) X-Forwarded-For hop: client-prepended hops do not help", async () => {
    await exhaust(() => ({ "x-forwarded-for": `${Math.floor(Math.random() * 250)}.1.1.1, 10.0.0.77` }), 40);
    expect((await listTools({ "x-forwarded-for": "8.8.8.8, 10.0.0.77" })).status).toBe(429);
    expect((await listTools({ "x-forwarded-for": "8.8.8.8, 10.0.0.78" })).status).toBe(200);
  });

  it("the internal token selects its own 300/min bucket; a wrong token gets the public 40/min one", async () => {
    const ip = { "cf-connecting-ip": "203.0.113.5" };
    await exhaust(() => ({ ...ip, [agent.INTERNAL_HEADER]: agent.internalToken() }), 120);
    await exhaust(() => ({ ...ip, [agent.INTERNAL_HEADER]: "0".repeat(64) }), 40);
    expect((await listTools({ ...ip, [agent.INTERNAL_HEADER]: "0".repeat(64) })).status).toBe(429);
    expect((await listTools({ ...ip, [agent.INTERNAL_HEADER]: agent.internalToken() })).status).toBe(200);
    expect(agent.internalToken()).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("P0-02 resilient scalper swarm", () => {
  it("3 swarms at once against 3 judge drops: 36 approval links, 0 holds, and the exact ledger copy", async () => {
    const drops = await Promise.all([1, 2, 3].map(() => domain.createDrop({ ...domain.SHOWCASE, kind: "judge", units: 2 })));
    const before = pp.calls.filter((c) => c.startsWith("create")).length;
    const results = await Promise.all(drops.map((d) => agent.runSwarm(d.slug, 12, { delayMs: 0, backoffMs: [1, 1, 1] })));
    expect(results.map((r) => r.links.length)).toEqual([12, 12, 12]);
    expect(pp.calls.filter((c) => c.startsWith("create")).length - before).toBe(36); // 36 real (fake) PayPal orders
    for (const d of drops) {
      const done = lastEvent(d.id, "swarm_done")!;
      expect(done.message).toBe("12 scalper agents → 12 PayPal approval links · 0 holds. A hold needs a person to approve in PayPal, and only one per PayPal account counts.");
      expect(JSON.parse(done.data_json!).tone).toBeUndefined();
      const pub = await (await app.request(`/api/drops/${d.slug}`)).json();
      expect(pub.stats).toMatchObject({ agents: 12, holds: 0, awaitingPerson: 12 });
    }
  });

  it("retries a rate-limited call (1, 2, 4 s backoff) and still gets every link", async () => {
    const d = await domain.createDrop({ ...domain.SHOWCASE, kind: "judge" });
    let refused = 0;
    agent._setMcpFetch(async (url, init) => {
      const body = typeof init?.body === "string" ? init.body : "";
      if (body.includes('"scalper-bot-03"') && refused < 2) {
        refused++;
        return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32029, message: "rate_limited" }, id: null }), { status: 429, headers: { "content-type": "application/json", "retry-after": "60" } });
      }
      return app.request(String(url), init);
    });
    try {
      const r = await agent.runSwarm(d.slug, 4, { delayMs: 0, backoffMs: [1, 1, 1] });
      expect(refused).toBe(2);
      expect(r.links).toHaveLength(4);
      expect(lastEvent(d.id, "swarm_done")!.message).toMatch(/^4 scalper agents → 4 PayPal approval links · 0 holds\./);
    } finally {
      agent._setMcpFetch(async (url, init) => app.request(String(url), init));
    }
  });

  it("an agent still rate-limited after 3 retries is reported in the warn copy, never as a crash", async () => {
    const d = await domain.createDrop({ ...domain.SHOWCASE, kind: "judge" });
    agent._setMcpFetch(async (url, init) => {
      const body = typeof init?.body === "string" ? init.body : "";
      if (body.includes('"scalper-bot-02"')) return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32029, message: "rate_limited" }, id: null }), { status: 429 });
      return app.request(String(url), init);
    });
    try {
      const r = await agent.runSwarm(d.slug, 12, { delayMs: 0, backoffMs: [1, 1, 1] });
      expect(r).toMatchObject({ rateLimited: 1, failed: 0, closed: 0 });
      const done = lastEvent(d.id, "swarm_done")!;
      expect(done.message).toBe("11 of 12 agents got a PayPal link (1 was rate-limited) · 0 holds.");
      expect(JSON.parse(done.data_json!).tone).toBe("warn");
      const ev = (await (await app.request(`/api/drops/${d.slug}/events`)).json()).events.find((e: { kind: string }) => e.kind === "swarm_done");
      expect(ev.tone).toBe("warn"); // the public ledger carries the tone
    } finally {
      agent._setMcpFetch(async (url, init) => app.request(String(url), init));
    }
  });

  it("a closed drop: the swarm stops early and says why", async () => {
    const d = await domain.createDrop({ ...domain.SHOWCASE, kind: "judge" });
    db.db.prepare("UPDATE drops SET closes_at = ? WHERE id = ?").run(Date.now() - 1000, d.id);
    const r = await agent.runSwarm(d.slug, 12, { delayMs: 0, backoffMs: [1, 1, 1] });
    expect(r).toMatchObject({ closed: 12, rateLimited: 0, failed: 0 });
    expect(lastEvent(d.id, "swarm_done")!.message).toBe("0 of 12 agents got a PayPal link (12 found the drop closed) · 0 holds.");
  });

  it("the swarm endpoint answers at once and the ledger gets swarm_done", async () => {
    const d = await domain.createDrop({ ...domain.SHOWCASE, kind: "judge" });
    const res = await app.request(`/api/seller/${d.slug}/swarm`, { method: "POST", headers: { "x-seller-key": d.seller_token, "content-type": "application/json" }, body: JSON.stringify({ n: 1 }) });
    expect(await res.json()).toEqual({ started: 1 });
    for (let i = 0; i < 100 && !lastEvent(d.id, "swarm_done"); i++) await new Promise((r) => setTimeout(r, 20));
    expect(lastEvent(d.id, "swarm_done")!.message).toMatch(/^1 scalper agent → 1 PayPal approval link · 0 holds\./);
  });
});
