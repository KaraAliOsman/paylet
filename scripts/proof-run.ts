// P1-04: the permanent proof drop. Runs ONE real drop end to end against a running Paylet and the PayPal SANDBOX
// (no mocks), with the sandbox buyer account, then saves a masked snapshot as docs/proof-run.json. The server imports
// that snapshot at boot whenever its database has no proof drop (free hosting wipes the database on every deploy).
//
//   1. a proof drop (owner key): 1 unit, never closes or draws by itself
//   2. 12 scalper agents over MCP → 12 real PayPal orders with approval links, 0 holds
//   3. the fan's agent requests an entry over MCP → the buyer approves in PayPal → real hold (CREATED)
//   4. the same PayPal account again, through the fan page → PayPal's order says it is the same payer → no hold
//   5. Close & draw: list frozen, drand round fetched, seed revealed → real partial capture (price + actual shipping)
//   6. Mark shipped → real PayPal order tracking (optionally: --refund → real refund)
//   7. Ask PayPal: every real hold re-checked against PayPal's own records; then the masked export
//
// Run (secrets are loaded by Node from the env files, never printed; the server must use the same PayPal app and the
// same SELLER_ADMIN_KEY):
//   E2E_BASE_URL=http://localhost:8791 node --no-warnings --env-file=<paypal.env> --env-file=<buyer.env> --import tsx scripts/proof-run.ts [--refund] [--out docs/proof-run.json]
import { writeFileSync } from "node:fs";
import { chromium, type Browser } from "@playwright/test";
import { approveInPayPal } from "./paypal-approve";
import { auditSnapshot, type ProofSnapshot } from "../src/server/proof";

const base = (process.env.E2E_BASE_URL ?? "http://localhost:8791").replace(/\/$/, "");
const BUYER = { email: process.env.BUYER_EMAIL ?? "", password: process.env.BUYER_PASSWORD ?? "" };
const ADMIN = process.env.SELLER_ADMIN_KEY ?? "";
if (!BUYER.email || !BUYER.password) throw new Error("needs BUYER_EMAIL / BUYER_PASSWORD (sandbox buyer)");
if (!ADMIN) throw new Error("needs SELLER_ADMIN_KEY (the same owner key the server runs with)");
const args = process.argv.slice(2);
const refund = args.includes("--refund");
const out = args.includes("--out") ? args[args.indexOf("--out") + 1] : "docs/proof-run.json";

type Trace = { method: string; endpoint: string; httpStatus?: number; paypalStatus?: string; requestId?: string; debugId?: string; ms?: number; event?: string };
type Ev = { id: number; kind: string; message: string; real: number; trace?: Trace; tone?: string };

async function j<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
  if (init.json !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${base}${path}`, { ...init, headers, body: init.json === undefined ? init.body : JSON.stringify(init.json) });
  const body = (await res.json().catch(() => ({}))) as T;
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} → ${res.status} ${JSON.stringify(body).slice(0, 300)}`);
  return body;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(what: string, fn: () => Promise<T | undefined | false>, ms = 150_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(1500);
  }
  throw new Error(`timed out waiting for ${what}`);
}
const fmt = (t?: Trace) => (t ? `  [${t.method} ${t.endpoint} → ${t.httpStatus ?? "-"} ${t.paypalStatus ?? ""}${t.requestId ? ` · ${t.requestId}` : ""}${t.debugId ? ` · debug_id ${t.debugId}` : ""}${t.ms != null ? ` · ${t.ms} ms` : ""}]` : "");
let seen = 0;
async function ledger(slug: string) {
  const { events } = await j<{ events: Ev[] }>(`/api/drops/${slug}/events?after=${seen}`);
  for (const e of events) console.log(`  ${e.real ? "PAYPAL" : "local "} ${e.kind.padEnd(18)} ${e.message}${fmt(e.trace)}`);
  seen = events.at(-1)?.id ?? seen;
  return events;
}

