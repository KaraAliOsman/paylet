// Fan-side and public pages against a running Paylet, with the v2 API shapes mocked (research/CONTRACT.md),
// so the UI is checked deterministically and without PayPal or the LLM.
//   E2E_BASE_URL=http://localhost:8787 npx playwright test e2e/ui-pages.spec.ts
import { expect, test, type Page } from "@playwright/test";
import { canonicalList, computeDraw, sha256Hex } from "../src/shared/draw";

const json = (page: Page, pattern: string, body: unknown, status = 200) =>
  page.route(pattern, (r) => r.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) }));
/** what an older server answers for an endpoint it doesn't have: the SPA's index.html */
const absent = (page: Page, pattern: string) =>
  page.route(pattern, (r) => r.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><div id=root></div>" }));

const now = Date.now();
const drop = {
  slug: "mock-drop",
  title: "Ember Glaze Mug",
  maker: "Juniper Street Ceramics",
  status: "open",
  closesAt: now + 20 * 60_000,
  units: 2,
  art: "ember",
};
const entry = (over: Record<string, unknown> = {}) => ({
  entryId: "ent_mock",
  publicId: "E-7K2Q",
  source: "agent",
  agentLabel: "Wren (fan's assistant)",
  status: "awaiting_person",
  holdCents: null,
  capturedCents: null,
  refundedCents: null,
  note: null,
  explanation: null,
  approveUrl: "https://www.sandbox.paypal.com/checkoutnow?token=MOCK",
  payerVerified: null,
  shipping: null,
  timeline: { requestedAt: now - 60_000, approvedAt: null, heldAt: null, drawAt: null, settledAt: null },
  drop,
  ...over,
});

function collectErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  return errors;
}

test("unknown routes get a 404 page with a way back", async ({ page }) => {
  await page.goto("/no/such/page");
  await expect(page.getByRole("heading", { name: "There's no page here" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Start a fresh judge drop" })).toHaveAttribute("href", "/judge?fresh=1");
});

test("judge page forgets a drop that no longer exists", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("paylet.judge", JSON.stringify({ slug: "gone-drop-0000", sellerKey: "x" })));
  await json(page, "**/api/drops/gone-drop-0000", { error: "drop_not_found" }, 404);
  await page.goto("/judge");
  await expect(page.getByText("Your previous drop is gone (the demo restarted). Start a new one below.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Start my judge drop" })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("paylet.judge"))).toBeNull();
});

