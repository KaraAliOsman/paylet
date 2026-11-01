import { defineConfig } from "@playwright/test";

// Optional env files (comma separated), e.g. sandbox buyer + app credentials for the REAL PayPal suite.
for (const f of (process.env.E2E_ENV_FILES ?? "").split(",").filter(Boolean)) process.loadEnvFile(f);

// Runs against a live Paylet (local `pnpm start` or the hosted demo):  E2E_BASE_URL=https://… pnpm e2e
export default defineConfig({
  testDir: "e2e",
  timeout: 180_000,
  use: { baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:8790", trace: "retain-on-failure", screenshot: "only-on-failure" },
  reporter: [["list"]],
});
