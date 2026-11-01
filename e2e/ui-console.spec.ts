// Seller console, ledger and Drop report against a running Paylet with the v2 API mocked (no PayPal, no LLM).
//   E2E_BASE_URL=http://localhost:8792 npx playwright test e2e/ui-console.spec.ts
import { expect, test } from "@playwright/test";
import { KEY, SLUG, aiSummary, clusters, collectErrors, events, json, mockDrop, now, report, type ConsoleState } from "./ui-mocks";

const open = (page: import("@playwright/test").Page) => page.goto(`/seller/${SLUG}#k=${KEY}`);

test("seller key: #k= is sent as a header and kept for reloads; an old ?k= link moves to the fragment", async ({ page }) => {
  await mockDrop(page, { status: "open", stage: "mid" });
  await page.goto(`/seller/${SLUG}?k=${KEY}`);
  await expect(page.getByRole("heading", { name: "Ember Glaze Mug" })).toBeVisible();
  expect(new URL(page.url()).search).toBe("");
  expect(new URL(page.url()).hash).toBe(`#k=${KEY}`);
  expect(await page.evaluate((s) => sessionStorage.getItem(`paylet.k.${s}`), SLUG)).toBe(KEY);
  await page.goto(`/seller/${SLUG}`);
  await expect(page.getByRole("heading", { name: "Ember Glaze Mug" })).toBeVisible();
});

test("a console link without its key explains itself (no raw error code)", async ({ page }) => {
  await mockDrop(page, { status: "open", stage: "mid" });
  await page.goto(`/seller/${SLUG}`);
  await expect(page.getByRole("heading", { name: "This console needs its private link" })).toBeVisible();
  await expect(page.getByText("This console link is missing its key. Open it from /judge.")).toBeVisible();
  await expect(page.getByText("seller_key_required")).toHaveCount(0);
});

test("stepper: ✓ and a result per step; real and simulated numbers apart; entries default to Real", async ({ page }) => {
  const errors = collectErrors(page);
  await mockDrop(page, { status: "open", stage: "mid" });
  await open(page);
  await expect(page.getByTestId("step-swarm-row")).toHaveAttribute("data-state", "done");
  await expect(page.getByTestId("step-swarm-result")).toHaveText("12 PayPal links · 0 holds");
  await expect(page.getByTestId("step-crowd-result")).toHaveText("24 entrants (labelled)");
  await expect(page.getByTestId("step-ai-result")).toHaveText("6 pairs reviewed · 1 linked · 4 kept apart");
  await expect(page.getByTestId("step-decide-row")).toHaveAttribute("data-state", "current");
  await expect(page.getByTestId("step-decide-row")).toContainText("Decide (2 pending)");
  await expect(page.getByTestId("step-draw-row")).toHaveAttribute("data-state", "todo");
  // no emoji in the console controls any more (SVG icons)
  expect(await page.locator(".stepper").innerText()).not.toMatch(/\p{Extended_Pictographic}/u);

  await expect(page.getByTestId("stats-real")).toContainText("PayPal sandbox · real");
  await expect(page.getByTestId("stats-real").locator(".stat").filter({ hasText: "orders created" })).toContainText("15");
  await expect(page.getByTestId("stats-sim").locator(".stat").filter({ hasText: "entrants" })).toContainText("24");

  await expect(page.getByTestId("filter-real")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("filter-all")).toHaveText("All 39");
  await expect(page.getByTestId("filter-simulated")).toHaveText("Simulated 24");
  await expect(page.getByTestId("entry-row")).toHaveCount(15);
  await page.getByTestId("filter-simulated").click();
  await expect(page.getByTestId("filter-simulated")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("entry-row")).toHaveCount(24);
  await expect(page.locator("tr.sim").first()).toContainText("$48.00 (sim)");
  expect(errors).toEqual([]);
});

