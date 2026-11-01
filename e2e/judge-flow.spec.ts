import { expect, test } from "@playwright/test";

// Judge flow without a PayPal login: real sandbox orders are created by the agent swarm (approval links),
// the simulated crowd is resolved by the AI, the seller confirms, draws, and the draw is re-verified in the browser.
test("judge drop: swarm → AI review → decide → confirm the draw → verify", async ({ page, request }) => {
  const r = await request.post("/api/judge-drop");
  expect(r.ok()).toBeTruthy();
  const { slug, sellerKey } = await r.json();

  // the key travels in the URL fragment (never sent to the server); the console sends it as a header
  await page.goto(`/seller/${slug}#k=${sellerKey}`);
  await expect(page.getByRole("heading", { name: "Ember Glaze Mug" })).toBeVisible();

  // Real PayPal sandbox orders via MCP: 3 scalper agents → 3 approval links, 0 holds.
  const swarm = await request.post(`/api/seller/${slug}/swarm`, { headers: { "x-seller-key": sellerKey }, data: { n: 3 } });
  expect(swarm.ok()).toBeTruthy();
  await expect(page.getByTestId("ledger")).toContainText(/3 (PayPal )?approval links/, { timeout: 60_000 });
  await expect(page.getByTestId("step-swarm-result")).toHaveText("3 PayPal links · 0 holds");

  await page.getByTestId("step-crowd").click();
  await expect(page.getByTestId("toast").filter({ hasText: /Added \d+ simulated entrants \(labelled\)/ })).toBeVisible();
  await expect(page.getByTestId("step-crowd-row")).toHaveAttribute("data-state", "done");

  await page.getByTestId("step-ai").click();
  await expect(page.getByTestId("cluster-operator").first()).toBeVisible({ timeout: 120_000 });

  // nothing is drawn while a suggestion is pending: confirm every group (one ticket each)
  let pending = await page.getByTestId("cluster-confirm").count();
  expect(pending).toBeGreaterThan(0);
  while (pending > 0) {
    await page.getByTestId("cluster-confirm").first().click();
    await expect(page.getByTestId("cluster-confirm")).toHaveCount(pending - 1, { timeout: 15_000 });
    pending--;
  }
  await expect(page.locator('[data-testid="cluster-operator"][data-status="confirmed"]').first()).toBeVisible();
  await expect(page.getByTestId("step-decide-row")).toHaveAttribute("data-state", "done");

  await page.getByTestId("step-draw").click();
  await expect(page.getByTestId("draw-copy")).toHaveText(/^This captures \d winners? \(≈ \$\d+\.\d\d\) and releases every other hold\.$/);
  await page.getByTestId("confirm-ok").click();
  await expect(page.getByTestId("step-draw-row")).toHaveAttribute("data-state", "done", { timeout: 120_000 });
  await expect(page.getByTestId("ledger")).toContainText(/Settled/);

  await page.goto(`/verify/${slug}`);
  await page.getByRole("button", { name: /Re-run the draw here/ }).click();
  await expect(page.getByText(/SHA-256\(seed\) matches the commitment/)).toBeVisible();
  await expect(page.getByText(/eligible list matches the hash/)).toBeVisible();
  await expect(page.getByText("Recorded outcome is consistent with your computation.")).toBeVisible();
});

test("fan page renders the PayPal v6 button", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: /Enter the .* drop/ }).click();
  await expect(page.getByRole("heading", { name: "Enter the ballot" })).toBeVisible();
  await expect(page.locator("paypal-button")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/One entry per PayPal/)).toBeVisible();
  await expect(page.getByText(/Charged only if you win/)).toBeVisible();
});

test("fan's AI agent requests an entry over MCP and stops at the PayPal approval", async ({ page, request }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { slug } = await (await request.post("/api/judge-drop")).json();
  await page.goto(`/agent?drop=${slug}`);
  await page.getByRole("button", { name: /Get me into this drop/ }).click();
  await expect(page.getByText(/Your agent stopped here/)).toBeVisible({ timeout: 120_000 });
  await expect(page.getByRole("link", { name: /Approve .* hold in PayPal/ })).toHaveAttribute("href", /sandbox\.paypal\.com/);
  await expect(page.locator(".trace-chip").filter({ hasText: "enter_drop" })).toBeVisible();
  expect(errors).toEqual([]);
});
