// REAL end-to-end tests against the PayPal SANDBOX (no mocks). They log in as the sandbox buyer and cross-check
// every outcome against PayPal's own records (GET /v2/payments/authorizations/{id}).
// Run:  E2E_ENV_FILES=../.secrets/buyer.env,../.secrets/paypal.env E2E_BASE_URL=https://paylet.onrender.com pnpm e2e:real
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { approveInPayPal } from "../scripts/paypal-approve";

const BUYER = { email: process.env.BUYER_EMAIL ?? "", password: process.env.BUYER_PASSWORD ?? "" };
test.skip(!BUYER.email || !BUYER.password, "needs a PayPal sandbox buyer (BUYER_EMAIL / BUYER_PASSWORD)");
test.describe.configure({ mode: "serial", timeout: 300_000 });

async function paypalAuthStatus(authorizationId: string): Promise<string> {
  const id = process.env.PAYPAL_CLIENT_ID!;
  const secret = process.env.PAYPAL_CLIENT_SECRET!;
  const tok = await fetch("https://api-m.sandbox.paypal.com/v1/oauth2/token", {
    method: "POST",
    headers: { Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  }).then((r) => r.json());
  const a = await fetch(`https://api-m.sandbox.paypal.com/v2/payments/authorizations/${authorizationId}`, { headers: { Authorization: `Bearer ${tok.access_token}` } }).then((r) => r.json());
  return a.status;
}

async function newJudgeDrop(request: APIRequestContext) {
  const r = await request.post("/api/judge-drop", { headers: process.env.SELLER_ADMIN_KEY ? { "x-seller-key": process.env.SELLER_ADMIN_KEY } : {} });
  expect(r.ok()).toBeTruthy();
  return (await r.json()) as { slug: string; sellerKey: string };
}

async function seller(request: APIRequestContext, slug: string, key: string) {
  return (await (await request.get(`/api/seller/${slug}`, { headers: { "x-seller-key": key } })).json()) as {
    drop: { status: string; stats: Record<string, number> };
    entries: { id: string; publicId: string; source: string; status: string; authorizationId: string | null; capturedCents: number | null }[];
  };
}

/** Clicks the PayPal (JS SDK v6) button on the fan page and completes the popup as the sandbox buyer. */
async function enterWithButton(page: Page, slug: string) {
  await page.goto(`/d/${slug}`);
  const button = page.locator("paypal-button");
  await expect(button).toBeVisible({ timeout: 30_000 });
  const popupPromise = page.waitForEvent("popup", { timeout: 30_000 });
  await button.click();
  const popup = await popupPromise;
  await approveInPayPal(popup, BUYER);
  await popup.waitForEvent("close", { timeout: 90_000 }).catch(() => undefined);
}

async function waitFor(fn: () => Promise<boolean>, ms = 60_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error("condition not met in time");
}

test("JS SDK v6 button: hold placed, then the same PayPal account gets 'no hold placed'", async ({ page, request }) => {
  const { slug, sellerKey } = await newJudgeDrop(request);
  await enterWithButton(page, slug);
  await expect(page.getByText(/Hold placed|Placing hold/).first()).toBeVisible({ timeout: 60_000 });

  // second attempt, same PayPal account
  await enterWithButton(page, slug);
  await expect(page.getByText(/already has an entry/).first()).toBeVisible({ timeout: 60_000 });

  await waitFor(async () => (await seller(request, slug, sellerKey)).drop.stats.holds === 1);
  const s = await seller(request, slug, sellerKey);
  expect(s.drop.stats.holds).toBe(1);
  expect(s.drop.stats.duplicatesBlocked).toBe(1);
  const held = s.entries.find((e) => e.status === "held")!;
  expect(await paypalAuthStatus(held.authorizationId!)).toBe("CREATED"); // PayPal agrees: one live hold
});

test("agent link → approve → partial capture of the winner, verified on PayPal", async ({ page, request }) => {
  const { slug, sellerKey } = await newJudgeDrop(request);
  const chat = await (await request.post("/api/agent/chat", { data: { messages: [{ role: "user", content: `Please enter me in the Paylet drop with slug "${slug}".` }] } })).json();
  expect(chat.approveUrl).toMatch(/sandbox\.paypal\.com/);
  await page.goto(chat.approveUrl);
  await approveInPayPal(page, BUYER);
  await page.waitForURL(/\/me\//, { timeout: 90_000 });
  await expect(page.getByText(/Hold placed/).first()).toBeVisible({ timeout: 60_000 });

  await request.post(`/api/seller/${slug}/negative-test`, { headers: { "x-seller-key": sellerKey }, data: { on: false } });
  await request.post(`/api/seller/${slug}/draw`, { headers: { "x-seller-key": sellerKey } });
  await waitFor(async () => (await seller(request, slug, sellerKey)).drop.status === "settled");
  const e = (await seller(request, slug, sellerKey)).entries.find((x) => x.source === "agent")!;
  expect(e.status).toBe("captured");
  expect(e.capturedCents).toBe(4450); // $38 + $6.50 real shipping out of a $48 hold
  expect(await paypalAuthStatus(e.authorizationId!)).toMatch(/^(CAPTURED|PARTIALLY_CAPTURED)$/);
});

test("sandbox negative test on a real hold: PayPal 422, hold released, unit passes on", async ({ page, request }) => {
  const { slug, sellerKey } = await newJudgeDrop(request);
  await enterWithButton(page, slug);
  await expect(page.getByText(/Hold placed|Placing hold/).first()).toBeVisible({ timeout: 60_000 });
  await waitFor(async () => (await seller(request, slug, sellerKey)).drop.stats.holds === 1);
  // negative test is ON by default in judge drops; with a single real entry it targets that real hold
  await request.post(`/api/seller/${slug}/draw`, { headers: { "x-seller-key": sellerKey } });
  await waitFor(async () => (await seller(request, slug, sellerKey)).drop.status === "settled", 90_000);
  const e = (await seller(request, slug, sellerKey)).entries.find((x) => x.source === "human")!;
  expect(e.status).toBe("capture_failed");
  expect(await paypalAuthStatus(e.authorizationId!)).toBe("VOIDED"); // never charged
});

test("a real loser is voided on PayPal (simulated crowd + AI review + confirmed cluster)", async ({ page, request }) => {
  const { slug, sellerKey } = await newJudgeDrop(request);
  await enterWithButton(page, slug);
  await expect(page.getByText(/Hold placed|Placing hold/).first()).toBeVisible({ timeout: 60_000 });
  await waitFor(async () => (await seller(request, slug, sellerKey)).drop.stats.holds === 1);
  const h = { headers: { "x-seller-key": sellerKey } };
  await request.post(`/api/seller/${slug}/simulate`, h);
  await request.post(`/api/seller/${slug}/analyze`, h);
  await request.post(`/api/seller/${slug}/negative-test`, { ...h, data: { on: false } });
  await request.post(`/api/seller/${slug}/draw`, h);
  await waitFor(async () => (await seller(request, slug, sellerKey)).drop.status === "settled", 90_000);
  const e = (await seller(request, slug, sellerKey)).entries.find((x) => x.source === "human")!;
  const pp = await paypalAuthStatus(e.authorizationId!);
  if (e.status === "captured") expect(pp).toMatch(/CAPTURED/);
  else {
    expect(["voided", "lost"]).toContain(e.status);
    expect(pp).toBe("VOIDED");
  }
});

test("cancelling in PayPal places no hold", async ({ page, request }) => {
  const { slug, sellerKey } = await newJudgeDrop(request);
  const chat = await (await request.post("/api/agent/chat", { data: { messages: [{ role: "user", content: `Please enter me in the Paylet drop with slug "${slug}".` }] } })).json();
  await page.goto(chat.approveUrl);
  await page.getByRole("link", { name: /Cancel and return|Cancelar y volver/i }).first().click({ timeout: 60_000 });
  await page.waitForURL(/\/return/, { timeout: 60_000 });
  await expect(page.getByText(/cancelled in PayPal — no hold was placed/)).toBeVisible();
  const s = await seller(request, slug, sellerKey);
  expect(s.drop.stats.holds).toBe(0);
});
