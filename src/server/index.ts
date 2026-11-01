import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { db, getSetting, now, setSetting } from "./db";
import { env } from "./env";
import {
  HttpError,
  addSimulatedCrowd,
  analyzeDrop,
  createDrop,
  decideCluster,
  draw,
  ensureShowcase,
  fileAppeal,
  finalize,
  handlers,
  listClusters,
  participantView,
  publicDrop,
  startEntry,
  sweep,
} from "./domain";
import { emit, getDrop, getEntry, listEntries, type DropRow } from "./models";
import { classify, ensureWebhook, verifyWebhookSignature } from "./paypal";
import { pendingOps, startWorker } from "./queue";
import { handleMcp } from "./mcp";
import { runFanAgent, runSwarm } from "./agent";
import { aiConfigured, usageSummary } from "./ai";

const app = new Hono();

const judgeQuota = new Map<string, { n: number; reset: number }>();

// ---------------------------------------------------------------- tiny per-IP rate limiter
const buckets = new Map<string, { n: number; reset: number }>();
/** Client IP: the LAST X-Forwarded-For hop is the one added by the hosting proxy (earlier hops are client-controlled). */
function clientIp(c: Context): string {
  const hops = (c.req.header("x-forwarded-for") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return hops.at(-1) ?? "local";
}
function limit(c: Context, key: string, perMinute: number): boolean {
  const ip = clientIp(c);
  if (buckets.size > 20_000) for (const [k, v] of buckets) if (v.reset < Date.now()) buckets.delete(k);
  const k = `${key}:${ip}`;
  const b = buckets.get(k);
  const t = Date.now();
  if (!b || b.reset < t) {
    buckets.set(k, { n: 1, reset: t + 60_000 });
    return true;
  }
  b.n++;
  return b.n <= perMinute;
}

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.code, message: err.message }, err.status as 400);
  const f = classify(err);
  console.error("[error]", c.req.method, c.req.path, f.status, f.issue, f.debugId ?? "", err instanceof Error ? err.message : "");
  if (f.status) return c.json({ error: "paypal_error", issue: f.issue, debug_id: f.debugId }, 502);
  return c.json({ error: "internal_error" }, 500);
});

app.use("/api/*", bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: "payload_too_large" }, 413) }));
app.use("/webhooks/*", bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: "payload_too_large" }, 413) }));
app.use("/mcp", bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: "payload_too_large" }, 413) }));

app.use("*", async (c, next) => {
  await next();
  c.header("Cross-Origin-Opener-Policy", "same-origin-allow-popups"); // required by PayPal popups
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
});

// ---------------------------------------------------------------- public API
app.get("/api/health", (c) => c.json({ ok: true, pendingOps: pendingOps(), ai: aiConfigured() }));

app.get("/api/config", (c) =>
  c.json({ clientId: env.PAYPAL_CLIENT_ID, environment: "sandbox", aiModel: env.AI_MODEL, publicUrl: env.PUBLIC_URL, mcpUrl: `${env.PUBLIC_URL.replace(/\/$/, "")}/mcp` }),
);

app.get("/api/drops", async (c) => {
  await ensureShowcase();
  const open = db.prepare("SELECT * FROM drops WHERE status = 'open' AND kind = 'showcase' ORDER BY created_at DESC LIMIT 5").all() as unknown as DropRow[];
  const past = db.prepare("SELECT * FROM drops WHERE status <> 'open' AND kind = 'showcase' ORDER BY created_at DESC LIMIT 5").all() as unknown as DropRow[];
  return c.json({ open: open.map(publicDrop), past: past.map(publicDrop) });
});

function mustDrop(slug: string): DropRow {
  const d = getDrop(slug);
  if (!d) throw new HttpError(404, "drop_not_found");
  return d;
}

app.get("/api/drops/:slug", (c) => c.json(publicDrop(mustDrop(c.req.param("slug")))));

app.get("/api/drops/:slug/events", (c) => {
  const d = mustDrop(c.req.param("slug"));
  const after = Number(c.req.query("after") ?? 0);
  const rows = db.prepare("SELECT id, ts, kind, message, real FROM events WHERE drop_id = ? AND id > ? ORDER BY id DESC LIMIT 80").all(d.id, after);
  return c.json({ events: (rows as unknown[]).reverse() });
});

