import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { db, now, setSetting } from "./db";
import { env, unsafeConfig } from "./env";
import {
  HttpError,
  addSimulatedCrowd,
  aiSummary,
  analyzeDrop,
  createDrop,
  decideCluster,
  ensureShowcase,
  fileAppeal,
  finalize,
  freeze,
  handlers,
  listClusters,
  participantView,
  publicDrop,
  refundEntry,
  scheduleReveal,
  shipEntry,
  startEntry,
  sweep,
  verifyData,
} from "./domain";
import { emit, getDrop, getEntry, listEntries, type DropRow } from "./models";
import { classify, ensureWebhook } from "./paypal";
import { paypalCheck } from "./paypalcheck";
import { maskId, toneOf, traceFromData } from "./trace";
import { handlePayPalWebhook } from "./webhooks";
import { pendingOps, startWorker } from "./queue";
import { handleMcp, paypalState } from "./mcp";
import { INTERNAL_HEADER, howItWent, internalToken, runFanAgent, runSwarm } from "./agent";
import { aiConfigured, usageSummary } from "./ai";
import { dropReport, globalStats } from "./report";
import { auditSnapshot, ensureProofDrop, exportProof, proofInfo, recordedProof } from "./proof";

const app = new Hono();

const judgeQuota = new Map<string, { n: number; reset: number }>();

// ---------------------------------------------------------------- tiny per-IP rate limiter
const buckets = new Map<string, { n: number; reset: number }>();
/** Client IP (P0-02). Render sits behind Cloudflare, which overwrites CF-Connecting-IP / True-Client-IP with the real
 *  client; otherwise the LAST X-Forwarded-For hop is the one added by the hosting proxy (earlier hops are
 *  client-controlled). Loopback calls carry none of them: "local". */
