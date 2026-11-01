import { defineConfig } from "@playwright/test";

// Runs against a live app with seeded data: ./db.sh e2e
export default defineConfig({
  testDir: "tests/e2e",
  outputDir: "tests/e2e/.output",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:3100",
    screenshot: "only-on-failure",
  },
  workers: 1,
});
