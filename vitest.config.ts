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
      // Floors, not goals: CI fails if coverage drops below today's level. Raise them as tests are added.
      thresholds: {
        statements: 40,
        branches: 28,
        functions: 38,
        lines: 44,
        // The verifiable draw and money helpers are what anyone re-runs in /verify: keep them fully covered.
        "src/shared/**": { statements: 90, branches: 75, functions: 90, lines: 90 },
      },
    },
  },
});
