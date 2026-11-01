# Real PayPal sandbox end-to-end runs

[`e2e/real-paypal.spec.ts`](../../e2e/real-paypal.spec.ts) drives the real PayPal **sandbox** with no mocks: Playwright
logs in as a sandbox buyer in PayPal's own approval window, and every outcome is cross-checked against PayPal's records
with `GET /v2/payments/authorizations/{id}`, not against Paylet's database.

Latest recorded run: [`latest.json`](./latest.json) (also shown by the README badge).

| # | Scenario | What PayPal must say |
|---|---|---|
| 1 | JS SDK v6 button → hold; same PayPal account again → "no hold placed" | one authorization, `CREATED`; Paylet counts 1 duplicate blocked |
| 2 | Agent (MCP) approval link → person approves → draw → partial capture | `PARTIALLY_CAPTURED` / `CAPTURED`, $44.50 of a $48.00 hold |
| 3 | Sandbox negative test on a real hold → capture fails | capture answers `422`; the authorization ends `VOIDED` (never charged) |
| 4 | Real entrant + labelled simulated crowd + AI review + confirmed cluster → draw | loser: `VOIDED`; winner: `CAPTURED` |
| 5 | Buyer cancels inside PayPal | no authorization exists; 0 holds |

## Why it runs locally and not in CI
The PayPal login can show a captcha on shared CI runners, and the sandbox buyer password must never live in GitHub.
The daily CI job ([`e2e-prod.yml`](../../.github/workflows/e2e-prod.yml)) runs the judge flow against production without
a PayPal login instead.

## Run it and record the result
```bash
# credentials stay outside the repo; the files are read by playwright.config.ts (E2E_ENV_FILES)
E2E_ENV_FILES=../.secrets/buyer.env,../.secrets/paypal.env \
E2E_BASE_URL=https://paylet.onrender.com \
PLAYWRIGHT_JSON_OUTPUT_NAME=test-results/e2e-real.json \
pnpm e2e:real --reporter=list,json

node .github/scripts/badges.mjs --e2e-real test-results/e2e-real.json   # updates latest.json + the badge
```
Only scenario titles, outcomes, durations, the date and the commit are written to the repo. Traces and screenshots
(which can show the sandbox login page) stay in the git-ignored `test-results/`.