test("home: live counters and the proof card come from /api/stats and /api/proof", async ({ page }) => {
  const errors = collectErrors(page);
  await json(page, "**/api/stats", {
    holds: 14,
    duplicatesBlocked: 9,
    agentRequests: 131,
    capturedCents: 17800,
    voidedHolds: 11,
    chargedToLosersCents: 0,
    drops: 7,
  });
  await json(page, "**/api/proof", { slug: "proof-run", summary: "3 real buyers · 1 same-account duplicate blocked.", checkedAt: now });
  await page.goto("/");
  await expect(page.getByText("Every entry is a PayPal hold. One per PayPal account. Losers are never charged.")).toBeVisible();
  await expect(page.getByRole("link", { name: /Judges: 2-minute guided demo/ })).toHaveAttribute("href", "/judge");
  await expect(page.locator(".live-item").filter({ hasText: "agent requests" })).toContainText("131");
  await expect(page.locator(".live-item").filter({ hasText: "charged across 11 voided holds" })).toContainText("$0");
  await expect(page.getByRole("heading", { name: "A finished run with real PayPal sandbox money" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Verify + ask PayPal" })).toHaveAttribute("href", "/verify/proof-run");
  expect(errors).toEqual([]);
});

test("home degrades quietly on a server without /api/stats and /api/proof", async ({ page }) => {
  const errors = collectErrors(page);
  await absent(page, "**/api/stats");
  await absent(page, "**/api/proof");
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "How a drop works" })).toBeVisible();
  await expect(page.locator(".live")).toHaveCount(0);
  await expect(page.locator(".proof")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("/me resumes a pending approval and shows the hold timeline", async ({ page }) => {
  await json(page, "**/api/entries/ent_mock", entry());
  await page.goto("/me/ent_mock");
  await expect(page.getByRole("link", { name: "Approve in PayPal" })).toHaveAttribute("href", /sandbox\.paypal\.com/);
  await expect(page.getByText(/link expires in/)).toBeVisible();
  await expect(page.locator('.htl-step[aria-current="step"]')).toContainText("You approve in PayPal");
});

test("/me after a win: captured + released, shipped", async ({ page }) => {
  await json(
    page,
    "**/api/entries/ent_mock",
    entry({
      status: "captured",
      approveUrl: null,
      holdCents: 4800,
      capturedCents: 4450,
      shipping: { carrier: "USPS", tracking: "9400100000000000000000" },
      drop: { ...drop, status: "settled" },
    }),
  );
  await page.goto("/me/ent_mock");
  await expect(page.getByText("Captured $44.50 + $3.50 released")).toBeVisible();
  await expect(page.getByText(/also visible in your PayPal account/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Approve in PayPal" })).toHaveCount(0);
});

test("agent: suggestion chip → MCP trace chips → hand-off card → ask how it went", async ({ page }) => {
  const errors = collectErrors(page);
  await page.addInitScript(() => sessionStorage.clear());
  await json(page, "**/api/agent/chat", {
    reply: "I requested your entry in the Ember Glaze Mug drop. Approve the $48.00 hold in PayPal yourself.",
    trace: [
      { tool: "list_drops", summary: "list_drops → 4 drops", raw: { drops: [] } },
      { tool: "enter_drop", summary: "enter_drop(mock-drop) → awaiting_person", raw: { status: "awaiting_person" } },
    ],
    handoff: {
      entryRef: "ent_mock",
      publicId: "E-7K2Q",
      title: "Ember Glaze Mug",
      holdCents: 4800,
      approveUrl: "https://www.sandbox.paypal.com/checkoutnow?token=MOCK",
      expiresAt: now + 3 * 3600_000,
    },
  });
  let settled = false;
  await page.route("**/api/entries/ent_mock", (r) =>
    r.fulfill({
      contentType: "application/json",
      body: JSON.stringify(settled ? entry({ status: "voided", holdCents: 4800, drop: { ...drop, status: "settled" } }) : entry()),
    }),
  );
  await json(page, "**/api/agent/how-it-went", { reply: "Not selected. PayPal voided your $48.00 hold. Charged: $0.", status: "voided" });

  await page.goto("/agent?drop=mock-drop");
  await page.getByRole("button", { name: /Get me into this drop: .*\/d\/mock-drop/ }).click();
  const card = page.locator(".handoff");
  await expect(card.getByText("Your agent stopped here.")).toBeVisible();
  await expect(card.getByText("Wren can't approve or pay. Only you can.")).toBeVisible();
  await expect(card.getByRole("link", { name: "Approve $48.00 hold in PayPal" })).toHaveAttribute("href", /sandbox\.paypal\.com/);
  await expect(page.locator(".trace-chip").filter({ hasText: "list_drops" })).toContainText("4 drops");
  await expect(page.locator(".trace-chip").filter({ hasText: "enter_drop(mock-drop)" })).toContainText("awaiting_person");
  await expect(page.locator(".msgs .bubble").last()).not.toContainText("http");

  settled = true;
  await card.getByRole("button", { name: "Ask Wren how it went" }).click({ timeout: 10_000 });
  await expect(page.locator(".bubble").getByText("Not selected. PayPal voided your $48.00 hold. Charged: $0.")).toBeVisible();
  expect(errors).toEqual([]);
});

test("/how: sequence diagram on top, FAQ, code links", async ({ page }) => {
  await page.goto("/how?reveal=1");
  await expect(page.locator("#sequence svg#paylet-seq")).toBeVisible();
  await expect(page.locator("svg#paylet-seq .seq-step")).toHaveCount(8);
  await expect(page.locator("svg#paylet-seq")).toHaveClass(/reveal/);
  await expect(page.locator("svg#paylet-seq .step-1")).toHaveClass(/on/, { timeout: 5_000 });
  await expect(page.getByText("Is this a raffle?")).toBeVisible();
  await expect(page.getByText("Is a PayPal account proof of a unique human?")).toBeVisible();
  await expect(page.getByRole("link", { name: /Where in the code/ }).first()).toHaveAttribute("href", /github\.com\/.+\/blob\/main\/src\//);
  await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "How it works" })).toBeVisible();
});

test("/verify: drand recomputation, consistent outcome with a failed payment, and Ask PayPal", async ({ page }) => {
  const errors = collectErrors(page);
  const seed = "9f2c1a7e44b0d3c8a1e5f6b7c8d9e0f1a2b3c4d5e6f708192a3b4c5d6e7f8091";
  const ids = ["E-7K2Q", "E-AB12", "E-QQ9X", "E-M4RT", "E-ZK31", "E-P0L8", "E-HH21", "E-TY77"];
  const chain = "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971";
  // a real quicknet beacon: the page checks its BLS signature for real
  const round = 33_566_234;
  const value = "437546a7113a08f9fc305ac7d349b0dbf4f3f7dfc62ea89ea3e10a7c5463886c";
  const signature = "9477f1a5470a304bb7b8c04dd3c38a649ce93d7ad25d06059888477af1269a437b3419e5858c79b53a7bb267ed37b3fd";
  const finalSeed = await sha256Hex(`${seed}:${value}`);
  const rank = (await computeDraw(finalSeed, ids, 2, 3)).ranking.map((r) => r.publicId);
  const url = `https://api.drand.sh/${chain}/public/${round}`;
  await json(page, "**/api/drops/mock-drop/verify", {
    title: "Ember Glaze Mug",
    status: "settled",
    units: 2,
    waitlistSize: 3,
    seedHash: await sha256Hex(seed),
    seed,
    frozenHash: await sha256Hex(canonicalList(ids)),
    frozenList: ids,
    frozenAt: (1692803367 + (round - 1) * 3) * 1000 - 6000,
    randomness: { source: "drand-quicknet", round, value, chainHash: chain, url },
    finalSeed,
    excluded: [{ publicId: "E-DUP1", reason: "duplicate" }],
    outcome: rank.map((id, i) => ({ publicId: id, status: i === 0 || i === 2 ? "captured" : i === 1 ? "capture_failed" : "voided" })),
  });
  await json(page, "**/api/drops/mock-drop", { ...drop, id: "d", status: "settled", kind: "judge", stats: {} });
  await json(page, url, { round, randomness: value, signature });
  await json(page, "**/api/drops/mock-drop/paypal-check", {
    checkedAt: now,
    rows: [
      {
        publicId: rank[0],
        authorization: "…7K2Q",
        paypalStatus: "PARTIALLY_CAPTURED",
        heldCents: 4800,
        capturedCents: 4450,
        ledgerStatus: "captured",
        matchesLedger: true,
      },
      {
        publicId: rank[1],
        authorization: "…X9P1",
        paypalStatus: "VOIDED",
        heldCents: 4800,
        capturedCents: 0,
        ledgerStatus: "capture_failed",
        matchesLedger: true,
      },
    ],
    totals: { captured: 1, voided: 1, mismatches: 0 },
  });

  await page.goto("/verify/mock-drop");
  await expect(page.getByText(`drand round ${round.toLocaleString("en-US")}`).first()).toBeVisible();
  await page.getByRole("button", { name: "Re-run the draw here" }).click();
  await expect(page.getByText(/SHA-256\(seed\) matches the commitment/)).toBeVisible();
  await expect(page.getByText(/eligible list matches the hash/)).toBeVisible();
  await expect(page.getByText(/checked its BLS signature against the League of Entropy's public key/)).toBeVisible();
  await expect(page.getByText(/Paylet couldn't pick this round/)).toBeVisible();
  await expect(page.getByText("Recorded outcome is consistent with your computation.")).toBeVisible();
  await expect(page.getByRole("row", { name: new RegExp(`^2 ${rank[1]} Winner #2`) })).toContainText(`payment failed → waitlist #1 ${rank[2]}`);

  await page.getByRole("button", { name: "Ask PayPal now" }).click();
  await expect(page.locator(".pp-rows li").first()).toContainText("PayPal says PARTIALLY_CAPTURED");
  await expect(page.locator(".pp-rows li").first()).toContainText("$44.50 of $48.00 captured");
  await expect(page.locator(".pp-rows li").first()).toContainText("matches our ledger");
  expect(await page.evaluate(() => localStorage.getItem("paylet.verified.mock-drop"))).toBe("1");
  expect(errors).toEqual([]);
});

test("/verify: a forged beacon or a hand-picked round turns the check red", async ({ page }) => {
  const seed = "9f2c1a7e44b0d3c8a1e5f6b7c8d9e0f1a2b3c4d5e6f708192a3b4c5d6e7f8091";
  const ids = ["E-7K2Q", "E-AB12", "E-QQ9X"];
  const chain = "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971";
  const round = 33_566_234;
  const value = "437546a7113a08f9fc305ac7d349b0dbf4f3f7dfc62ea89ea3e10a7c5463886c";
  const finalSeed = await sha256Hex(`${seed}:${value}`);
  const url = `https://api.drand.sh/${chain}/public/${round}`;
  await json(page, "**/api/drops/mock-drop/verify", {
    title: "Ember Glaze Mug",
    status: "settled",
    units: 1,
    waitlistSize: 1,
    seedHash: await sha256Hex(seed),
    seed,
    frozenHash: await sha256Hex(canonicalList(ids)),
    frozenList: ids,
    frozenAt: (1692803367 + (round - 1) * 3) * 1000 - 60_000, // the rule gives an earlier round than the one used
    randomness: { source: "drand-quicknet", round, value, chainHash: chain, url },
    finalSeed,
    excluded: [],
    outcome: [],
  });
  await json(page, "**/api/drops/mock-drop", { ...drop, id: "d", status: "settled", kind: "judge", stats: {} });
  await json(page, url, { round, randomness: value, signature: "a".repeat(96) });
  await page.goto("/verify/mock-drop");
  await page.getByRole("button", { name: "Re-run the draw here" }).click();
  await expect(page.getByText(/does NOT carry a valid League of Entropy signature/)).toBeVisible();
  await expect(page.getByText(/NOT the one the public rule gives/)).toBeVisible();
});

test("/verify: Ask PayPal on a server without the endpoint says so", async ({ page }) => {
  await json(page, "**/api/drops/mock-drop/verify", {
    title: "Ember Glaze Mug",
    status: "open",
    units: 2,
    waitlistSize: 3,
    seedHash: "ab",
    seed: null,
    frozenHash: null,
    frozenList: null,
    outcome: [],
  });
  await json(page, "**/api/drops/mock-drop", { ...drop, id: "d", kind: "judge", stats: {} });
  await absent(page, "**/api/drops/mock-drop/paypal-check");
  await page.goto("/verify/mock-drop");
  await expect(page.getByText(/the seed stays secret until then/)).toBeVisible();
  await page.getByRole("button", { name: "Ask PayPal now" }).click();
  await expect(page.getByText("This server doesn't offer the live PayPal check yet.")).toBeVisible();
});
