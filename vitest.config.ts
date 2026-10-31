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
  },
});