async function approve(browser: Browser, url: string) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, locale: "en-US" });
  try {
    await page.goto(url);
    await approveInPayPal(page, { ...BUYER, log: (m) => console.log("    paypal:", m) });
    await page.waitForURL(/\/return\b|\/me\//, { timeout: 90_000 }).catch(() => undefined);
  } finally {
    await page.close();
  }
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  try {
    console.log(`Proof run against ${base}`);
    const { slug, sellerKey } = await j<{ slug: string; sellerKey: string }>("/api/judge-drop", { method: "POST", headers: { "x-seller-key": ADMIN }, json: { kind: "proof", units: 1 } });
    const key = { "x-seller-key": sellerKey };
    const drop = await j<{ kind: string; title: string }>(`/api/drops/${slug}`);
    if (drop.kind !== "proof") throw new Error(`expected a proof drop, got ${drop.kind} (is the server running this branch?)`);
    console.log(`\n1. proof drop ${slug} (${drop.title})`);

    console.log("\n2. 12 scalper agents over MCP");
    await j(`/api/seller/${slug}/swarm`, { method: "POST", headers: key, json: { n: 12 } });
    await until("swarm_done", async () => (await j<{ events: Ev[] }>(`/api/drops/${slug}/events?after=0`)).events.some((e) => e.kind === "swarm_done"), 180_000);
    await ledger(slug);

    console.log("\n3. the fan's agent requests an entry over MCP; the person approves in PayPal");
    const rpc = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "enter_drop", arguments: { drop: `${base}/d/${slug}`, agent_name: "fan's MCP agent" } } }),
    }).then((r) => r.json() as Promise<{ result: { structuredContent: { entry_ref: string; public_id: string; approve_url: string } } }>);
    const fan = rpc.result.structuredContent;
    await approve(browser, fan.approve_url);
    await j("/api/entries/finalize", { method: "POST", json: { entryId: fan.entry_ref } }).catch(() => undefined); // idempotent
    await until("hold", async () => {
      const e = await j<{ status: string }>(`/api/entries/${fan.entry_ref}`);
      if (e.status === "held") return e;
      if (e.status !== "awaiting_person" && e.status !== "authorizing") throw new Error(`entry ${e.status}`);
      return undefined;
    });
    await ledger(slug);

    console.log("\n4. the same PayPal account again, through the fan page");
    const second = await j<{ orderId: string; entryId: string }>(`/api/drops/${slug}/entries`, { method: "POST" });
    await approve(browser, `https://www.sandbox.paypal.com/checkoutnow?token=${second.orderId}`);
    const fin = await j<{ outcome: string }>("/api/entries/finalize", { method: "POST", json: { orderId: second.orderId } }).catch(() => ({ outcome: "?" }));
    const dup = await until("duplicate", async () => {
      const e = await j<{ status: string }>(`/api/entries/${second.entryId}`);
      return e.status === "awaiting_person" ? undefined : e;
    });
    if (dup.status !== "duplicate") throw new Error(`expected duplicate, got ${dup.status} (${fin.outcome})`);
    await ledger(slug);

    console.log("\n5. Close & draw (freeze → drand → reveal → capture)");
    const frozen = await j<{ status: string; round: number }>(`/api/seller/${slug}/draw`, { method: "POST", headers: key, json: {} });
    console.log(`  frozen; drand round ${frozen.round}`);
    await until("settled", async () => (await j<{ status: string }>(`/api/drops/${slug}`)).status === "settled", 180_000);
    await ledger(slug);
    const entries = (await j<{ entries: { id: string; publicId: string; status: string; source: string }[] }>(`/api/seller/${slug}`, { headers: key })).entries;
    const winner = entries.find((e) => e.status === "captured" && e.source !== "simulated");
    if (!winner) throw new Error("no real capture");

    console.log("\n6. Mark shipped (PayPal order tracking)");
    await j(`/api/seller/${slug}/entries/${winner.id}/ship`, { method: "POST", headers: key, json: { carrier: "USPS" } });
    await until("tracking", async () => (await j<{ shipping: unknown }>(`/api/entries/${winner.id}`)).shipping);
    if (refund) {
      console.log("   … and refund (PayPal refund)");
      await j(`/api/seller/${slug}/entries/${winner.id}/refund`, { method: "POST", headers: key, json: { reason: "Proof run: the maker could not ship" } });
      await until("refund", async () => (await j<{ status: string }>(`/api/entries/${winner.id}`)).status === "refunded");
    }
    await sleep(1500);
    await ledger(slug);

    console.log("\n7. Ask PayPal + masked export");
    const check = await j<{ rows: { publicId: string; paypalStatus: string; heldCents: number; capturedCents: number; ledgerStatus: string; matchesLedger: boolean }[]; totals: { mismatches: number } }>(
      `/api/drops/${slug}/paypal-check`,
    );
    for (const r of check.rows) console.log(`  Ask PayPal: ${r.publicId} PayPal says ${r.paypalStatus} · held ${r.heldCents} · captured ${r.capturedCents} · ledger ${r.ledgerStatus} · ${r.matchesLedger ? "MATCHES" : "MISMATCH"}`);
    if (check.totals.mismatches) throw new Error("Ask PayPal reported a mismatch");
    const snap = await j<ProofSnapshot>(`/api/seller/${slug}/export`, { headers: key });
    const json = JSON.stringify(snap, null, 2) + "\n";
    // belt and braces: the server audits too; here the buyer's own login and the full order ids are checked as well
    const problems = auditSnapshot(json, [BUYER.email, BUYER.password, fan.entry_ref, second.orderId, second.entryId]);
    if (problems.length) throw new Error(`refusing to write the snapshot: it contains ${problems.join(", ")}`);
    writeFileSync(out, json);
    console.log(`  wrote ${out}: ${snap.entries.length} entries, ${snap.events.length} ledger lines, report ${JSON.stringify(snap.report)}`);
    const proof = await j<{ summary: string | null }>("/api/proof");
    console.log(`\n${proof.summary ?? ""}`);
  } finally {
    await browser.close();
  }
}

await main();
