# Security policy

Paylet is a hackathon project that talks **only to the PayPal sandbox**. No real money moves and no live PayPal
credentials exist anywhere in this repository or its deployment.

## Reporting a vulnerability
Please report privately through GitHub: **Security → Report a vulnerability** on this repository
(<https://github.com/KaraAliOsman/paylet/security/advisories/new>). Do not open a public issue for security problems.
You can expect a first answer within 72 hours. Credit is given in the changelog unless you prefer otherwise.

In scope: the code in this repository and the demo at <https://paylet.onrender.com> (for example, placing a second hold
with one PayPal account, reading another person's entry details, forging a webhook, bypassing the seller key, or getting
an agent to place a hold without a person). Please do not run load tests or automated scanners against the demo: it runs
on a small free instance that judges are using, and the PayPal sandbox rate-limits the shared app.

Out of scope: the PayPal sandbox itself (report those to PayPal), social engineering, and findings that need a
compromised machine or a malicious seller (the seller is trusted by design; see "What this does not guarantee" in the README).

## How Paylet protects money and data
- **Sandbox only, by construction.** The PayPal base URL is hard-coded to `api-m.sandbox.paypal.com` and the Server SDK is
  created with `Environment.Sandbox`.
- **No secrets in the repo.** Credentials come from environment variables (`.env` locally, Render's dashboard in
  production); `.env*` files are git-ignored. GitHub Actions never receives PayPal or AI credentials.
- **Every money-moving call is idempotent.** Authorize, capture and void go through a persistent queue whose key is the
  `PayPal-Request-Id`, so a retry after a crash cannot charge twice.
- **Identity is stored as an HMAC.** The PayPal payer id and email are kept only as `HMAC-SHA256(HASH_SECRET, …)`; the
  browser never receives PayPal order details.
- **Webhooks are verified** with `POST /v1/notifications/verify-webhook-signature` on the raw body and de-duplicated by
  `event_id` before they change anything.
- **Agents cannot pay.** The MCP server can only create an order and return PayPal's approval link; a hold exists only
  after a person approves inside PayPal.
- **Abuse limits.** Per-client rate limits on entries, agent chat, judge drops and MCP; request body limits; per-drop caps
  on simulated entrants and AI analysis; a daily cap on LLM calls.
- **What goes to the LLM.** Only the fuzzy candidate pairs (names and shipping addresses of sandbox buyers or simulated
  entrants) are sent to the model, and nothing is merged until the seller confirms. Details in the README, "Data flow & PII".
- **Automated checks.** CodeQL code scanning and Dependabot run on this repository; CI runs type checks, unit tests with
  coverage floors, and a daily end-to-end test against the live demo.

## Supported versions
Only the `main` branch (the deployed demo) receives fixes.
