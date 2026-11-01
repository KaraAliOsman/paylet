// /judge as a live checklist, against a running Paylet with the v2 API mocked (no PayPal, no LLM).
//   E2E_BASE_URL=http://localhost:8792 npx playwright test e2e/ui-judge.spec.ts
import { expect, test, type Page } from "@playwright/test";
import { KEY, SLUG, collectErrors, json, mockDrop, now, type ConsoleState } from "./ui-mocks";

const remember = (page: Page) =>
  page.addInitScript(([slug, key]) => localStorage.setItem("paylet.judge", JSON.stringify({ slug, sellerKey: key })), [SLUG, KEY]);
const config = (page: Page) =>
  json(page, "**/api/config", { clientId: "x", environment: "sandbox", mcpUrl: "https://paylet.onrender.com/mcp", publicUrl: "https://paylet.onrender.com" });

test("the checklist ticks itself from the drop's stats, with deep links and a countdown", async ({ page }) => {
  const errors = collectErrors(page);
  await remember(page);
  const state: ConsoleState = { status: "open", stage: "mid" };
  await mockDrop(page, state);
  await page.goto("/judge");
  for (const k of ["created", "enter", "again", "agents"]) await expect(page.getByTestId(`check-${k}`)).toHaveAttribute("data-done", "1");
  await expect(page.getByTestId("check-enter")).toContainText("2 PayPal holds placed · nothing charged");
  await expect(page.getByTestId("check-again")).toContainText("1 same-account duplicate → no hold");
  await expect(page.getByTestId("check-agents")).toContainText("12 agent requests · 0 holds without a person");
  const review = page.getByTestId("check-review");
  await expect(review).toHaveAttribute("aria-current", "step");
  await expect(review).toContainText("2 AI suggestions waiting for your decision");
  await expect(review.getByRole("link", { name: "Seller console" })).toHaveAttribute("href", `/seller/${SLUG}#k=${KEY}`);
  await expect(page.getByTestId("check-verify").getByRole("link", { name: "Verify page" })).toHaveAttribute("href", `/verify/${SLUG}`);
  await expect(page.locator(".countdown-chip")).toContainText(/closes in \d+m \d+s/);

  // the drop settles: steps 5-6 tick on the next poll; step 7 ticks once this browser verified it
  state.status = "settled";
  state.stage = "settled";
  await expect(page.getByTestId("check-draw")).toHaveAttribute("data-done", "1", { timeout: 10_000 });
  await expect(page.getByTestId("check-review")).toHaveAttribute("data-done", "1");
  await expect(page.getByTestId("check-review")).toContainText("5 accounts merged into shared tickets");
  await expect(page.getByTestId("check-verify")).toHaveAttribute("data-done", "0");
  await page.evaluate((s) => localStorage.setItem(`paylet.verified.${s}`, "1"), SLUG);
  await page.reload();
  await expect(page.getByTestId("check-verify")).toHaveAttribute("data-done", "1");
  await expect(page.getByText(/Your drop is settled/)).toBeVisible();
  expect(errors).toEqual([]);
});

test("after the draw, steps that never happened read as skipped and Verify becomes the next step", async ({ page }) => {
  await remember(page);
  const settled = (await import("./ui-mocks")).publicDrop("settled");
  await mockDrop(page, { status: "settled", stage: "settled", dropOver: { stats: { ...settled.stats, holds: 0, duplicatesBlocked: 0 } } });
  await page.goto("/judge");
  await expect(page.getByTestId("check-draw")).toHaveAttribute("data-done", "1");
  await expect(page.getByTestId("check-enter")).toHaveClass(/skipped/);
  await expect(page.getByTestId("check-enter")).toContainText("Not done in this drop: entries are closed.");
  await expect(page.getByTestId("check-verify")).toHaveAttribute("aria-current", "step");
});

