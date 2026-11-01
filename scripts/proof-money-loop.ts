// REAL money loop against a running Paylet and the PayPal SANDBOX (no mocks). Two scenarios, one buyer login each:
//   A. negative test: the only real winner's capture is declined by PayPal (PayPal-Mock-Response TRANSACTION_REFUSED,
//      422), its live hold is voided, the waitlist is empty, the drop settles; Ask PayPal agrees (VOIDED).
//   B. winner captured (partial: price + actual shipping) → Mark shipped (PayPal order tracking) → Refund →
//      Ask PayPal agrees (capture REFUNDED); MCP entry_status says refunded.
// Each scenario prints the ledger lines with their PayPal trace.
//
// Run (secrets are loaded by Node, never printed; the server must be running with the same PayPal app):
//   E2E_BASE_URL=http://localhost:8791 node --no-warnings --env-file=../.secrets/buyer.env --import tsx scripts/proof-money-loop.ts [A|B|AB]
import { chromium, type Browser } from "@playwright/test";
import { approveInPayPal } from "./paypal-approve";

const base = (process.env.E2E_BASE_URL ?? "http://localhost:8791").replace(/\/$/, "");
const BUYER = { email: process.env.BUYER_EMAIL ?? "", password: process.env.BUYER_PASSWORD ?? "" };
if (!BUYER.email || !BUYER.password) throw new Error("needs BUYER_EMAIL / BUYER_PASSWORD (sandbox buyer)");
const which = (process.argv[2] ?? "AB").toUpperCase();
const admin = process.env.SELLER_ADMIN_KEY ? { "x-seller-key": process.env.SELLER_ADMIN_KEY } : undefined;

type Trace = { method: string; endpoint: string; httpStatus?: number; paypalStatus?: string; requestId?: string; debugId?: string; ms?: number; event?: string };
type Ev = { id: number; kind: string; message: string; real: number; trace?: Trace };

async function j<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
  if (init.json !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${base}${path}`, { ...init, headers, body: init.json === undefined ? init.body : JSON.stringify(init.json) });
  const body = (await res.json().catch(() => ({}))) as T;
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} → ${res.status} ${JSON.stringify(body)}`);
  return body;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(what: string, fn: () => Promise<T | undefined | false>, ms = 120_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(1500);
  }
  throw new Error(`timed out waiting for ${what}`);
}
const fmt = (t?: Trace) => (t ? `  [${t.method} ${t.endpoint} → ${t.httpStatus ?? "-"} ${t.paypalStatus ?? ""}${t.requestId ? ` · ${t.requestId}` : ""}${t.debugId ? ` · debug_id ${t.debugId}` : ""}${t.ms != null ? ` · ${t.ms} ms` : ""}]` : "");

async function enterAndApprove(browser: Browser, slug: string) {
  // the fan's agent requests the entry over MCP (Streamable HTTP), exactly like any MCP client
  const rpc = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "enter_drop", arguments: { drop: slug, agent_name: "proof-script" } } }),
  }).then((r) => r.json() as Promise<{ result: { structuredContent: { entry_ref: string; public_id: string; approve_url: string } } }>);
  const { entry_ref, public_id, approve_url } = rpc.result.structuredContent;
  console.log(`  entry ${public_id}: PayPal approval link issued to the agent`);
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, locale: "en-US" });
  await page.goto(approve_url);
  await approveInPayPal(page, { ...BUYER, log: (m) => console.log("    pp:", m) });
  await page.waitForURL(/\/return\b|\/me\//, { timeout: 90_000 });
  await page.close();
  await j("/api/entries/finalize", { method: "POST", json: { entryId: entry_ref } }).catch(() => undefined); // idempotent
  const held = await until("hold", async () => {
    const e = await j<{ status: string; payerVerified: boolean | null }>(`/api/entries/${entry_ref}`);
    return e.status === "held" ? e : e.status === "awaiting_person" || e.status === "authorizing" ? undefined : Promise.reject(new Error(`entry ${e.status}`));
  });
  console.log(`  hold placed (payerVerified=${held.payerVerified})`);
  return { entryRef: entry_ref, publicId: public_id };
}