app.get("/api/drops/:slug/verify", (c) => {
  const d = mustDrop(c.req.param("slug"));
  const winners = listEntries(d.id)
    .filter((e) => ["captured", "won", "capture_failed"].includes(e.status))
    .map((e) => ({ publicId: e.public_id, status: e.status }));
  return c.json({
    title: d.title,
    status: d.status,
    units: d.units,
    waitlistSize: d.waitlist_size,
    seedHash: d.seed_hash,
    seed: d.status === "open" ? null : d.seed,
    frozenHash: d.frozen_hash,
    frozenList: d.frozen_list ? JSON.parse(d.frozen_list) : null,
    outcome: winners,
  });
});

app.post("/api/drops/:slug/entries", async (c) => {
  if (!limit(c, "entry", 20)) return c.json({ error: "rate_limited" }, 429);
  const r = await startEntry(c.req.param("slug"), "human");
  return c.json({ orderId: r.orderId, entryId: r.entryId, publicId: r.publicId });
});

app.post("/api/entries/finalize", async (c) => {
  if (!limit(c, "finalize", 30)) return c.json({ error: "rate_limited" }, 429);
  const body = (await c.req.json().catch(() => ({}))) as { orderId?: string; entryId?: string };
  let orderId = body.orderId;
  if (!orderId && body.entryId) orderId = getEntry(body.entryId)?.order_id ?? undefined;
  if (!orderId) throw new HttpError(400, "order_id_required");
  const r = await finalize(orderId);
  return c.json({ outcome: r.outcome, entry: r.entry ? participantView(r.entry.id) : null });
});

app.get("/api/entries/:id", (c) => c.json(participantView(c.req.param("id"))));

app.post("/api/entries/:id/appeal", async (c) => {
  if (!limit(c, "appeal", 5)) return c.json({ error: "rate_limited" }, 429);
  const { message } = (await c.req.json().catch(() => ({}))) as { message?: string };
  fileAppeal(c.req.param("id"), message || "Not the same household.");
  return c.json({ ok: true });
});

app.post("/api/judge-drop", async (c) => {
  if (!limit(c, "judge", 4)) return c.json({ error: "rate_limited" }, 429);
  const ip = clientIp(c);
  const mine = judgeQuota.get(ip);
  if (mine && mine.reset > Date.now() && mine.n >= 5) return c.json({ error: "judge_drop_quota", message: "You already have several judge drops today — reuse one of them." }, 429);
  const today = (db.prepare("SELECT COUNT(*) n FROM drops WHERE kind = 'judge' AND created_at > ?").get(now() - 86_400_000) as { n: number }).n;
  if (today > 150) return c.json({ error: "judge_drop_quota" }, 429);
  judgeQuota.set(ip, { n: (mine && mine.reset > Date.now() ? mine.n : 0) + 1, reset: mine && mine.reset > Date.now() ? mine.reset : Date.now() + 86_400_000 });
  const d = await createDrop({
    title: "Ember Glaze Mug",
    maker: "Juniper Street Ceramics",
    blurb: "Wood-fired stoneware mug — a fresh 30-minute drop just for you. Try to get two.",
    art: "ember",
    priceCents: 3800,
    shipHoldCents: 1000,
    shipActualCents: 650,
    units: 2,
    minutesOpen: 30,
    kind: "judge",
    negativeTest: true,
  });
  return c.json({ slug: d.slug, sellerKey: d.seller_token });
});

app.post("/api/agent/chat", async (c) => {
  if (!limit(c, "agent", 12)) return c.json({ error: "rate_limited" }, 429);
  const { messages } = (await c.req.json().catch(() => ({}))) as { messages?: { role: "user" | "assistant"; content: string }[] };
  if (!messages?.length) throw new HttpError(400, "messages_required");
  const clean = messages.filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string").map((m) => ({ role: m.role, content: m.content.slice(0, 1200) }));
  return c.json(await runFanAgent(clean));
});

app.get("/api/evals", (c) => {
  const p = join(process.cwd(), "evals", "results.json");
  if (!existsSync(p)) return c.json({ available: false });
  return c.json({ available: true, ...JSON.parse(readFileSync(p, "utf8")) });
});

app.get("/api/ai/usage", (c) => c.json(usageSummary()));

