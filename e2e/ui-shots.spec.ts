// Screenshots of the v2 UI with mocked data, desktop 1440x900 and mobile 390x844 (for design review and the gallery).
//   SHOTS_DIR=../shots/v2/B E2E_BASE_URL=http://localhost:8792 npx playwright test e2e/ui-shots.spec.ts
// Skipped unless SHOTS_DIR is set. Uses the mocks from ui-mocks.ts, so no PayPal login, no LLM, no secrets on screen.
import { expect, test, type Page } from "@playwright/test";
import { join } from "node:path";
import { KEY, SLUG, aiSummary, json, mockDrop, now, publicDrop, sellerEntries } from "./ui-mocks";

const DIR = process.env.SHOTS_DIR ?? "";
test.skip(!DIR, "set SHOTS_DIR to take screenshots");

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
] as const;

async function shot(page: Page, name: string, vp: string, fullPage = true) {
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(DIR, `${vp}-${name}.png`), fullPage });
}

/** Close-ups of single sections (the full-page mobile shot is too tall to review). */
async function parts(page: Page, vp: string, prefix: string, sel: Record<string, string>) {
  for (const [name, css] of Object.entries(sel)) {
    const el = page.locator(css).first();
    if (await el.count()) await el.screenshot({ path: join(DIR, `${vp}-${prefix}-${name}.png`) });
  }
}

async function noOverflow(page: Page) {
  const w = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, win: window.innerWidth }));
  expect(w.doc, "page must not scroll sideways").toBeLessThanOrEqual(w.win);
}

for (const vp of VIEWPORTS) {
  test.describe(vp.name, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test(`console mid-flow (${vp.name})`, async ({ page }) => {
      await mockDrop(page, { status: "open", stage: "mid" });
      await page.goto(`/seller/${SLUG}#k=${KEY}`);
      await expect(page.getByTestId("cluster-operator")).toBeVisible();
      await page.locator(".kept-apart summary").click();
      await noOverflow(page);
      await shot(page, "console-mid", vp.name);
      await parts(page, vp.name, "mid", { head: ".seller-head", stats: ".stats-groups", stepper: ".stepper-card", clusters: "#clusters", entries: ".entries" });
      await page.getByTestId("step-draw").click();
      await expect(page.getByTestId("draw-pending")).toBeVisible();
      await shot(page, "console-draw-pending", vp.name, false);
    });

    test(`console degraded AI + ready to draw (${vp.name})`, async ({ page }) => {
      const cl = (await import("./ui-mocks")).clusters("mid").map((c) => ({ ...c, status: "confirmed" }));
      await mockDrop(page, { status: "open", stage: "mid", clusters: cl, ai: { ...aiSummary, degraded: "The model timed out after 25 s." } });
      await page.goto(`/seller/${SLUG}#k=${KEY}`);
      await expect(page.getByTestId("ai-degraded")).toBeVisible();
      await parts(page, vp.name, "degraded", { banner: "[data-testid=ai-degraded]", stepper: ".stepper-card" });
      await page.getByTestId("step-draw").click();
      await expect(page.getByTestId("draw-copy")).toBeVisible();
      await shot(page, "console-draw-confirm", vp.name, false);
    });

    test(`console settled (${vp.name})`, async ({ page }) => {
      await mockDrop(page, { status: "settled", stage: "settled" });
      await page.goto(`/seller/${SLUG}#k=${KEY}`);
      await expect(page.getByTestId("settlement-summary")).toBeVisible();
      await expect(page.getByTestId("ledger-group")).toBeVisible();
      await noOverflow(page);
      await shot(page, "console-settled", vp.name);
      await parts(page, vp.name, "settled", { stepper: ".stepper-card", report: ".report", entries: ".entries" });
      await page.locator(".pp-call summary").first().click();
      await page.getByTestId("ledger").scrollIntoViewIfNeeded();
      await page.getByTestId("ledger").screenshot({ path: join(DIR, `${vp.name}-ledger-trace.png`) });
      await page.getByTestId("refund").first().click();
      await shot(page, "console-refund-dialog", vp.name, false);
    });

    test(`judge checklist (${vp.name})`, async ({ page }) => {
      await page.addInitScript(([slug, key]) => localStorage.setItem("paylet.judge", JSON.stringify({ slug, sellerKey: key })), [SLUG, KEY]);
      await mockDrop(page, { status: "open", stage: "mid" });
      await json(page, "**/api/config", { clientId: "x", environment: "sandbox", mcpUrl: "https://paylet.onrender.com/mcp", publicUrl: "https://paylet.onrender.com" });
      await json(page, "**/api/judge-buyers*", {
        buyers: [
          { label: "Buyer A", email: "maya.chen@example.sandbox", password: "not-a-real-pass" },
          { label: "Buyer B", email: "diego.chen@example.sandbox", password: "not-a-real-pass" },
        ],
      });
      await json(page, "**/api/proof", { slug: "proof-run", summary: "3 real buyers · 1 duplicate blocked · 1 failed payment recovered.", checkedAt: now });
      await page.goto("/judge?code=DEMO");
      await expect(page.getByTestId("check-agents")).toHaveAttribute("data-done", "1");
      await noOverflow(page);
      await shot(page, "judge", vp.name);
      await parts(page, vp.name, "judge", { checklist: ".judge-main", buyers: ".buyers", byo: ".byo" });
    });

    test(`judge empty (${vp.name})`, async ({ page }) => {
      await page.goto("/judge?fresh=1");
      await expect(page.getByTestId("judge-start")).toBeVisible();
      await noOverflow(page);
      await shot(page, "judge-empty", vp.name);
    });

    test(`fan page settled (${vp.name})`, async ({ page }) => {
      await mockDrop(page, { status: "settled", stage: "settled" });
      await page.goto(`/d/${SLUG}`);
      await expect(page.getByTestId("settlement-summary")).toBeVisible();
      await noOverflow(page);
      await shot(page, "fan-settled", vp.name);
    });

    test(`/me shipped (${vp.name})`, async ({ page }) => {
      const e = sellerEntries("settled")[0];
      await json(page, "**/api/entries/ent_mock", {
        entryId: "ent_mock",
        publicId: e.publicId,
        source: "human",
        agentLabel: null,
        status: "captured",
        holdCents: 4800,
        capturedCents: 4450,
        refundedCents: null,
        note: null,
        explanation: null,
        approveUrl: null,
        payerVerified: true,
        shipping: { carrier: "USPS", tracking: "9400111899223197428490" },
        timeline: { requestedAt: now - 600_000, approvedAt: now - 590_000, heldAt: now - 585_000, drawAt: now - 96_000, settledAt: now - 90_000 },
        drop: { ...publicDrop("settled"), status: "settled" },
      });
      await page.goto("/me/ent_mock");
      await expect(page.getByTestId("shipped-tag")).toBeVisible();
      await noOverflow(page);
      await shot(page, "me-shipped", vp.name);
    });

    test(`404 (${vp.name})`, async ({ page }) => {
      await page.goto("/no/such/page");
      await noOverflow(page);
      await shot(page, "404", vp.name);
    });
  });
}