async function ledger(slug: string, after = 0) {
  const { events } = await j<{ events: Ev[] }>(`/api/drops/${slug}/events?after=${after}`);
  for (const e of events) console.log(`  ${e.real ? "PAYPAL" : "local "} ${e.kind.padEnd(16)} ${e.message}${fmt(e.trace)}`);
  return events.at(-1)?.id ?? after;
}

async function scenario(browser: Browser, name: "A" | "B") {
  console.log(`\n=== Scenario ${name}: ${name === "A" ? "PayPal declines the winner's capture (negative test)" : "capture → ship → refund"}`);
  const { slug, sellerKey } = await j<{ slug: string; sellerKey: string }>("/api/judge-drop", { method: "POST", headers: admin });
  const key = { "x-seller-key": sellerKey };
  console.log(`  judge drop ${slug}`);
  await j(`/api/seller/${slug}/negative-test`, { method: "POST", headers: key, json: { on: name === "A" } });
  const { entryRef, publicId } = await enterAndApprove(browser, slug);
  await j(`/api/seller/${slug}/draw`, { method: "POST", headers: key, json: {} });
  await until("settled", async () => (await j<{ status: string }>(`/api/drops/${slug}`)).status === "settled");
  let entry = await j<{ status: string; capturedCents: number | null; refundedCents: number | null }>(`/api/entries/${entryRef}`);
  console.log(`  drop settled; ${publicId} is ${entry.status}`);
  if (name === "A" && entry.status !== "capture_failed") throw new Error(`expected capture_failed, got ${entry.status}`);
  if (name === "B") {
    if (entry.status !== "captured") throw new Error(`expected captured, got ${entry.status}`);
    await j(`/api/seller/${slug}/entries/${entryRef}/ship`, { method: "POST", headers: key, json: { carrier: "USPS" } });
    await until("tracking", async () => (await j<{ shipping: unknown }>(`/api/entries/${entryRef}`)).shipping);
    await j(`/api/seller/${slug}/entries/${entryRef}/refund`, { method: "POST", headers: key, json: { reason: "Proof run: the maker could not ship" } });
    entry = await until("refund", async () => {
      const e = await j<typeof entry>(`/api/entries/${entryRef}`);
      return e.status === "refunded" ? e : undefined;
    });
    console.log(`  refunded ${entry.refundedCents} cents`);
    const mcp = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "entry_status", arguments: { entry_ref: entryRef } } }),
    }).then((r) => r.json() as Promise<{ result: { structuredContent: { status: string } } }>);
    console.log(`  MCP entry_status → ${mcp.result.structuredContent.status}`);
  }
  await sleep(1500);
  await ledger(slug);
  const check = await j<{ rows: { publicId: string; paypalStatus: string; heldCents: number; capturedCents: number; ledgerStatus: string; matchesLedger: boolean }[]; totals: { mismatches: number } }>(`/api/drops/${slug}/paypal-check`);
  for (const r of check.rows) console.log(`  Ask PayPal: ${r.publicId} PayPal says ${r.paypalStatus} · held ${r.heldCents} · captured ${r.capturedCents} · ledger ${r.ledgerStatus} · ${r.matchesLedger ? "MATCHES" : "MISMATCH"}`);
  if (check.totals.mismatches) throw new Error("Ask PayPal reported a mismatch");
  return { slug, status: entry.status };
}

const browser = await chromium.launch({ headless: true });
const results: Record<string, unknown> = {};
try {
  if (which.includes("A")) results.A = await scenario(browser, "A");
  if (which.includes("B")) results.B = await scenario(browser, "B");
} finally {
  await browser.close();
}
console.log("\n" + JSON.stringify(results));
