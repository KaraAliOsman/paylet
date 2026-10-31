import { expect, test } from "@playwright/test";

// Judge flow without a PayPal login: real sandbox orders are created by the agent swarm (approval links),
// the simulated crowd is resolved by the AI, the seller confirms, draws, and the draw is re-verified in the browser.
test("judge drop: swarm → AI review → confirm → draw → verify", async ({ page, request }) => {
  const r = await request.post("/api/judge-drop");
  expect(r.ok()).toBeTruthy();
  const { slug, sellerKey } = await r.json();

  await page.goto(`/seller/${slug}?k=${sellerKey}`);
  await expect(page.getByRole("heading", { name: "Ember Glaze Mug" })).toBeVisible();

  // Real PayPal sandbox orders via MCP: 3 scalper agents → 3 approval links, 0 holds.
  const swarm = await request.post(`/api/seller/${slug}/swarm`, { headers: { "x-seller-key": sellerKey }, data: { n: 3 } });
  expect(swarm.ok()).toBeTruthy();
  await expect(page.getByText(/Scalper swarm finished: 3 approval links issued, 0 holds/).first()).toBeVisible({ timeout: 60_000 });

  await page.getByRole("button", { name: /Add simulated crowd/ }).click();
  await expect(page.getByText(/Added \d+ SIMULATED entrants/).first()).toBeVisible();

  await page.getByRole("button", { name: /Find households & networks/ }).click();
  await expect(page.getByText("Reseller network").first()).toBeVisible({ timeout: 120_000 });

  await page.getByRole("button", { name: /Confirm — one unit max/ }).first().click();
  await expect(page.locator(".cluster-confirmed").first()).toBeVisible();

  await page.getByRole("button", { name: /Close & draw/ }).click();
  await expect(page.getByText(/Settled:/).first()).toBeVisible({ timeout: 60_000 });

  await page.goto(`/verify/${slug}`);
  await page.getByRole("button", { name: /Re-run the draw here/ }).click();
  await expect(page.getByText(/SHA-256\(seed\) matches the commitment/)).toBeVisible();
  await expect(page.getByText(/eligible list matches the hash/)).toBeVisible();
});

test("fan page renders the PayPal v6 button", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: /Enter the .* drop/ }).click();
  await expect(page.locator("paypal-button")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/One entry per PayPal/)).toBeVisible();
});
