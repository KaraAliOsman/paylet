# How we used the APIMatic Context Plugin

Paylet's PayPal layer is built on the APIMatic-generated **PayPal TypeScript Server SDK** (`@paypal/paypal-server-sdk@2.5.0`),
and we used the **APIMatic Context Plugin** (`paypaldev/server-sdk-context-plugin-preview`) inside Claude Code to review it.

## Install (what we ran, 2026-10-31)
```bash
CP_TELEMETRY=off npx -y context-plugins@0.12.0 install https://github.com/paypaldev/server-sdk-context-plugin-preview --targets claude --yes
claude plugin list   # → paypal@context-plugins-local · enabled
```
The repo also ships `.claude/settings.json` (marketplace + `enabledPlugins`) and `CLAUDE.md` so anyone opening the project
in Claude Code gets the same skills.

## The review
A headless Claude Code session loaded `paypal:typescript-getting-started`, `paypal:typescript-error-handling`,
`paypal:typescript-configuration-resilience` and `paypal:typescript-calling-endpoints`, then audited
`src/server/paypal.ts` and `src/server/queue.ts`. Raw output (in Spanish, the author's locale):
[`apimatic-review-2026-10-31.es.md`](./apimatic-review-2026-10-31.es.md).

## What changed because of it
| Finding (skill) | Fix in Paylet |
|---|---|
| Non-`ApiError` failures were all retried (error-handling) | `classify()` now separates network/abort (retry), missing credentials (config) and bugs (terminal) |
| SDK `timeout` is per attempt and doesn't cover the OAuth fetch (configuration-resilience) | every SDK call passes `requestOptions.abortSignal` (45 s) and each queue op has a hard 90 s deadline |
| `debug_id` only read from the body; `Retry-After` ignored (error-handling) | `debug_id` falls back to the `paypal-debug-id` header and is stored with the op; backoff honours `Retry-After` |
| Logging could print `Authorization` headers (configuration-resilience) | SDK logging off by default; when enabled: `maskSensitiveHeaders`, no headers, no bodies |
| `result.id!` non-null assertion (calling-endpoints) | explicit check, terminal error |
| Parallel token fetches in the raw REST helper | in-flight promise de-duplication; HTTP errors carry `debug_id` |
