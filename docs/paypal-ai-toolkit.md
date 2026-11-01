# How we used the PayPal AI-Toolkit

Besides the APIMatic Context Plugin ([`apimatic-context-plugin.md`](./apimatic-context-plugin.md)), we audited Paylet with
PayPal's official **AI-Toolkit** plugin for Claude Code ([github.com/paypal/AI-Toolkit](https://github.com/paypal/AI-Toolkit),
plugin `paypal` 1.2.0): its `/paypal:doctor` diagnostic and its `/paypal:explain-error` reference, backed by the
`paypal-best-practices` skill.

## How we ran it (2026-10-31, read-only)
We did not install the plugin permanently. Each session loaded it for one run, over a **copy** of `src/` (commit `4e11af4`)
with no `.env` or credentials anywhere near it, with read-only tools only and no MCP servers:
```bash
claude -p "/paypal:doctor full" \
  --plugin-dir ./AI-Toolkit \
  --allowedTools Skill,Read,Grep,Glob \
  --disallowedTools Edit,Write,Bash,NotebookEdit,WebFetch,WebSearch \
  --strict-mcp-config
claude -p "/paypal:explain-error 422 UNPROCESSABLE_ENTITY AUTHORIZATION_VOIDED (...)" --plugin-dir ./AI-Toolkit ...
claude -p "/paypal:explain-error 429 RATE_LIMIT_REACHED (...)" --plugin-dir ./AI-Toolkit ...
```
Raw output, verbatim (in Spanish, the author's locale): [`paypal-ai-toolkit-review-2026-10-31.es.md`](./paypal-ai-toolkit-review-2026-10-31.es.md).

## What the doctor said
**2 critical · 5 warnings · 23 passed.** Among the passes: Orders v2 `AUTHORIZE` with a server-side amount and breakdown,
APPROVED checked before authorizing, partial capture with `final_capture`, a `PayPal-Request-Id` on every POST and unique
per logical operation, token caching with a single in-flight fetch, webhook signature verification on the raw body,
`event_id` de-duplication, sandbox-only base URL, `debug_id` kept on every failure, and a JS SDK v6 integration that follows
the official pattern (`createInstance` → `findEligibleMethods` → `session.start(options, orderPromise)`, `data.orderId`).

## Findings → changes
"Owner" is the Paylet workstream that applies the change; the toolkit itself never edited code.

| # | Toolkit finding | Severity | Change | Status |
|---|---|---|---|---|
| 1 | `PAYMENT.CAPTURE.COMPLETED` / `DENIED` webhooks were only logged, so a capture that PayPal returns as `PENDING` never settles the drop (doctor, Webhooks) | critical | Webhooks route state: `COMPLETED` → captured + settle, `DENIED` → capture_failed + waitlist; sweeper re-checks `won` entries with `GET /v2/payments/captures/{id}` | planned as P1-05 (backend) |
| 2 | `INSTRUMENT_DECLINED` on authorize marks the entry `error` but keeps its payer slot (unique index), and the retry would reuse `auth:<entry>` (doctor, Orders) | critical | Return the entry to `awaiting_person` with the PayPal approval link ("choose another funding source"), release the payer slot, and key each authorize attempt `auth:<entry>:<n>` | planned with P2-03 (backend) |
| 3 | A 429 counts against the 8-attempt cap: ~8 min of rate limiting turns a winner's capture into a terminal failure (explain-error 429) | warning | 429 does not consume attempts; give up on time (an authorization stays capturable for days), not on count | proposed (backend, `queue.ts`) |
| 4 | After a 429 only that op waits; the rest of the queue keeps firing, retries are synchronized, and the token bucket starts full after a restart (explain-error 429) | warning | Global pause until `Retry-After`, drain the bucket, ±20% jitter on backoff, start the bucket at 1 token | proposed (backend, `queue.ts`) |
| 5 | When capture retries are exhausted on 5xx/network errors, the hold is voided and the unit goes to the waitlist although the buyer did nothing wrong (doctor, Environment) | warning | Treat exhausted `RETRYABLE` like `CONFIG`: park the op and alert, never burn the waitlist on a PayPal or network outage | proposed (backend, `domain.ts`) |
| 6 | The authorization status is not checked: a `DENIED` authorization would count as a hold (doctor, Orders) | warning | Accept only `CREATED` / `PENDING`; anything else goes through `onTerminal` | proposed (backend, `domain.ts`) |
| 7 | `HASH_SECRET` has a public default, so payer/email HMACs could be reproduced by brute force (doctor, Credentials) | warning | Refuse to boot with the default secret when `PUBLIC_URL` is https | planned as P2-14 (backend) |
| 8 | `PUBLIC_URL` (PayPal `return_url`/`cancel_url`) may be plain http outside localhost (doctor, Orders) | warning | Validate: https, or http only for localhost | proposed (backend, `env.ts`) |
| 9 | No CSRF protection on `POST /api/drops/:slug/entries`, which creates PayPal orders (doctor, Environment) | warning | Reject cross-site non-GET API calls (`Sec-Fetch-Site` / `Origin` check); `/mcp` and webhooks unaffected | proposed (backend, `index.ts`) |
| 10 | Rate-limit key from the last `X-Forwarded-For` hop can be spoofed (doctor, info) | info | Use `cf-connecting-ip` / `true-client-ip`, internal token for Paylet's own MCP traffic | planned as P0-02 (backend) |
| 11 | A cached REST token is not invalidated on 401 (doctor, info) | info | Drop the cached token on 401 and retry once | proposed (backend, `paypal.ts`) |
| 12 | A void on an already `CAPTURED` authorization would label the entry "voided, never charged" (doctor, info) | info | If PayPal says `CAPTURED`/`PARTIALLY_CAPTURED`, record that state instead of `voided` | proposed (backend, `domain.ts`) |
| 13 | Authorizations are honoured for 3 days; drops longer than 72 h would need reauthorization (doctor, info) | info | Drops close within 48 h; listed under "Launch requirements" in the README | documented |
| 14 | `AUTHORIZATION_VOIDED` (422) is already handled correctly: classified terminal, confirmed with a GET, unit promoted to the waitlist, no second void. Only a code comment was wrong: an expired hold returns `AUTHORIZATION_EXPIRED`, not the same error (explain-error 422) | info | Fix the comment in the negative-test branch; superseded if the negative test moves to `PayPal-Mock-Response` (P2-03) | proposed (backend, comment only) |

## Why it mattered
Both critical findings are unhappy paths that our unit tests did not cover, because they need PayPal to answer something
other than the happy path. Finding 1 confirmed a gap our own engineering review had already flagged; findings 2 to 6 were
new to us, and finding 3 would have turned a sandbox rate limit into a lost sale during a busy draw. The toolkit found
them from the code alone, in a few minutes, without credentials.
