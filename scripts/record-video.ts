// Records the demo-video scenes (entrega/VIDEO.md storyboard) against a live instance, one clip per scene.
// Silent footage for a human voice-over. Records page content only (no address bar, so seller keys never show) and blurs
// the sandbox buyer's email inside PayPal. Needs BUYER_EMAIL / BUYER_PASSWORD (sandbox) and SELLER_ADMIN_KEY (quota bypass).
//   node --env-file=../.secrets/buyer.env --env-file=../.secrets/seller_admin.env --import tsx scripts/record-video.ts [base] [outDir] [scenes]
import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { mkdirSync, renameSync } from "node:fs";
import { approveInPayPal } from "./paypal-approve";

const base = process.argv[2] ?? "https://paylet.onrender.com";
const out = process.argv[3] ?? "../entrega/video";
const only = process.argv[4]?.split(",");
const BUYER = { email: process.env.BUYER_EMAIL ?? "", password: process.env.BUYER_PASSWORD ?? "" };
const ADMIN = process.env.SELLER_ADMIN_KEY ?? "";
const W = 1280;
const H = 720;
mkdirSync(`${out}/raw`, { recursive: true });

const post = (p: string, key?: string, data?: unknown) =>
  fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...(key ? { "x-seller-key": key } : {}) }, body: JSON.stringify(data ?? {}) }).then((r) => r.json());