// ---------------------------------------------------------------- seller console (per-drop secret key)
function safeEq(a: string, b: string): boolean {
  const h = (x: string) => createHash("sha256").update(x).digest();
  return timingSafeEqual(h(a), h(b));
}
function seller(c: Context): DropRow {
  const d = mustDrop(c.req.param("slug")!);
  const key = c.req.header("x-seller-key") ?? c.req.query("k") ?? "";
  const ok = key && (safeEq(key, d.seller_token) || (env.SELLER_ADMIN_KEY ? safeEq(key, env.SELLER_ADMIN_KEY) : false));
  if (!ok) throw new HttpError(403, "seller_key_required");
  return d;
}

app.get("/api/seller/:slug", (c) => {
  const d = seller(c);
  const entries = listEntries(d.id).map((e) => ({
    id: e.id,
    publicId: e.public_id,
    source: e.source,
    agentLabel: e.agent_label,
    status: e.status,
    displayName: e.display_name,
    name: e.name,
    address: e.address_json ? JSON.parse(e.address_json) : null,
    holdCents: e.hold_cents,
    capturedCents: e.captured_cents,
    authorizationId: e.source === "simulated" ? null : e.authorization_id,
    clusterId: e.cluster_id,
    note: e.note,
    createdAt: e.created_at,
  }));
  return c.json({ drop: { ...publicDrop(d), negativeTest: d.negative_test === 1 }, entries, clusters: listClusters(d.id), ai: usageSummary() });
});

app.post("/api/seller/:slug/simulate", (c) => {
  const d = seller(c);
  return c.json({ added: addSimulatedCrowd(d.id) });
});

app.post("/api/seller/:slug/swarm", async (c) => {
  const d = seller(c);
  const { n } = (await c.req.json().catch(() => ({}))) as { n?: number };
  const already = (db.prepare("SELECT COUNT(*) n FROM entries WHERE drop_id = ? AND source = 'agent' AND agent_label LIKE 'scalper-bot-%'").get(d.id) as { n: number }).n;
  if (already >= 30) throw new HttpError(409, "swarm_limit", "This drop already met its scalper swarm.");
  const count = Math.max(1, Math.min(25, n ?? 12, 30 - already));
  void runSwarm(d.slug, count).catch((e) => emit(d.id, "swarm_error", `Swarm stopped: ${String(e).slice(0, 120)}`, false));
  return c.json({ started: count });
});

app.post("/api/seller/:slug/analyze", async (c) => {
  const d = seller(c);
  const r = await analyzeDrop(d.id);
  return c.json({ clusters: r.clusters.length, llmCalls: r.llmCalls, uncertainPairs: r.uncertainPairs, ms: r.ms });
});

app.post("/api/seller/:slug/clusters/:id", async (c) => {
  const { decision } = (await c.req.json().catch(() => ({}))) as { decision?: string };
  if (decision !== "confirmed" && decision !== "dismissed") throw new HttpError(400, "bad_decision");
  const d = seller(c);
  decideCluster(d.id, c.req.param("id")!, decision);
  return c.json({ ok: true });
});

app.post("/api/seller/:slug/negative-test", async (c) => {
  const d = seller(c);
  const { on } = (await c.req.json().catch(() => ({}))) as { on?: boolean };
  db.prepare("UPDATE drops SET negative_test = ? WHERE id = ?").run(on ? 1 : 0, d.id);
  return c.json({ ok: true });
});

app.post("/api/seller/:slug/draw", async (c) => {
  const d = seller(c);
  const r = await draw(d.id);
  return c.json({ winners: r.winners, waitlist: r.waitlist, frozenHash: r.frozenHash });
});

// ---------------------------------------------------------------- MCP endpoint for AI agents
app.all("/mcp", async (c) => {
  if (!limit(c, "mcp", 40)) return c.json({ error: "rate_limited" }, 429);
  let parsed: unknown;
  if (c.req.method === "POST") {
    parsed = await c.req.json().catch(() => undefined);
    // JSON-RPC batches would bypass the per-request rate limit
    if (Array.isArray(parsed)) return c.json({ jsonrpc: "2.0", error: { code: -32600, message: "batch requests are not supported" }, id: null }, 400);
  }
  return handleMcp(c.req.raw, parsed);
});