test("starting a drop: the drop and its key ride in the URL fragment, never the query", async ({ page }) => {
  await page.route("**/api/judge-drop", (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify({ slug: SLUG, sellerKey: KEY }) }));
  await mockDrop(page, { status: "open", stage: "mid" });
  await page.goto("/judge?fresh=1");
  await expect(page.getByTestId("check-created")).toHaveAttribute("aria-current", "step");
  await page.getByTestId("judge-start").click();
  await expect(page.getByTestId("check-created")).toHaveAttribute("data-done", "1");
  const url = new URL(page.url());
  expect(url.search).toBe("");
  expect(url.hash).toBe(`#d=${SLUG}&k=${KEY}`);
  expect(JSON.parse((await page.evaluate(() => localStorage.getItem("paylet.judge")))!)).toEqual({ slug: SLUG, sellerKey: KEY });
});

test("an old ?d=&k= judge link still works and moves to the fragment", async ({ page }) => {
  await mockDrop(page, { status: "open", stage: "mid" });
  await page.goto(`/judge?d=${SLUG}&k=${KEY}`);
  await expect(page.getByTestId("check-created")).toHaveAttribute("data-done", "1");
  expect(new URL(page.url()).search).toBe("");
  expect(new URL(page.url()).hash).toBe(`#d=${SLUG}&k=${KEY}`);
});

test("sandbox buyers only with ?code=; passwords hidden until asked; a wrong code says so", async ({ page }) => {
  await page.goto("/judge?fresh=1");
  await expect(page.getByTestId("buyers-locked")).toContainText("Credentials are in the Devpost testing instructions. Open the /judge?code=… link from there.");

  await json(page, /\/api\/judge-buyers\?code=GOOD$/, {
    buyers: [
      { label: "Buyer A", email: "a@example.sandbox", password: "pw-a-0000" },
      { label: "Buyer B", email: "b@example.sandbox", password: "pw-b-0000" },
    ],
  });
  await page.goto("/judge?code=GOOD");
  await expect(page.getByTestId("buyer")).toHaveCount(2);
  expect(new URL(page.url()).search).toBe(""); // the code is remembered, not left in the address bar
  const a = page.getByTestId("buyer").first();
  await expect(a).toContainText("a@example.sandbox");
  await expect(a).not.toContainText("pw-a-0000");
  await a.getByRole("button", { name: "Show" }).click();
  await expect(a).toContainText("pw-a-0000");
  // remembered for this browser: /judge from the nav still shows the box
  await page.goto("/judge");
  await expect(page.getByTestId("buyer")).toHaveCount(2);

  await json(page, /\/api\/judge-buyers\?code=BAD$/, { error: "not_found" }, 404);
  await page.goto("/judge?code=BAD");
  await expect(page.getByTestId("buyers")).toContainText("That code didn't work.");
});

test("bring your own agent: Claude Code, VS Code and Inspector snippets, plus what to tell it", async ({ page }) => {
  await remember(page);
  await mockDrop(page, { status: "open", stage: "mid" });
  await config(page);
  await page.goto("/judge");
  const byo = page.getByTestId("byo-agent");
  await expect(byo).toContainText("claude mcp add --transport http paylet https://paylet.onrender.com/mcp");
  await expect(byo).toContainText('"url": "https://paylet.onrender.com/mcp"');
  await expect(byo).toContainText("npx @modelcontextprotocol/inspector");
  await expect(byo).toContainText(`Enter me in https://paylet.onrender.com/d/${SLUG}`);
});

test("the proof drop link appears only when there is one", async ({ page }) => {
  await json(page, "**/api/proof", { slug: "proof-run", summary: "3 real buyers · 1 duplicate blocked.", checkedAt: now });
  await page.goto("/judge?fresh=1");
  await expect(page.getByTestId("judge-proof").getByRole("link", { name: /See the proof drop/ })).toHaveAttribute("href", "/verify/proof-run");
  await page.unroute("**/api/proof");
  await json(page, "**/api/proof", { slug: null, summary: null, checkedAt: null });
  await page.reload();
  await expect(page.getByTestId("judge-start")).toBeVisible();
  await expect(page.getByTestId("judge-proof")).toHaveCount(0);
});