const sellerState = (slug: string, key: string) => fetch(`${base}/api/seller/${slug}`, { headers: { "x-seller-key": key } }).then((r) => r.json());
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function scene(browser: Browser, name: string, run: (page: Page, ctx: BrowserContext) => Promise<void>) {
  if (only && !only.includes(name.slice(0, 2))) return;
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, recordVideo: { dir: `${out}/raw`, size: { width: W, height: H } }, locale: "en-US" });
  // blur the sandbox login identity inside PayPal (fictitious sandbox data, but it never needs to be on screen)
  await ctx.addInitScript(() => {
    if (!/paypal\.com$/.test(location.hostname)) return;
    const css = "#email,input[name=login_email],#password,[data-testid=header-profile],.profileDisplayName,.email{filter:blur(7px)!important}";
    const add = () => {
      const s = document.createElement("style");
      s.textContent = css;
      (document.head ?? document.documentElement).appendChild(s);
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", add);
    else add();
  });
  const page = await ctx.newPage();
  const t0 = Date.now();
  try {
    await run(page, ctx);
  } catch (e) {
    console.log(`scene ${name} FAILED:`, (e as Error).message.split("\n")[0]);
    await page.screenshot({ path: `${out}/raw/${name}-fail.png` }).catch(() => undefined);
  }
  const video = page.video();
  await ctx.close();
  if (video) renameSync(await video.path(), `${out}/raw/${name}.webm`);
  console.log(`scene ${name}: ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

/** Smooth scroll by `px` over `ms`. */
async function glide(page: Page, px: number, ms: number) {
  const steps = Math.max(1, Math.round(ms / 60)); // each wheel event round-trips the browser (~40 ms)
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, px / steps);
    await wait(16);
  }
}

async function open(page: Page, path: string, settle = 1200) {
  await page.goto(base + path, { waitUntil: "load" }).catch(() => undefined);
  await page.mouse.move(W - 40, H / 2);
  await wait(settle);
}

const browser = await chromium.launch();
// Drop A: the real-money drop (fan + agent + PayPal). Drop B: scale, AI review, failed payment.
const A = await post("/api/judge-drop", ADMIN);
const B = await post("/api/judge-drop", ADMIN);
await post(`/api/seller/${A.slug}/negative-test`, A.sellerKey, { on: false });
console.log("drop A", A.slug, "drop B", B.slug);

await scene(browser, "01-home", async (page) => {
  await open(page, "/", 2500);
  await glide(page, 900, 7000);
  await wait(1500);
  await glide(page, 600, 3000);
  await wait(1000);
});

await scene(browser, "02-drop", async (page) => {
  await open(page, `/d/${A.slug}`, 2000);
  await page.locator("paypal-button").waitFor({ timeout: 30_000 });
  await page.locator("paypal-button").hover();
  await wait(4000);
  await glide(page, 350, 1500);
  await wait(1500);
});

await scene(browser, "03-agent", async (page) => {
  await open(page, `/agent?drop=${A.slug}`, 1500);
  await page.getByRole("button", { name: /Get me into this drop/ }).click();
  await page.getByText(/Your agent stopped here/).waitFor({ timeout: 120_000 });
  await wait(3500);
  const link = page.getByRole("link", { name: /Approve .* hold in PayPal/ });
  await link.hover();
  await wait(1200);
  const href = await link.getAttribute("href");
  await page.goto(href!);
  await approveInPayPal(page, BUYER);
  await page.waitForURL(/\/me\//, { timeout: 90_000 });
  await page.getByText(/Hold placed/).first().waitFor({ timeout: 60_000 });
  await wait(4000);
});

await scene(browser, "04-duplicate-and-swarm", async (page, ctx) => {
  await open(page, `/d/${A.slug}`, 1500);
  const popupPromise = ctx.waitForEvent("page", { timeout: 30_000 });
  await page.locator("paypal-button").click();
  const popup = await popupPromise;
  await approveInPayPal(popup, BUYER);
  await popup.waitForEvent("close", { timeout: 90_000 }).catch(() => undefined);
  await page.getByText(/already has an entry/).first().waitFor({ timeout: 60_000 });
  await page.getByText(/already has an entry/).first().scrollIntoViewIfNeeded();
  await wait(4000);
  await open(page, `/seller/${A.slug}?k=${A.sellerKey}`, 1500);
  await page.getByTestId("step-swarm").click();
  await page.getByTestId("step-swarm-result").filter({ hasText: /PayPal links · 0 holds/ }).waitFor({ timeout: 90_000 });
  await wait(1500);
  await page.getByTestId("ledger").scrollIntoViewIfNeeded();
  await wait(4000);
});

await scene(browser, "05-crowd-ai", async (page) => {
  await open(page, `/seller/${B.slug}?k=${B.sellerKey}`, 1500);
  await page.getByTestId("step-crowd").click();
  await page.getByTestId("step-crowd-row").and(page.locator('[data-state="done"]')).waitFor({ timeout: 30_000 });
  await wait(1500);
  await page.getByTestId("step-ai").click();
  await page.getByTestId("cluster-operator").first().waitFor({ timeout: 180_000 });
  await wait(800);
  await page.getByTestId("cluster-operator").first().scrollIntoViewIfNeeded();
  await glide(page, 120, 600);
  await wait(6000);
  let pending = await page.getByTestId("cluster-confirm").count();
  while (pending > 0) {
    await page.getByTestId("cluster-confirm").first().click();
    await wait(1600);
    pending = await page.getByTestId("cluster-confirm").count();
  }
  await wait(2000);
  await open(page, "/evals", 1500);
  await glide(page, 330, 1500);
  await wait(5000);
});

await scene(browser, "06-draw", async (page) => {
  await open(page, `/seller/${B.slug}?k=${B.sellerKey}`, 1500);
  await page.getByTestId("step-draw").click();
  await page.getByTestId("confirm-ok").click();
  await page.getByTestId("step-draw-row").and(page.locator('[data-state="done"]')).waitFor({ timeout: 180_000 });
  await wait(1500);
  await page.getByTestId("ledger").scrollIntoViewIfNeeded();
  await wait(5000);
  await page.locator(".report").first().scrollIntoViewIfNeeded().catch(() => undefined);
  await wait(4000);
  // drop A: the real PayPal partial capture
  await open(page, `/seller/${A.slug}?k=${A.sellerKey}`, 1500);
  await page.getByTestId("step-draw").click();
  await page.getByTestId("confirm-ok").click();
  await page.getByTestId("step-draw-row").and(page.locator('[data-state="done"]')).waitFor({ timeout: 180_000 });
  await wait(1500);
  await page.getByTestId("ledger").scrollIntoViewIfNeeded();
  await wait(5000);
});

await scene(browser, "07-verify", async (page) => {
  await open(page, `/verify/${B.slug}`, 1500);
  await page.getByRole("button", { name: /Re-run the draw here/ }).click();
  await page.getByText("Recorded outcome is consistent with your computation.").waitFor({ timeout: 30_000 });
  await page.getByText("Recorded outcome is consistent with your computation.").scrollIntoViewIfNeeded();
  await wait(4000);
  const ask = page.getByRole("button", { name: /Ask PayPal now/ });
  if (await ask.count()) {
    await open(page, `/verify/${A.slug}`, 1200);
    await page.getByRole("button", { name: /Ask PayPal now/ }).scrollIntoViewIfNeeded();
    await page.getByRole("button", { name: /Ask PayPal now/ }).click();
    await wait(6000);
  }
});

await scene(browser, "08-how", async (page) => {
  await open(page, "/how?reveal=1", 600);
  await glide(page, 330, 1200);
  await wait(14000);
});

await scene(browser, "09-outro", async (page) => {
  await open(page, "/", 6000);
});

await browser.close();
