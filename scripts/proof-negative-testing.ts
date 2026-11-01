// REAL spike against the PayPal SANDBOX (no mocks, no Paylet server needed).
// P2-03: does PayPal's official negative testing (PayPal-Mock-Response) work on Payments v2 capture/authorize?
// P2-01: tracking (POST /v2/checkout/orders/{id}/track) and refund (POST /v2/payments/captures/{id}/refund) end to end.
//
// One AUTHORIZE order is created through src/server/paypal.ts (the same code the app runs), approved by the sandbox
// buyer in headless Chromium (scripts/paypal-approve.ts), authorized, then:
//   1. authorize with PayPal-Mock-Response INSTRUMENT_DECLINED, then for real;
//   2. capture with every candidate mock code → which ones does the sandbox honour, and is the hold still alive after?
//   3. real partial capture (price + actual shipping), replayed with the same PayPal-Request-Id (must not double-charge);
//   4. shipment tracking (twice: the second call must be a no-op);
//   5. full refund (replayed with the same PayPal-Request-Id) → GET capture = REFUNDED.
//
// Result of the real run on 2026-10-31 (sandbox, Chilean buyer account, account_status VERIFIED):
//   authorize + mock INSTRUMENT_DECLINED          → 422 INSTRUMENT_DECLINED (only an information_link; re-approval
//                                                   uses the order's existing payer-action link)
//   capture   + mock TRANSACTION_REFUSED          → 422 TRANSACTION_REFUSED   ← used by the app's negative test
//   capture   + mock PAYER_CANNOT_PAY             → 422 PAYER_CANNOT_PAY
//   capture   + mock PAYER_ACCOUNT_LOCKED_OR_CLOSED → 422 PAYER_ACCOUNT_LOCKED_OR_CLOSED
//   capture   + mock AUTHORIZATION_VOIDED / AUTHORIZATION_EXPIRED / MAX_CAPTURE_AMOUNT_EXCEEDED → 422 with that issue
//   capture   + mock INSTRUMENT_DECLINED          → 403 (not a capture code)
//   GET authorization after all mocked declines  → CREATED: the hold is still alive (so the app must void it)
//   real capture 201 COMPLETED, replay 200 with the same capture id; authorization → CAPTURED (final_capture)
//   track 201 SHIPPED, replay detected as already tracked; refund 201 COMPLETED, replay 200 same refund id;
//   GET capture → REFUNDED.
//
// Run (secrets are loaded by Node, never printed):
//   node --no-warnings --env-file=../.secrets/paypal.env --env-file=../.secrets/buyer.env --import tsx scripts/proof-negative-testing.ts
// Output: a JSON report with masked ids only (also written to data/spike-negative-testing.json).
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import * as pp from "../src/server/paypal";
import { maskId } from "../src/server/trace";
import { approveInPayPal } from "./paypal-approve";

const BUYER = { email: process.env.BUYER_EMAIL ?? "", password: process.env.BUYER_PASSWORD ?? "" };
if (!BUYER.email || !BUYER.password) throw new Error("needs BUYER_EMAIL / BUYER_PASSWORD (sandbox buyer)");

const CAPTURE_CODES = (process.env.MOCK_CODES ?? "INSTRUMENT_DECLINED,TRANSACTION_REFUSED,PAYER_CANNOT_PAY,PAYER_ACCOUNT_LOCKED_OR_CLOSED,AUTHORIZATION_VOIDED,AUTHORIZATION_EXPIRED,MAX_CAPTURE_AMOUNT_EXCEEDED").split(",");
const RUN = Date.now().toString(36).toUpperCase();
const PRICE = 3800;
const SHIP_HOLD = 1000;
const SHIP_ACTUAL = 650;
const RETURN = "https://example.com/paylet-spike/return";

type Row = { step: string; ok: boolean; httpStatus?: number; issue?: string; paypalStatus?: string; debugId?: string; ms?: number; note?: string };
const rows: Row[] = [];
const log = (r: Row) => {
  rows.push(r);
  console.log(`${r.ok ? "OK  " : "FAIL"} ${r.step.padEnd(44)} ${r.httpStatus ?? ""} ${r.paypalStatus ?? r.issue ?? ""} ${r.note ?? ""}`);
};
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function attempt<T>(step: string, fn: () => Promise<T & { trace?: { httpStatus?: number; paypalStatus?: string; debugId?: string; ms?: number } }>, expectFail = false) {
  try {
    const r = await fn();
    log({ step, ok: !expectFail, httpStatus: r.trace?.httpStatus, paypalStatus: r.trace?.paypalStatus, debugId: r.trace?.debugId, ms: r.trace?.ms });
    return r;
  } catch (e) {
    const f = pp.classify(e);
    let links: string | undefined;
    let body = (e as { result?: { links?: { rel?: string }[] } }).result;
    const raw = (e as { body?: unknown }).body;
    if (!body && typeof raw === "string" && raw.trim()) {
      try {
        body = JSON.parse(raw);
      } catch {
        /* not JSON */
      }
    }
    if (body?.links?.length) links = `links: ${body.links.map((l: { rel?: string }) => l.rel).join(",")}`;
    log({ step, ok: expectFail, httpStatus: f.status, issue: f.issue, debugId: f.debugId, ms: f.trace?.ms, note: [f.description.slice(0, 90), links].filter(Boolean).join(" · ") });
    return undefined;
  }
}

