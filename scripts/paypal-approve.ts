// Drives the PayPal SANDBOX approval page with the sandbox buyer account (BUYER_EMAIL / BUYER_PASSWORD).
// Used by the real end-to-end tests and to record the demo video. Never used with live accounts.
import type { Page } from "@playwright/test";

export async function approveInPayPal(page: Page, opts: { email: string; password: string; shots?: string; log?: (m: string) => void }) {
  const log = opts.log ?? (() => undefined);
  const shot = async (n: string) => opts.shots && (await page.screenshot({ path: `${opts.shots}/${n}.png` }).catch(() => undefined));
  await page.waitForLoadState("domcontentloaded");
  if (!/sandbox\.paypal\.com/.test(page.url())) throw new Error(`not a PayPal sandbox page: ${page.url()}`);

  const email = page.locator("#email, input[name=login_email]").first();
  const loginLink = page.getByRole("link", { name: /^(Log ?In|Iniciar sesión)$/i }).or(page.getByRole("button", { name: /^(Log ?In|Iniciar sesión)$/i })).first();
  // Review-page primary button (ids are stable; labels vary by flow and language).
  const submit = page.locator("#payment-submit-btn, [data-testid=submit-button-initial], button[data-id=payment-submit-btn]").first();

  // The buyer may already be logged in (PayPal remembers the session): go straight to the review page.
  const first = await Promise.race([
    email.waitFor({ state: "visible", timeout: 60_000 }).then(() => "login" as const),
    submit.waitFor({ state: "visible", timeout: 60_000 }).then(() => "review" as const),
    loginLink.waitFor({ state: "visible", timeout: 60_000 }).then(() => "guest" as const),
  ]);
  await shot("01-landing");
  if (first === "guest") {
    log("switching to Log In");
    await loginLink.click();
  }
  if (first !== "review") {
    await email.waitFor({ state: "visible", timeout: 45_000 });
    await email.fill(opts.email);
    const next = page.locator("#btnNext");
    if (await next.isVisible().catch(() => false)) {
      log("email → next");
      await next.click();
    }
    const pw = page.locator("#password, input[name=login_password]").first();
    await pw.waitFor({ state: "visible", timeout: 45_000 });
    await pw.fill(opts.password);
    await shot("02-login");
    log("password → login");
    const loginBtn = page.locator("#btnLogin");
    await loginBtn.waitFor({ state: "visible", timeout: 45_000 });
    await loginBtn.click();
  }
  await submit.waitFor({ state: "visible", timeout: 60_000 });
  await page.waitForTimeout(1500); // the review page re-renders once shipping/funding is resolved
  await shot("03-review");
  log("approving");
  await submit.click();
}