let ipHeadersLogged = false;
export function clientIp(c: Context): string {
  if (!ipHeadersLogged && c.req.header("x-forwarded-for")) {
    // once per boot, names only: confirms which proxy headers the host really sends
    ipHeadersLogged = true;
    console.log("[paylet] client IP headers present:", ["cf-connecting-ip", "true-client-ip", "x-forwarded-for", "x-real-ip"].filter((h) => c.req.header(h)).join(", "));
  }
  const cf = c.req.header("cf-connecting-ip") ?? c.req.header("true-client-ip");
  if (cf) return cf.trim();
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

// P2-14: Content-Security-Policy for the SPA. PayPal's JS SDK v6 (script, iframes, popups, fraud/telemetry calls) lives on
// *.paypal.com and *.paypalobjects.com; /verify fetches public randomness from the League of Entropy drand relays.
const HTTPS = env.PUBLIC_URL.startsWith("https://");
const PAYPAL_SRC = "https://*.paypal.com https://*.paypalobjects.com";
const DRAND_SRC = "https://api.drand.sh https://api2.drand.sh https://api3.drand.sh https://drand.cloudflare.com";
export const CSP = [
  "default-src 'self'",
  `script-src 'self' ${PAYPAL_SRC}`,
  `style-src 'self' 'unsafe-inline' ${PAYPAL_SRC}`,
  `img-src 'self' data: blob: ${PAYPAL_SRC}`,
  `font-src 'self' data: ${PAYPAL_SRC}`,
  `connect-src 'self' ${PAYPAL_SRC} ${DRAND_SRC}`,
  `frame-src ${PAYPAL_SRC}`,
  `form-action 'self' ${PAYPAL_SRC}`,
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'self'",
  ...(HTTPS ? ["upgrade-insecure-requests"] : []),
].join("; ");

app.use("*", async (c, next) => {
  await next();
  c.header("Cross-Origin-Opener-Policy", "same-origin-allow-popups"); // required by PayPal popups
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  c.header("Content-Security-Policy", CSP);
  if (HTTPS) c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
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
  const rows = db.prepare("SELECT id, ts, kind, message, real, data_json FROM events WHERE drop_id = ? AND id > ? ORDER BY id DESC LIMIT 80").all(d.id, after) as {
    id: number;
    ts: number;
    kind: string;
    message: string;
    real: 0 | 1;
    data_json: string | null;
  }[];
  // data_json is never sent as is: only the whitelisted, already-masked PayPal trace (P1-01) and a "warn" tone
  const events = rows.reverse().map(({ data_json, ...e }) => {
    const trace = traceFromData(data_json);
    const tone = toneOf(data_json);
    return { ...e, ...(trace ? { trace } : {}), ...(tone ? { tone } : {}) };
  });
  return c.json({ events });
});

app.get("/api/drops/:slug/paypal-check", async (c) => {
  const d = mustDrop(c.req.param("slug"));
  if (!limit(c, "ppcheck", 6)) return c.json({ error: "rate_limited", message: "Ask PayPal at most 6 times a minute." }, 429);
  // an imported proof run only has masked ids: show what PayPal said when the run was checked (and when)
  const recorded = d.kind === "proof" ? recordedProof(d) : null;
  if (recorded) return c.json({ ...(recorded.paypalCheck ?? { checkedAt: null, rows: [], totals: { captured: 0, voided: 0, mismatches: 0 } }), cached: true, recorded: true });
  try {
    return c.json(await paypalCheck(d));
  } catch (e) {
    if ((e as { code?: string }).code === "rate_limited") return c.json({ error: "rate_limited", message: "PayPal is being asked a lot right now. Try again in a minute." }, 429);
    throw e;
  }
});

app.get("/api/drops/:slug/verify", (c) => c.json(verifyData(mustDrop(c.req.param("slug")))));
/** alias of /verify (the data behind the /verify page) */
app.get("/api/drops/:slug/verify-data", (c) => c.json(verifyData(mustDrop(c.req.param("slug")))));

// P1-07: public Drop report (no PII), partial until the drop settles
app.get("/api/drops/:slug/report", (c) => c.json(dropReport(mustDrop(c.req.param("slug")))));

// landing page counters: real PayPal sandbox activity only
app.get("/api/stats", (c) => c.json(globalStats()));

// P1-04: the permanent proof drop with real sandbox money
app.get("/api/proof", (c) => c.json(proofInfo()));

// P1-06: sandbox buyer accounts for judges, only with the code from the Devpost testing instructions (never in the bundle)
app.get("/api/judge-buyers", (c) => {
  c.header("Cache-Control", "no-store");
  if (!limit(c, "judge-buyers", 10)) return c.json({ error: "rate_limited" }, 429);
  const code = c.req.query("code") ?? "";
  if (!env.JUDGE_CODE || !code || !safeEq(code, env.JUDGE_CODE)) return c.json({ error: "not_found" }, 404);
  const buyers = [
    { label: "Sandbox buyer", email: env.BUYER_EMAIL, password: env.BUYER_PASSWORD },
    { label: "Sandbox buyer B", email: env.BUYER_B_EMAIL, password: env.BUYER_B_PASSWORD },
  ].filter((b): b is { label: string; email: string; password: string } => Boolean(b.email && b.password));
  if (!buyers.length) return c.json({ error: "not_found" }, 404);
  return c.json({ buyers });
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
  const adminKey = c.req.header("x-seller-key");
  const isOwner = Boolean(env.SELLER_ADMIN_KEY && adminKey && safeEq(adminKey, env.SELLER_ADMIN_KEY)); // test suite / owner
  if (!isOwner && !limit(c, "judge", 4)) return c.json({ error: "rate_limited" }, 429);
  const ip = clientIp(c);
  const body = (await c.req.json().catch(() => ({}))) as { kind?: unknown; units?: unknown; negativeTest?: unknown };
  if (isOwner && body.kind === "proof") {
    // P1-04 (owner only): the proof run's drop. Never closes or draws by itself; scripts/proof-run.ts draws it.
    const units = Math.max(1, Math.min(5, Number(body.units) || 1));
    const d = await createDrop({
      title: "Ember Glaze Mug",
      maker: "Juniper Street Ceramics",
      blurb: "Wood-fired stoneware mug. A real PayPal sandbox run, kept as proof: every entry here moved real sandbox money.",
      art: "ember",
      priceCents: 3800,
      shipHoldCents: 1000,
      shipActualCents: 650,
      units,
      minutesOpen: 24 * 60,
      kind: "proof",
      negativeTest: body.negativeTest === true,
    });
    return c.json({ slug: d.slug, sellerKey: d.seller_token });
  }
  const mine = judgeQuota.get(ip);
  if (!isOwner && mine && mine.reset > Date.now() && mine.n >= 12) return c.json({ error: "judge_drop_quota", message: "You already have several judge drops today — reuse one of them." }, 429);
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

// P2-02: "Ask Wren how it went". Wren calls entry_status; the reply is built from that structured result, not by a model
app.post("/api/agent/how-it-went", async (c) => {
  if (!limit(c, "agent-status", 20)) return c.json({ error: "rate_limited" }, 429);
  const { entryRef } = (await c.req.json().catch(() => ({}))) as { entryRef?: unknown };
  if (typeof entryRef !== "string" || !entryRef || entryRef.length > 80) throw new HttpError(400, "entry_ref_required");
  const r = await howItWent(entryRef, (ref) => {
    if (!getEntry(ref)) return null;
    const v = participantView(ref);
    const usd = (cents: number | null) => (cents == null ? null : cents / 100);
    return {
      public_id: v.publicId,
      status: v.status === "captured" && v.shipping ? "shipped" : v.status,
      title: v.drop.title,
      drop_status: v.drop.status,
      draw_at: new Date(v.drop.closesAt).toISOString(),
      hold_usd: usd(v.holdCents),
      captured_usd: usd(v.capturedCents),
      refunded_usd: usd(v.refundedCents),
      paypal_state: paypalState(v.status, v.holdCents, v.capturedCents),
      shipping: v.shipping,
    };
  });
  if (!r) throw new HttpError(404, "entry_not_found");
  return c.json(r);
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
    refundedCents: e.refunded_cents,
    authorization: e.source === "simulated" ? null : (maskId(e.authorization_id) ?? null),
    // full id for the drop's own seller (the real-sandbox e2e cross-checks it with PayPal); the UI shows `authorization`
    authorizationId: e.source === "simulated" || d.kind === "proof" ? null : e.authorization_id,
    clusterId: e.cluster_id,
    note: e.note,
    createdAt: e.created_at,
    payerVerified: e.payer_verified == null ? null : e.payer_verified === 1,
    shipping: e.tracking_number ? { carrier: e.carrier ?? "OTHER", tracking: e.tracking_number } : null,
  }));
  const usage = usageSummary();
  return c.json({
    drop: { ...publicDrop(d), negativeTest: d.negative_test === 1 },
    entries,
    clusters: listClusters(d.id),
    // AiSummary (contract) + today/dailyCap kept for older consoles
    ai: { ...aiSummary(d.id), today: usage.today, dailyCap: usage.dailyCap },
    usage,
  });
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
  // runSwarm retries rate-limited calls and always writes the swarm_done line; this only catches a swarm that cannot start
  void runSwarm(d.slug, count).catch(() => emit(d.id, "swarm_done", `0 of ${count} agents got a PayPal link (the swarm could not start) · 0 holds.`, false, { tone: "warn" }));
  return c.json({ started: count });
});