// 1. order + approval
const order = await pp.createHoldOrder({
  dropId: `drop_spike${RUN}`,
  entryId: `ent_spike${RUN}`,
  title: "Paylet negative-testing spike",
  sku: `spike-${RUN}`,
  priceCents: PRICE,
  shipHoldCents: SHIP_HOLD,
  returnUrl: RETURN,
  cancelUrl: `${RETURN}?cancelled=1`,
});
log({ step: "create order (AUTHORIZE)", ok: true, httpStatus: order.trace.httpStatus, paypalStatus: order.trace.paypalStatus, note: `order ${maskId(order.orderId)}` });

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, locale: "en-US" });
  await page.route("https://example.com/**", (r) => r.fulfill({ status: 200, contentType: "text/html", body: "<p>Paylet spike: approved</p>" }));
  await page.goto(order.approveUrl!);
  await approveInPayPal(page, { ...BUYER, log: (m) => console.log("     pp:", m) });
  await page.waitForURL(/example\.com\/paylet-spike\/return/, { timeout: 90_000 });
  log({ step: "buyer approved in headless Chromium", ok: true });
} finally {
  await browser.close();
}

const ident = await pp.getOrderIdentity(order.orderId);
log({ step: "GET order (identity, server-side only)", ok: ident.status === "APPROVED", paypalStatus: ident.status, note: `account_status=${ident.accountStatus ?? "(none)"} payer_id=${ident.payerId ? "present" : "missing"}` });

// 2. authorize: negative test first, then for real
await attempt("authorize · mock INSTRUMENT_DECLINED", () => pp.authorizeOrder(order.orderId, `spike-auth-mock:${RUN}`, { mock: "INSTRUMENT_DECLINED" }), true);
await pause(800);
const auth = await attempt("authorize (real)", () => pp.authorizeOrder(order.orderId, `spike-auth:${RUN}`));
if (!auth?.authorizationId) throw new Error("authorization failed — see above");
const authId = auth.authorizationId;

// 3. capture: one mock code at a time; the hold must survive every mocked decline
const honoured: string[] = [];
for (const code of CAPTURE_CODES) {
  await pause(800);
  const r = await attempt(`capture · mock ${code}`, () => pp.captureAuthorization(authId, PRICE + SHIP_ACTUAL, `spike-cap-mock-${code}:${RUN}`, `PAYLET-SPIKE-${RUN}-M`, { mock: code }), true);
  if (!r && rows.at(-1)?.issue === code) honoured.push(code);
}
const afterMocks = await pp.getAuthorization(authId);
log({ step: "GET authorization after mocked declines", ok: afterMocks.status === "CREATED", paypalStatus: afterMocks.status, note: "hold still alive?" });

// 4. real partial capture, replayed with the same PayPal-Request-Id
const capKey = `spike-cap:${RUN}`;
const cap = await attempt("capture (real, partial: price + actual ship)", () => pp.captureAuthorization(authId, PRICE + SHIP_ACTUAL, capKey, `PAYLET-SPIKE-${RUN}`));
await pause(800);
const capAgain = await attempt("capture replay (same PayPal-Request-Id)", () => pp.captureAuthorization(authId, PRICE + SHIP_ACTUAL, capKey, `PAYLET-SPIKE-${RUN}`));
log({ step: "replay returned the same capture id", ok: !!cap?.captureId && cap.captureId === capAgain?.captureId });
const authAfterCap = await pp.getAuthorization(authId);
log({ step: "GET authorization after capture", ok: /CAPTURED/.test(authAfterCap.status), paypalStatus: authAfterCap.status });
const captureId = cap?.captureId;
if (!captureId) throw new Error("capture failed — see above");

// 5. tracking (twice) and refund (twice)
await pause(800);
const tracking = `9400100000${Date.now().toString().slice(-12)}`;
await attempt("track (USPS, notify payer)", () => pp.addTracking(order.orderId, captureId, tracking, "USPS"));
await pause(800);
const tr2 = await attempt("track replay (must be a no-op)", () => pp.addTracking(order.orderId, captureId, tracking, "USPS"));
log({ step: "tracking replay detected as already tracked", ok: tr2?.already === true });
await pause(800);
const ref = await attempt("refund (full)", () => pp.refundCapture(captureId, `refund:${captureId}`, "Paylet spike: the maker could not ship."));
await pause(800);
const ref2 = await attempt("refund replay (same PayPal-Request-Id)", () => pp.refundCapture(captureId, `refund:${captureId}`, "Paylet spike: the maker could not ship."));
log({ step: "refund replay returned the same refund id", ok: !!ref?.refundId && ref.refundId === ref2?.refundId, note: `${ref?.amountCents ?? "?"} cents` });
await pause(1500);
const capFinal = await pp.getCapture(captureId);
log({ step: "GET capture after refund", ok: capFinal.status === "REFUNDED", paypalStatus: capFinal.status });

const report = {
  ranAt: new Date().toISOString(),
  order: maskId(order.orderId),
  authorization: maskId(authId),
  capture: maskId(captureId),
  accountStatus: ident.accountStatus ?? null,
  honouredCaptureMockCodes: honoured,
  holdAliveAfterMocks: afterMocks.status === "CREATED",
  rows,
};
mkdirSync("data", { recursive: true });
writeFileSync("data/spike-negative-testing.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify({ honouredCaptureMockCodes: honoured, holdAliveAfterMocks: report.holdAliveAfterMocks, accountStatus: report.accountStatus }));
