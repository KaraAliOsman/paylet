# Changelog

All notable changes to Paylet. Dates are in America/Santiago time. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- Unit-test coverage (`pnpm test:coverage`, `@vitest/coverage-v8`) with floor thresholds; CI publishes a coverage summary
  and report.
- `e2e-prod` workflow: the judge flow runs every day against the live demo; the Playwright report is kept as an artifact.
- Self-hosted README badges (unit tests, coverage, real PayPal sandbox e2e) and a record of real sandbox runs in
  `docs/e2e-real/`.
- CodeQL code scanning, grouped Dependabot updates, `SECURITY.md`, `CONTRIBUTING.md` and this changelog.
- PayPal AI-Toolkit review (`/paypal:doctor`, `/paypal:explain-error`) with every finding mapped to a change
  (`docs/paypal-ai-toolkit.md`).

### Changed
- README rewritten for judges: the PayPal thesis ("PayPal Verified Drops"), cited impact, real-sandbox proof, unhappy
  paths and idempotency keys, the entry state machine, a judging-criteria map, bring-your-own-agent, data flow & PII,
  launch requirements and a quickstart.

### Fixed
- Factual corrections: the DOJ/FTC case is cited from the FTC's press release ("7,624 tickets for a single concert",
  alleged); "proof of personhood" removed (a hold is proof of a real customer who can pay, not of a unique human); the
  draw order is freeze → public randomness → reveal; local port is 8790 everywhere; a single test count, from the badge.

## [0.1.0] — 2026-10-31
First public version, built during the PayPal AI Hackathon.

### Added
- **Fair limited drops on PayPal** (`1f914f5`, 20:58): every entry is an Orders v2 `AUTHORIZE` hold created through the
  PayPal TypeScript Server SDK; one hold per PayPal account (payer read server-side, unique per drop); persistent
  idempotent op queue keyed by `PayPal-Request-Id`; partial capture for winners (price + actual shipping), void for
  everyone else, waitlist promotion when a payment fails; signed webhooks; commit-reveal draw re-runnable at `/verify`;
  MCP server (`list_drops`, `enter_drop`, `entry_status`) with a fan agent and a scalper swarm; entity resolution with
  rules + MiMo V2.6 Pro adjudication and a frozen red-team eval set; React + JS SDK v6 UI, seller console, judge mode;
  Vitest and Playwright tests.
- Owner key for seller consoles that survives restarts (`735752d`, 21:01).
- Playwright test of the agent page flow (`25d4b7d`, 21:20).
- Gallery screenshots from the live demo (`a37ae06`, `c3bafa9`).
- Real PayPal sandbox e2e suite: buyer login in PayPal's window, every hold, capture and void cross-checked with PayPal;
  judge quota tweak; keep-alive workflow for the free instance (`bc90a0d`, 21:53).
- Deterministic "cancel in PayPal" scenario; **5/5 real sandbox scenarios pass** (`4e11af4`, 21:57).

### Security / hardening (`6b6021c`, 21:11, from an adversarial review)
- Money: atomic conditional state transitions in finalize/draw (no hold can be created after a draw), authorize/capture
  guards, capture status check (`PENDING`/`DECLINED`), terminal-capture reconciliation via GET, configuration errors no
  longer consume the waitlist, sweeps for stray holds and failed voids, the negative test prefers a simulated winner.
- Abuse: body limits, MCP batch rejection, client IP from the proxy, per-IP judge quota, reserved LLM budget per purpose,
  per-drop caps and an analysis lock, cluster ownership check, constant-time key comparison, templated fan explanations.
- Demo: persistent judge links, robust `onApprove`, real-vs-simulated counters, 404 pages, rules-only fallback when the
  LLM fails, keep-alive while judge drops are in flight.

### Fixed
- Agent page crash: `scrollIntoView` returns a Promise in new browsers (`a37ae06`, 21:19).
- Early-settle race during waitlist promotion; public entry ids shown to the model; regression test (`3763826`, 21:23).

[Unreleased]: https://github.com/KaraAliOsman/paylet/compare/4e11af4...HEAD
[0.1.0]: https://github.com/KaraAliOsman/paylet/commits/4e11af4
