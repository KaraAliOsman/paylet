# Paylet — notes for AI coding agents

- PayPal **sandbox only**. Never add live credentials or the live base URL.
- Before touching `src/server/paypal.ts` or `src/server/queue.ts`, load the APIMatic Context Plugin skills for the
  PayPal TypeScript Server SDK (`paypal:typescript-getting-started`, then `-calling-endpoints`, `-error-handling`,
  `-configuration-resilience`). Pin: `@paypal/paypal-server-sdk@2.5.0`.
- Every money-moving call goes through `src/server/queue.ts`; the op key is the `PayPal-Request-Id`.
- Identity (payer id, email) is stored only as an HMAC; never send PayPal order details to the browser.
- Nothing is auto-merged by the AI: clusters are suggestions until the seller confirms.
- Tests: `pnpm test` (unit + mocked flow), `pnpm e2e` (Playwright against a running instance).