// ---------------------------------------------------------------- PayPal webhooks (signature-verified)
app.post("/webhooks/paypal", async (c) => {
  const raw = await c.req.text();
  const webhookId = env.PAYPAL_WEBHOOK_ID || getSetting("webhook_id") || "";
  const ok = await verifyWebhookSignature(c.req.raw.headers, raw, webhookId).catch(() => false);
  let evt: { id?: string; event_type?: string; resource?: { id?: string; supplementary_data?: { related_ids?: { order_id?: string } } } } = {};
  try {
    evt = JSON.parse(raw);
  } catch {
    /* ignore */
  }
  if (!ok) {
    console.warn("[webhook] rejected unverified event", evt.event_type ?? "?");
    return c.json({ error: "signature_verification_failed" }, 401);
  }
  const inserted = db
    .prepare("INSERT INTO webhook_events(event_id, type, resource_id, verified, received_at) VALUES(?, ?, ?, 1, ?) ON CONFLICT(event_id) DO NOTHING")
    .run(evt.id ?? `noid-${now()}`, evt.event_type ?? "?", evt.resource?.id ?? null, now());
  if (inserted.changes === 0) return c.json({ ok: true, duplicate: true });
  const resId = evt.resource?.id ?? "";
  const entry =
    (db.prepare("SELECT * FROM entries WHERE authorization_id = ? OR capture_id = ? OR order_id = ?").get(resId, resId, resId) as { id: string; drop_id: string; public_id: string } | undefined) ??
    (evt.resource?.supplementary_data?.related_ids?.order_id
      ? (db.prepare("SELECT * FROM entries WHERE order_id = ?").get(evt.resource.supplementary_data.related_ids.order_id) as { id: string; drop_id: string; public_id: string } | undefined)
      : undefined);
  if (entry) emit(entry.drop_id, "webhook", `Webhook ${evt.event_type} verified (signature OK) for ${entry.public_id}.`, true);
  if (evt.event_type === "CHECKOUT.ORDER.APPROVED" && resId) void finalize(resId).catch(() => undefined);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- SPA
app.use("/assets/*", serveStatic({ root: "./dist" }));
app.get("*", serveStatic({ root: "./dist", rewriteRequestPath: (p) => (/\.[a-z0-9]+$/i.test(p) ? p : "/index.html") }));

// ---------------------------------------------------------------- boot
async function boot() {
  const showcase = await ensureShowcase();
  const link = `${env.PUBLIC_URL.replace(/\/$/, "")}/seller/${showcase.slug}?k=${showcase.seller_token}`;
  try {
    writeFileSync(join(env.DATA_DIR, "showcase-seller-link.txt"), link + "\n");
  } catch {
    /* ignore */
  }
  console.log(`[paylet] showcase seller console: ${link}`);
  if (!env.PAYPAL_WEBHOOK_ID) {
    try {
      const wid = await ensureWebhook(env.PUBLIC_URL);
      if (wid) {
        setSetting("webhook_id", wid);
        console.log("[paylet] PayPal webhook registered:", wid);
      }
    } catch (e) {
      console.warn("[paylet] webhook registration skipped:", String(e).slice(0, 160));
    }
  }
  startWorker(handlers);
  setInterval(() => void sweep().catch((e) => console.warn("sweep", String(e))), 15_000);
  setInterval(() => void ensureShowcase().catch(() => undefined), 60_000);
  // Free hosting sleeps after 15 idle minutes and loses its disk. While a judge drop is open, holds exist or PayPal
  // ops are pending, ping our own public URL so the drop can finish and settle (no 24/7 keep-alive otherwise).
  if (env.PUBLIC_URL.startsWith("https://")) {
    setInterval(() => {
      const busy =
        pendingOps() > 0 ||
        (db.prepare("SELECT COUNT(*) n FROM drops WHERE kind = 'judge' AND status = 'open'").get() as { n: number }).n > 0 ||
        (db.prepare("SELECT COUNT(*) n FROM entries e JOIN drops d ON d.id = e.drop_id WHERE e.source <> 'simulated' AND e.status IN ('held','won','authorizing') AND d.kind = 'judge'").get() as { n: number }).n > 0;
      if (busy) void fetch(`${env.PUBLIC_URL.replace(/\/$/, "")}/api/health`, { signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
    }, 9 * 60_000);
  }
  const fresh = (db.prepare("SELECT COUNT(*) n FROM drops").get() as { n: number }).n <= 1;
  if (fresh) console.warn("[paylet] started with an empty database (ephemeral hosting reset); earlier drops are gone.");
}

if (process.env.PAYLET_NO_LISTEN !== "1") {
  serve({ fetch: app.fetch, port: env.PORT, hostname: "0.0.0.0" }, (info) => {
    console.log(`[paylet] listening on :${info.port} (PayPal SANDBOX, AI model ${env.AI_MODEL})`);
    void boot();
  });
}

export { app };
