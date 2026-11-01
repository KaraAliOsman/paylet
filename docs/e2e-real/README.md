# Real PayPal sandbox end-to-end runs

[`e2e/real-paypal.spec.ts`](../../e2e/real-paypal.spec.ts) drives the real PayPal **sandbox** with no mocks: Playwright
logs in as a sandbox buyer in PayPal's own approval window. Every hold, capture and void the suite produces is
cross-checked with PayPal (`GET /v2/payments/authorizations/{id}`); counts such as holds, blocked duplicates and the
captured amount come from Paylet's seller API.

Latest recorded run: **5/5 on 2026-10-31, commit `4e11af4`** ([`latest.json`](./latest.json), also shown by the README
badge). `latest.json` always names the commit the run used, so a newer commit means the record is older than the code.

| # | Scenario | What the test asserts | Checked with |
|---|---|---|---|
| 1 | JS SDK v6 button → hold; same PayPal account again → "no hold placed" | the authorization is `CREATED`; Paylet counts 1 hold and 1 blocked duplicate | PayPal + Paylet |
| 2 | Agent (MCP) approval link → person approves → draw → partial capture | the authorization is `PARTIALLY_CAPTURED` / `CAPTURED`; Paylet captured $44.50 of the $48.00 hold | PayPal + Paylet |
| 3 | Sandbox negative test on the only real entrant (no waitlist) → capture fails | entry `capture_failed`; the authorization ends `VOIDED` (never charged) | PayPal + Paylet |
| 4 | Real entrant + labelled simulated crowd + AI review → draw | whichever way the draw goes, PayPal agrees: `CAPTURED` if the real entrant won, `VOIDED` if not | PayPal + Paylet |
| 5 | Buyer cancels inside PayPal | the return page says no hold was placed; 0 holds | Paylet |

The test titles in `latest.json` are the ones the suite had at `4e11af4`; two of them say more than the test asserts
(scenario 3 has no waitlist, so no unit passes on; scenario 4 does not confirm a cluster and accepts either outcome).
The table above is what each test actually checks.

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
