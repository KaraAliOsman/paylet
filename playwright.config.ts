import { defineConfig } from "@playwright/test";

// Runs against a live Paylet (local `pnpm start` or the hosted demo):  E2E_BASE_URL=https://… pnpm e2e
export default defineConfig({
  testDir: "e2e",
  timeout: 180_000,
  use: { baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:8790", trace: "retain-on-failure" },
  reporter: [["list"]],
});