test("AI review: what it linked and kept apart, operator networks first, address diff marks the differing tokens", async ({ page }) => {
  await mockDrop(page, { status: "open", stage: "mid" });
  await open(page);
  await expect(page.getByTestId("ai-panel")).toContainText("MiMo V2.6 Pro reviewed 6 uncertain pairs → 1 linked · 4 pairs kept apart");
  await page.getByText("Kept apart by AI (4)").click();
  await expect(page.locator(".kept-apart li")).toHaveCount(4);
  await expect(page.locator(".kept-apart li").first()).toContainText("Apt 2 vs Apt 5 at 132 Elm St");
  await expect(page.locator(".clusters > article").first()).toHaveAttribute("data-testid", "cluster-operator");
  const net = page.getByTestId("cluster-operator");
  await expect(net.locator(".badge-ai")).toHaveText("MiMo V2.6 Pro · 93%");
  await expect(net.locator(".explain-ai")).toBeVisible();
  await expect(net.locator(".addr-key code")).toHaveText("1200 HARBOR BLVD STE 4B 43215");
  expect(await net.locator("mark").allInnerTexts()).toEqual(["Harbour", "Suite", "Boulevard", "#4B", "4-B", "Bl", "Unit"]);
  await expect(page.getByTestId("cluster-household").locator(".badge-rules")).toHaveText("Rules · 98%");
});

test("draw: confirm first, pending suggestions block it, 409s are explained, frozen → drand → settled with the report", async ({ page }) => {
  const errors = collectErrors(page);
  const state: ConsoleState = { status: "open", stage: "mid", clusters: clusters("mid") };
  let draws = 0;
  await mockDrop(page, state, async (path, body, route) => {
    const m = path.match(/^clusters\/(.+)$/);
    if (m) {
      const c = (state.clusters as { id: string; status: string }[]).find((x) => x.id === m[1])!;
      c.status = (body as { decision: string }).decision;
      return false;
    }
    if (path === "draw") {
      draws++;
      if (draws === 1) {
        await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "pending_reviews", message: "1 AI suggestion(s) not reviewed" }) });
        return true;
      }
      state.status = "frozen";
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ status: "frozen" }) });
      return true;
    }
    return false;
  });
  await open(page);

  await page.getByTestId("step-draw").click();
  await expect(page.getByTestId("draw-pending")).toHaveText("2 AI suggestions are still pending: 8 accounts would each keep a ticket. Review them first.");
  await page.getByTestId("confirm-ok").click(); // "Review them"
  await expect(page.getByTestId("draw-dialog")).not.toBeVisible();

  await page.getByTestId("cluster-operator").getByTestId("cluster-confirm").click();
  await expect(page.getByTestId("toast").filter({ hasText: "Grouped: 6 accounts now share one ticket." })).toBeVisible();
  await page.getByTestId("cluster-household").getByTestId("cluster-dismiss").click();
  await expect(page.getByTestId("toast").filter({ hasText: "Kept apart: 2 accounts keep their own tickets." })).toBeVisible();
  await expect(page.getByTestId("step-decide-row")).toHaveAttribute("data-state", "done");

  await page.getByTestId("step-draw").click();
  await expect(page.getByTestId("draw-copy")).toHaveText("This captures 2 winners (≈ $89.00) and releases every other hold.");
  await page.getByTestId("confirm-ok").click();
  // a suggestion that appeared meanwhile: the server refuses, the console explains (never raw JSON)
  const warn = page.locator('[data-testid="toast"][data-tone="warn"]');
  await expect(warn).toContainText("still pending");
  await expect(page.locator(".toasts")).not.toContainText("{");

  await page.getByTestId("step-draw").click();
  await page.getByTestId("confirm-ok").click();
  await expect(page.getByTestId("toast").filter({ hasText: "List frozen. Waiting for drand round 23,456,789" })).toBeVisible();
  await expect(page.getByTestId("step-draw-result")).toContainText("List frozen · waiting for drand round 23,456,789");

  state.status = "settled";
  state.stage = "settled";
  await expect(page.getByTestId("toast").filter({ hasText: "Settled." })).toBeVisible({ timeout: 10_000 });
  const rep = page.getByTestId("settlement-summary");
  await expect(rep).toContainText("2 units → 2 different PayPal payers · $89.00 captured · $7.00 of unused shipping released");
  await expect(rep).toContainText("21 holds voided · $0 charged to anyone who lost");
  await expect(rep).toContainText("1 failed payment → waitlist #1 got the unit in 3 s");
  await expect(rep).toContainText("13 agent requests → 0 holds without a person · 6 network accounts → 1 ticket");
  await expect(rep.getByRole("link", { name: "Verify this draw" })).toHaveAttribute("href", `/verify/${SLUG}`);
  await expect(rep.getByRole("link", { name: "Start another judge drop" })).toHaveAttribute("href", "/judge?fresh=1");
  expect(errors).toEqual([]);
});

