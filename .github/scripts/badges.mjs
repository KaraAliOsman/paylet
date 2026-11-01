#!/usr/bin/env node
// Writes the README badges as shields.io "endpoint" JSON files in docs/badges/ (no third-party service, no token).
//
//   pnpm badges                                   → tests + coverage, from a fresh `vitest run --coverage`
//   node .github/scripts/badges.mjs --e2e-real test-results/e2e-real.json
//                                                 → also records a REAL PayPal sandbox e2e run (Playwright JSON report)
//
// The real-sandbox suite needs a PayPal login, so it runs on a developer machine, never in CI. Only titles, outcomes,
// durations and the date are kept: no emails, ids or traces end up in the repo.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { execSync } from "node:child_process";

const root = process.cwd();
const out = (p, data) => {
  mkdirSync(dirname(join(root, p)), { recursive: true });
  writeFileSync(join(root, p), JSON.stringify(data, null, 2) + "\n");
  console.log("wrote", p);
};
const badge = (label, message, color) => ({ schemaVersion: 1, label, message, color });
const pctColor = (p) => (p >= 80 ? "brightgreen" : p >= 60 ? "green" : p >= 45 ? "yellowgreen" : p >= 30 ? "yellow" : "orange");
const sha = () => {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
};

// ---- unit tests + coverage (vitest)
const vitestJson = join(root, "test-results/vitest.json");
if (existsSync(vitestJson)) {
  const v = JSON.parse(readFileSync(vitestJson, "utf8"));
  const ok = v.success && v.numFailedTests === 0;
  out("docs/badges/tests.json", badge("unit tests", `${v.numPassedTests}/${v.numTotalTests} passing`, ok ? "brightgreen" : "red"));
}
const covJson = join(root, "test-results/coverage/coverage-summary.json");
if (existsSync(covJson)) {
  const t = JSON.parse(readFileSync(covJson, "utf8")).total;
  const lines = Math.round(t.lines.pct * 10) / 10;
  out("docs/badges/coverage.json", badge("coverage (server)", `${lines}% lines`, pctColor(lines)));
}

// ---- real PayPal sandbox e2e (Playwright JSON reporter)
const i = process.argv.indexOf("--e2e-real");
if (i > 0) {
  const file = process.argv[i + 1];
  const r = JSON.parse(readFileSync(join(root, file), "utf8"));
  const tests = [];
  const walk = (suite) => {
    for (const s of suite.suites ?? []) walk(s);
    for (const spec of suite.specs ?? [])
      for (const t of spec.tests ?? []) {
        const last = t.results?.[t.results.length - 1];
        tests.push({ title: spec.title, status: last?.status ?? "skipped", durationMs: last?.duration ?? 0, retries: Math.max(0, (t.results?.length ?? 1) - 1) });
      }
  };
  for (const s of r.suites ?? []) walk(s);
  const passed = tests.filter((t) => t.status === "passed").length;
  const date = (r.stats?.startTime ?? new Date().toISOString()).slice(0, 10);
  const run = {
    suite: "e2e/real-paypal.spec.ts",
    environment: "PayPal SANDBOX (no mocks): a sandbox buyer logs in inside PayPal's window; every hold, capture and void is cross-checked with GET /v2/payments/authorizations/{id}",
    baseUrl: process.env.E2E_BASE_URL ?? null,
    commit: sha(),
    date,
    passed,
    total: tests.length,
    tests,
  };
  out("docs/e2e-real/latest.json", run);
  out("docs/badges/e2e-real.json", badge("real PayPal sandbox e2e", `${passed}/${tests.length} · ${date}`, passed === tests.length && passed > 0 ? "brightgreen" : "red"));
}
