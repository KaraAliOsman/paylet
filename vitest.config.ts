import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    pool: "forks",
    env: {
      PAYLET_NO_LISTEN: "1",
      PAYLET_DB: ":memory:",
      PAYPAL_CLIENT_ID: "test-client-id-not-real",
      PAYPAL_CLIENT_SECRET: "test-client-secret-not-real",
      AI_API_KEY: "",
      HASH_SECRET: "test-hash-secret",
      DATA_DIR: "./data/test",
      PUBLIC_URL: "http://localhost:8790",
    },
    // `pnpm test:coverage`. Scope = the server and the shared draw/money code that unit tests exercise.
    // The React UI is covered by Playwright (e2e/), not by unit coverage.
    coverage: {
      provider: "v8",
      include: ["src/server/**/*.ts", "src/shared/**/*.ts"],
      reporter: ["text-summary", "text", "json-summary", "html", "lcov"],
      reportsDirectory: "test-results/coverage", // already git-ignored
      // Floors, not goals: about 5 points under the level measured on 2026-11-01, so CI fails if coverage regresses.
      // The goal is 80% on domain, queue and paypal; raise these floors as unhappy-path tests land.
      // paypal.ts has no unit floor: the flow tests mock it, and the real PayPal sandbox suite (e2e/) exercises it.
      thresholds: {
        statements: 40,
        branches: 28,
        functions: 38,
        lines: 44,
        // Money state machine and the PayPal op queue (measured: domain 55/41/59/60, queue 73/50/56/83).
        "src/server/domain.ts": { statements: 50, branches: 36, functions: 54, lines: 54 },
        "src/server/queue.ts": { statements: 68, branches: 45, functions: 50, lines: 77 },
        // The draw and money helpers that anyone re-runs in /verify (measured: 95/82/100/100).
        "src/shared/**": { statements: 90, branches: 75, functions: 90, lines: 90 },
      },
    },
  },
});