app.post("/api/seller/:slug/analyze", async (c) => {
  const d = seller(c);
  const r = await analyzeDrop(d.id);
  return c.json({ clusters: r.clusters.length, llmCalls: r.llmCalls, uncertainPairs: r.uncertainPairs, keptApart: r.keptApart, degraded: r.degraded, ms: r.ms });
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

// P2-01: after the sale. Both are async through the PayPal op queue; the ledger shows the PayPal call when it lands.
app.post("/api/seller/:slug/entries/:id/ship", async (c) => {
  const d = seller(c);
  const body = (await c.req.json().catch(() => ({}))) as { carrier?: unknown; tracking?: unknown };
  shipEntry(d.id, c.req.param("id")!, body);
  return c.json({ ok: true });
});

app.post("/api/seller/:slug/entries/:id/refund", async (c) => {
  const d = seller(c);
  const body = (await c.req.json().catch(() => ({}))) as { reason?: unknown };
  refundEntry(d.id, c.req.param("id")!, body.reason);
  return c.json({ ok: true });
});

// P0-03 + P2-10: freezes now (409 pending_reviews / no_eligible_entries / holds_pending), reveals with drand in a few seconds
app.post("/api/seller/:slug/draw", async (c) => {
  const d = seller(c);
  const { force } = (await c.req.json().catch(() => ({}))) as { force?: unknown };
  const f = await freeze(d.id, { force: force === true });
  if (f.status === "frozen") void scheduleReveal(f.dropId);
  return c.json({ status: f.status, frozenHash: f.frozenHash, eligible: f.eligible, excluded: f.excluded, round: f.round, revealAt: f.revealAt });
});

// P1-04: masked, PII-free snapshot of a settled drop (scripts/proof-run.ts saves it as docs/proof-run.json)
app.get("/api/seller/:slug/export", async (c) => {
  const d = seller(c);
  if (d.status !== "settled") throw new HttpError(409, "not_settled", "Only a settled drop can be exported.");
  const recorded = d.kind === "proof" ? recordedProof(d) : null;
  const check = recorded ? recorded.paypalCheck : await paypalCheck(d, { force: true }).catch(() => null);
  const snap = exportProof(d, check ? { checkedAt: check.checkedAt, rows: check.rows, totals: check.totals } : null);
  const problems = auditSnapshot(JSON.stringify(snap));
  if (problems.length) throw new HttpError(500, "export_unsafe", `The snapshot would contain ${problems.join(", ")}.`);
  return c.json(snap);
});

// ---------------------------------------------------------------- MCP endpoint for AI agents
// Paylet's own agents (Wren, the scalper swarm) sign their loopback calls; that only selects a separate bucket.
const MCP_INTERNAL_TOKEN = internalToken();
app.all("/mcp", async (c) => {
  const tok = c.req.header(INTERNAL_HEADER);
  const internal = Boolean(tok && safeEq(tok, MCP_INTERNAL_TOKEN));
  if (!(internal ? limit(c, "mcp-int", 300) : limit(c, "mcp", 40))) {
    c.header("Retry-After", "60");
    return c.json({ jsonrpc: "2.0", error: { code: -32029, message: "rate_limited" }, id: null }, 429);
  }
  let parsed: unknown;
  if (c.req.method === "POST") {
    parsed = await c.req.json().catch(() => undefined);
    // JSON-RPC batches would bypass the per-request rate limit
    if (Array.isArray(parsed)) return c.json({ jsonrpc: "2.0", error: { code: -32600, message: "batch requests are not supported" }, id: null }, 400);
  }
  return handleMcp(c.req.raw, parsed);
});

// ---------------------------------------------------------------- PayPal webhooks (pre-checked, signature-verified, de-duplicated)
app.post("/webhooks/paypal", async (c) => {
  if (!limit(c, "webhook", 60)) return c.json({ error: "rate_limited" }, 429);
  const raw = await c.req.text(); // raw body, byte for byte: PayPal verifies the signature over it
  const r = await handlePayPalWebhook(c.req.raw.headers, raw);
  return c.json(r.body, r.status);
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
  // P1-04: the proof drop survives deploys (re-imported from docs/proof-run.json); a live one is re-checked with PayPal
  const proof = ensureProofDrop();
  if (proof && !proof.proof_json) void paypalCheck(proof, { force: true }).catch((e) => console.warn("[paylet] proof re-check skipped:", String(e).slice(0, 120)));
  if (!env.PAYPAL_WEBHOOK_ID) {
    try {
      const { id: wid, patched } = await ensureWebhook(env.PUBLIC_URL);
      if (wid) {
        setSetting("webhook_id", wid);
        console.log("[paylet] PayPal webhook registered:", wid, patched.length ? `(added events: ${patched.join(", ")})` : "");
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
        (db.prepare("SELECT COUNT(*) n FROM drops WHERE (kind = 'judge' AND status = 'open') OR status = 'frozen'").get() as { n: number }).n > 0 ||
        (db.prepare("SELECT COUNT(*) n FROM entries e JOIN drops d ON d.id = e.drop_id WHERE e.source <> 'simulated' AND e.status IN ('held','won','authorizing') AND d.kind = 'judge'").get() as { n: number }).n > 0;
      if (busy) void fetch(`${env.PUBLIC_URL.replace(/\/$/, "")}/api/health`, { signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
    }, 9 * 60_000);
  }
  const fresh = (db.prepare("SELECT COUNT(*) n FROM drops").get() as { n: number }).n <= 1;
  if (fresh) console.warn("[paylet] started with an empty database (ephemeral hosting reset); earlier drops are gone.");
}

if (process.env.PAYLET_NO_LISTEN !== "1") {
  const unsafe = unsafeConfig(env);
  if (unsafe) {
    console.error(`[paylet] refusing to start: ${unsafe}`);
    process.exit(1);
  }
  serve({ fetch: app.fetch, port: env.PORT, hostname: "0.0.0.0" }, (info) => {
    console.log(`[paylet] listening on :${info.port} (PayPal SANDBOX, AI model ${env.AI_MODEL})`);
    void boot();
  });
}

export { app };
