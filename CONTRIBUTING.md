# Contributing to Paylet

Thanks for looking. Paylet is small on purpose: one Node process (Hono + SQLite), one React app, PayPal **sandbox** only.

## Setup
Requirements: Node 24 and pnpm (see `packageManager` in `package.json`).
```bash
pnpm install
cp .env.example .env    # PayPal SANDBOX client id/secret; an OpenAI-compatible AI key is optional (rules-only without it)
pnpm build && pnpm start  # http://localhost:8790 — the showcase seller console link is printed on boot
```
For webhooks on your machine, expose the port with a tunnel (for example `cloudflared tunnel --url http://localhost:8790`)
and set `PUBLIC_URL` to the https URL; Paylet registers its webhook on boot when `PUBLIC_URL` is https.

## Tests
| Command | What it runs | Needs |
|---|---|---|
| `pnpm typecheck` | TypeScript, strict | — |
| `pnpm test` | unit tests + the whole drop lifecycle against a mocked PayPal | — |
| `pnpm test:coverage` | the same, with coverage floors from `vitest.config.ts` | — |
| `pnpm e2e` | Playwright judge flow against a running instance (`E2E_BASE_URL`, default `http://127.0.0.1:8790`) | a running Paylet |
| `pnpm e2e:real` | real PayPal sandbox suite: buyer login, holds, captures, voids, cross-checked with PayPal | sandbox buyer + app credentials, see [`docs/e2e-real/`](docs/e2e-real/README.md) |
| `pnpm evals` | entity-resolution evals on the frozen dataset | an OpenAI-compatible key |
| `pnpm badges` | refreshes the README badges in `docs/badges/` | — |

CI (`.github/workflows/ci.yml`) runs typecheck, tests with coverage and the build on every push. `e2e-prod.yml` runs the
judge flow against the live demo every day.

## Rules of the codebase
- **Sandbox only.** Never add live credentials or the live PayPal base URL.
- **Money moves through the queue.** Every authorize/capture/void/refund goes through `src/server/queue.ts`; the op key is
  the `PayPal-Request-Id`. Never call a money-moving endpoint directly from a request handler.
- **State transitions are conditional.** `UPDATE … WHERE id = ? AND status IN (…)`, so a webhook, the sweeper and the
  queue can race without double-processing.
- **Identity stays server-side.** Payer id and email are stored only as HMACs; PayPal order details never reach the browser.
- **AI suggests, people decide.** Nothing is merged without the seller's confirmation; fan-facing explanations are templates.
- **Label simulated data.** Anything not backed by a real PayPal call carries `real = 0` and is shown as simulated.

## Working with AI coding agents
`CLAUDE.md` holds the same rules for agents. Before touching `src/server/paypal.ts` or `src/server/queue.ts`, load the
APIMatic Context Plugin skills for the PayPal TypeScript Server SDK ([`docs/apimatic-context-plugin.md`](docs/apimatic-context-plugin.md));
the PayPal AI-Toolkit's `/paypal:doctor` is a good check afterwards ([`docs/paypal-ai-toolkit.md`](docs/paypal-ai-toolkit.md)).

## Commits and pull requests
- Small commits, one backlog item or fix each: `feat(P1-03): ask PayPal live check`, `fix(queue): …`, `docs(readme): …`.
- Add a line to [`CHANGELOG.md`](CHANGELOG.md) under "Unreleased".
- Pull requests need green CI. Describe what you verified against the sandbox, if anything.
- Security problems: see [`SECURITY.md`](SECURITY.md), not public issues.

By contributing you agree that your work is released under the MIT license of this repository.
