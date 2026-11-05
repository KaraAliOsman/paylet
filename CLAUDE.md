# Paylet — notes for AI coding agents

- PayPal **sandbox only**. Never add live credentials or the live base URL.
- Before touching `src/server/paypal.ts` or `src/server/queue.ts`, load the APIMatic Context Plugin skills for the
  PayPal TypeScript Server SDK (`paypal:typescript-getting-started`, then `-calling-endpoints`, `-error-handling`,
  `-configuration-resilience`). Pin: `@paypal/paypal-server-sdk@2.5.0`.
- Every call that moves money goes through `src/server/queue.ts`; the op key is the `PayPal-Request-Id`. Creating an order moves no money and runs inline, capped by `startEntry`.
- Payer id and account id are stored only as HMACs. The email is stored as an HMAC plus server-side clear text (alias detection) and never sent to a browser. Name and address go only to the drop's seller console.
- The drand round fixed at the freeze is final: never add a fallback or a second round.
- Nothing is auto-merged by the AI: clusters are suggestions until the seller confirms.
- Tests: `pnpm test` (unit + mocked flow), `pnpm e2e` (Playwright against a running instance).