test("draw with nobody holding a ticket says so instead of drawing", async ({ page }) => {
  await mockDrop(page, { status: "open", stage: "mid", entries: [], clusters: [], ai: { ...aiSummary, ranAt: null } });
  await open(page);
  await expect(page.getByText("No entries yet.")).toBeVisible();
  await page.getByTestId("step-draw").click();
  await expect(page.getByTestId("draw-dialog")).toContainText("Nobody in this drop has a PayPal hold yet");
  await expect(page.getByTestId("confirm-ok")).toHaveText("Got it");
});

test("AI unavailable: a warning banner with Retry, never a success message", async ({ page }) => {
  await mockDrop(page, { status: "open", stage: "mid", clusters: [], ai: { ...aiSummary, ranAt: null } }, async (path, _b, route) => {
    if (path !== "analyze") return false;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ clusters: 0, llmCalls: 0, uncertainPairs: 3, keptApart: 0, degraded: "model timeout", ms: 25000 }) });
    return true;
  });
  await open(page);
  await page.getByTestId("step-ai").click();
  await expect(page.locator('[data-testid="toast"][data-tone="warn"]')).toContainText("AI unavailable. Showing rule-only suggestions.");
  await expect(page.getByTestId("ai-degraded")).toContainText("AI unavailable. Showing rule-only suggestions.");
  await expect(page.getByTestId("ai-degraded").getByRole("button", { name: "Retry" })).toBeVisible();
  await expect(page.getByTestId("step-ai-row")).toHaveAttribute("data-state", "warn");
  await expect(page.locator('[data-testid="toast"][data-tone="ok"]')).toHaveCount(0);
});

test("swarm: an immediate toast, then the swarm_done line from the ledger", async ({ page }) => {
  const state: ConsoleState = { status: "open", stage: "mid", events: events("mid").filter((e) => e.kind !== "swarm_done") };
  await mockDrop(page, state);
  await open(page);
  await expect(page.getByTestId("ledger")).toContainText("Scalper swarm: 12 agents");
  await page.getByTestId("step-swarm").click();
  await expect(page.getByTestId("toast").filter({ hasText: "Sent 12 scalper agents. Watch the ledger." })).toBeVisible();
  const done = events("mid").find((e) => e.kind === "swarm_done")!;
  (state.events as unknown[]).push({ ...done, id: 999 });
  await expect(page.getByTestId("toast").filter({ hasText: "12 scalper agents → 12 PayPal approval links · 0 holds" })).toBeVisible({ timeout: 10_000 });
});

test("ledger: PayPal trace chips behind a toggle, simulated runs folded, no SIMULATED prefix", async ({ page }) => {
  await mockDrop(page, { status: "settled", stage: "settled" });
  await open(page);
  const ledger = page.getByTestId("ledger");
  await expect(ledger.getByRole("log")).toBeVisible();
  await expect(page.getByTestId("trace-toggle")).toBeChecked();
  const capture = ledger.locator(".pp-call").filter({ hasText: "/v2/payments/authorizations/…7K2Q/capture" });
  await expect(capture).toContainText("POST /v2/payments/authorizations/…7K2Q/capture → 201 · PARTIALLY_CAPTURED");
  await capture.locator("summary").click();
  await expect(capture).toContainText("PayPal-Request-Id cap:…7K2Q:1 · 412 ms");
  await expect(ledger.locator(".pp-call.is-bad")).toContainText("422 UNPROCESSABLE_ENTITY · TRANSACTION_REFUSED · debug_id 8f3a2c…");
  await expect(ledger.locator(".pp-chip").filter({ hasText: "Webhook" })).toHaveText("Webhook PAYMENT.CAPTURE.COMPLETED · event WH-…9F2A · signature verified ✓");
  const group = page.getByTestId("ledger-group");
  await expect(group).toContainText("14 simulated holds released (labelled) · show");
  await group.locator("summary").click();
  await expect(group.locator(".ev-sub li")).toHaveCount(14);
  expect(await ledger.innerText()).not.toContain("SIMULATED");
  // trace off: status chips stay, endpoints go
  await page.getByTestId("trace-toggle").uncheck();
  await expect(ledger.locator(".pp-call")).toHaveCount(0);
  await expect(ledger.locator(".pp-chip").filter({ hasText: "201 · PARTIALLY_CAPTURED" })).toBeVisible();
});

