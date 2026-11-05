// The MCP App approval card inside a stand-in host: the same postMessage JSON-RPC a chat host speaks (spec 2026-01-26).
import { expect, test, type Page } from "@playwright/test";
import { APPROVAL_CARD_HTML } from "../src/server/approval-card";

const RESULT = {
  structuredContent: {
    entry_ref: "ent_test",
    public_id: "E-N6PLS",
    title: "Ember Glaze Mug",
    status: "awaiting_person",
    approve_url: "https://www.sandbox.paypal.com/checkoutnow?token=5O190127TN364715T",
    hold_usd: 48,
  },
};

async function host(page: Page, opts: { openLink?: "ok" | "deny"; result?: unknown; dark?: boolean } = {}) {
  await page.emulateMedia({ colorScheme: opts.dark ? "dark" : "light" });
  await page.setContent(`<!doctype html><body style="margin:24px;background:${opts.dark ? "#141312" : "#f7f6f2"}"><iframe id="v" sandbox="allow-scripts allow-popups" style="border:0;width:480px;height:420px"></iframe></body>`);
  await page.evaluate(
    ([html, result, openLink]) => {
      const w = window as unknown as { log: { method: string; params: unknown }[]; statuses: string[] };
      w.log = [];
      w.statuses = ["awaiting_person", "held"];
      const frame = document.getElementById("v") as HTMLIFrameElement;
      window.addEventListener("message", (ev) => {
        const m = ev.data as { id?: number; method?: string; params?: { width?: number; height?: number } };
        if (!m?.method) return;
        w.log.push({ method: m.method, params: m.params });
        const reply = (body: object) => frame.contentWindow!.postMessage({ jsonrpc: "2.0", id: m.id, ...body }, "*");
        if (m.method === "ui/initialize") reply({ result: { protocolVersion: "2026-01-26", hostInfo: { name: "stand-in", version: "1" }, hostCapabilities: { openLinks: {} }, hostContext: {} } });
        if (m.method === "ui/notifications/initialized") frame.contentWindow!.postMessage({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: result }, "*");
        if (m.method === "ui/open-link") reply(openLink === "deny" ? { error: { code: -32000, message: "denied" } } : { result: {} });
        if (m.method === "tools/call") reply({ result: { structuredContent: { status: w.statuses.shift() ?? "held" } } });
        if (m.method === "ui/notifications/size-changed" && m.params?.height) frame.style.height = `${m.params.height + 2}px`;
      });
      frame.srcdoc = html;
    },
    [APPROVAL_CARD_HTML, opts.result ?? RESULT, opts.openLink ?? "ok"] as const,
  );
  return page.frameLocator("#v");
}

test("shows the request, opens PayPal through the host, and follows the entry to Hold placed", async ({ page }) => {
  test.setTimeout(30_000);
  const f = await host(page);
  await expect(f.getByRole("heading", { name: "Ember Glaze Mug" })).toBeVisible();
  await expect(f.getByText("Your agent stopped here")).toBeVisible();
  await expect(f.getByText("$48.00", { exact: true })).toBeVisible();
  await expect(f.getByRole("link")).toBeHidden(); // the fallback link only appears if the host refuses to open links
  await page.locator("body").screenshot({ path: "test-results/mcp-card.png" });
  await f.getByRole("button", { name: "Approve $48.00 hold in PayPal" }).click();
  await expect(f.getByText("Hold placed. Nothing charged.")).toBeVisible({ timeout: 12_000 });
  await expect(f.getByRole("button", { name: "Approved in PayPal" })).toBeDisabled();
  const log = await page.evaluate(() => (window as unknown as { log: { method: string; params: { url?: string } }[] }).log);
  expect(log.find((m) => m.method === "ui/open-link")!.params.url).toBe(RESULT.structuredContent.approve_url);
  expect(log.filter((m) => m.method === "tools/call").length).toBeGreaterThanOrEqual(1);
});

test("a host that refuses to open links still leaves a real link", async ({ page }) => {
  const f = await host(page, { openLink: "deny" });
  await f.getByRole("button", { name: /Approve/ }).click();
  await expect(f.getByRole("link", { name: /Approve \$48.00 hold/ })).toHaveAttribute("href", RESULT.structuredContent.approve_url);
});

test("never offers a link that isn't PayPal's sandbox", async ({ page }) => {
  const f = await host(page, { result: { structuredContent: { ...RESULT.structuredContent, approve_url: "https://evil.example/pay" } } });
  await expect(f.getByRole("button", { name: /Approve/ })).toBeDisabled();
  await expect(f.getByText("no valid PayPal link")).toBeVisible();
});

test("text in the result stays text", async ({ page }) => {
  const f = await host(page, { result: { structuredContent: { ...RESULT.structuredContent, title: '<img src=x onerror="parent.postMessage(1,`*`)">' } } });
  await expect(f.getByRole("heading")).toContainText("<img src=x");
});

test("dark mode", async ({ page }) => {
  const f = await host(page, { dark: true });
  await expect(f.getByRole("heading", { name: "Ember Glaze Mug" })).toBeVisible();
  await page.locator("body").screenshot({ path: "test-results/mcp-card-dark.png" });
});
