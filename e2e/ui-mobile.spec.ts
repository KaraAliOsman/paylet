// Phone width (390x844), empty states and 404s, against a running Paylet with the v2 API mocked where needed.
//   E2E_BASE_URL=http://localhost:8792 npx playwright test e2e/ui-mobile.spec.ts
import { expect, test, type Page } from "@playwright/test";
import { KEY, SLUG, aiSummary, collectErrors, json, mockDrop, now, publicDrop } from "./ui-mocks";

test.use({ viewport: { width: 390, height: 844 } });

async function fitsPhone(page: Page) {
  const w = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, win: window.innerWidth }));
  expect(w.doc, `${page.url()} scrolls sideways at 390 px`).toBeLessThanOrEqual(w.win);
}

test("public pages never scroll sideways at 390 px", async ({ page }) => {
  const errors = collectErrors(page);
  for (const path of ["/", "/how", "/agent", "/evals", "/judge?fresh=1", "/no/such/page"]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    await fitsPhone(page);
  }
  expect(errors).toEqual([]);
});

test("console, fan page and /verify fit a phone (settled drop with long PayPal traces)", async ({ page }) => {
  await mockDrop(page, { status: "settled", stage: "settled" });
  await json(page, `**/api/drops/${SLUG}/verify`, {
    title: "Ember Glaze Mug",
    status: "settled",
    units: 2,
    waitlistSize: 3,
    seedHash: "5f0e4b1c9a7d3e2f8b6a4c1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f",
    seed: "9f2c1a7e44b0d3c8a1e5f6b7c8d9e0f1a2b3c4d5e6f708192a3b4c5d6e7f8091",
    frozenHash: "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
    frozenList: ["E-7K2Q", "E-AB12"],
    outcome: [],
  });
  await page.goto(`/seller/${SLUG}#k=${KEY}`);
  await expect(page.getByTestId("settlement-summary")).toBeVisible();
  await fitsPhone(page);
  // the entries table scrolls inside its card instead of squeezing the page
  const wrap = await page.locator(".entries .table-wrap").evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }));
  expect(wrap.sw).toBeGreaterThanOrEqual(wrap.cw);
  // ledger times never wrap
  for (const h of await page.getByTestId("ledger").locator("ol > li > time").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height)))
    expect(h).toBeLessThan(24);
  await page.goto(`/d/${SLUG}`);
  await expect(page.getByTestId("settlement-summary")).toBeVisible();
  await fitsPhone(page);
  await page.goto(`/verify/${SLUG}`);
  await expect(page.getByRole("button", { name: "Re-run the draw here" })).toBeVisible();
  await fitsPhone(page);
});

test("/judge with a drop, buyers and agent snippets fits a phone", async ({ page }) => {
  await page.addInitScript(([slug, key]) => localStorage.setItem("paylet.judge", JSON.stringify({ slug, sellerKey: key })), [SLUG, KEY]);
  await mockDrop(page, { status: "open", stage: "mid" });
  await json(page, "**/api/config", { clientId: "x", mcpUrl: "https://paylet.onrender.com/mcp" });
  await json(page, /\/api\/judge-buyers\?code=X$/, { buyers: [{ label: "Buyer A", email: "a.very.long.sandbox.address@personal.example.com", password: "p" }] });
  await page.goto("/judge?code=X");
  await expect(page.getByTestId("buyer")).toBeVisible();
  await expect(page.getByTestId("check-agents")).toHaveAttribute("data-done", "1");
  await fitsPhone(page);
});

test("empty console: friendly empty states, nothing broken", async ({ page }) => {
  await mockDrop(page, { status: "open", stage: "mid", entries: [], clusters: [], events: [], ai: { ...aiSummary, ranAt: null } });
  await page.goto(`/seller/${SLUG}#k=${KEY}`);
  await expect(page.getByText("No entries yet. Enter from the fan page, or run step 1 or 2.")).toBeVisible();
  await expect(page.getByText("Run the AI review (step 3) to look for accounts")).toBeVisible();
  await expect(page.getByTestId("ledger")).toContainText("Nothing yet. PayPal calls show up here as they happen.");
  await expect(page.getByTestId("step-swarm-row")).toHaveAttribute("data-state", "current");
  await expect(page.getByTestId("step-decide-result")).toHaveText("Nothing to decide yet");
  await fitsPhone(page);
});

test("a drop or entry that no longer exists gets the 'gone' page with a way back", async ({ page }) => {
  await json(page, "**/api/drops/gone-0000", { error: "drop_not_found" }, 404);
  await page.goto("/d/gone-0000");
  await expect(page.getByRole("heading", { name: "That drop isn't here anymore" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Start a fresh judge drop" })).toHaveAttribute("href", "/judge?fresh=1");
  await fitsPhone(page);

  await json(page, "**/api/seller/gone-0000", { error: "drop_not_found" }, 404);
  await page.goto(`/seller/gone-0000#k=${KEY}`);
  await expect(page.getByRole("heading", { name: "That drop isn't here anymore" })).toBeVisible();

  await json(page, "**/api/entries/gone-entry", { error: "entry_not_found" }, 404);
  await page.goto("/me/gone-entry");
  await expect(page.getByRole("heading", { name: "That entry isn't here anymore" })).toBeVisible();
});

test("/me after a refund: refunded, owes nothing", async ({ page }) => {
  await json(page, "**/api/entries/ent_mock", {
    entryId: "ent_mock",
    publicId: "E-7K2Q",
    source: "human",
    agentLabel: null,
    status: "refunded",
    holdCents: 4800,
    capturedCents: 4450,
    refundedCents: 4450,
    note: null,
    explanation: null,
    approveUrl: null,
    payerVerified: true,
    shipping: null,
    timeline: { requestedAt: now - 600_000, approvedAt: now - 590_000, heldAt: now - 585_000, drawAt: now - 96_000, settledAt: now - 90_000 },
    drop: { ...publicDrop("settled"), status: "settled" },
  });
  await page.goto("/me/ent_mock");
  await expect(page.locator(".pill").first()).toHaveText("Refunded — you owe nothing");
  await expect(page.locator(".kv")).toContainText("$44.50 · you owe nothing");
  await expect(page.locator(".htl-step").last()).toContainText("Refunded $44.50");
  await fitsPhone(page);
});