test("fan page: the trace starts off, the report shows once settled", async ({ page }) => {
  await mockDrop(page, { status: "settled", stage: "settled" });
  await page.goto(`/d/${SLUG}`);
  await expect(page.getByTestId("trace-toggle")).not.toBeChecked();
  await expect(page.getByTestId("ledger").locator(".pp-chip").first()).toBeVisible();
  await expect(page.getByTestId("ledger").locator(".pp-call")).toHaveCount(0);
  await expect(page.getByTestId("settlement-summary")).toContainText("$0 charged to anyone who lost");
});

test("/verify shows the Drop report of a settled drop", async ({ page }) => {
  await mockDrop(page, { status: "settled", stage: "settled" });
  await json(page, `**/api/drops/${SLUG}/verify`, {
    title: "Ember Glaze Mug",
    status: "settled",
    units: 2,
    waitlistSize: 3,
    seedHash: "ab",
    seed: "cd",
    frozenHash: "ef",
    frozenList: ["E-7K2Q"],
    outcome: [],
  });
  await page.goto(`/verify/${SLUG}`);
  await expect(page.getByTestId("settlement-summary")).toContainText(`${report.unitsToDistinctPayers} different PayPal payers`);
});

test("after the sale: Mark shipped and Refund on captured rows, each confirmed first", async ({ page }) => {
  const posts: { path: string; body: unknown }[] = [];
  await mockDrop(page, { status: "settled", stage: "settled" }, (path, body) => {
    posts.push({ path, body });
    return false;
  });
  await open(page);
  const row = page.getByTestId("entry-row").first();
  await expect(row).toContainText("E-7K2Q");
  await expect(row).toHaveAttribute("data-status", "captured");
  await row.getByTestId("ship").click();
  const ship = page.getByTestId("ship-dialog");
  await expect(ship).toContainText("Mark E-7K2Q as shipped?");
  await expect(ship.locator("select")).toHaveValue("USPS");
  await expect(ship.locator("input")).toHaveValue(/^94001\d{17}$/);
  await page.getByTestId("confirm-ok").click();
  await expect(page.getByTestId("toast").filter({ hasText: "Marked E-7K2Q shipped: USPS tracking goes to the PayPal order." })).toBeVisible();
  expect(posts.at(-1)).toMatchObject({ path: "entries/ent_real_a/ship", body: { carrier: "USPS" } });

  await page.reload();
  await page.getByTestId("entry-row").first().getByTestId("refund").click();
  const refund = page.getByTestId("refund-dialog");
  await expect(refund).toContainText("Can't ship E-7K2Q? Refund $44.50");
  await page.getByTestId("confirm-cancel").click();
  expect(posts.filter((p) => p.path.endsWith("/refund"))).toHaveLength(0);
  await page.getByTestId("entry-row").first().getByTestId("refund").click();
  await page.getByTestId("confirm-ok").click();
  await expect(page.getByTestId("toast").filter({ hasText: "Refund of $44.50 requested for E-7K2Q." })).toBeVisible();
  expect(posts.at(-1)).toMatchObject({ path: "entries/ent_real_a/refund", body: { reason: "Can't ship" } });
});

test("a11y basics: role=status toasts, pressed filters, keyboard focus is visible", async ({ page }) => {
  await mockDrop(page, { status: "open", stage: "mid" });
  await open(page);
  await expect(page.locator(".toasts")).toHaveAttribute("role", "status");
  await page.getByTestId("filter-all").focus();
  await page.keyboard.press("Tab");
  const outline = await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle);
  expect(outline).toBe("solid");
  // times are 24 h and never wrap
  const t = await page.getByTestId("ledger").locator("ol > li > time").first().innerText();
  expect(t).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  expect(now).toBeGreaterThan(0);
});
