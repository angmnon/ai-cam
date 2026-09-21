import { defineConfig, devices } from "@playwright/test";

/**
 * P1-03 前端 E2E。
 * - webServer 自动拉起 API（e2e/start-api.mjs，端口 8090）与 Vite dev（5173）。
 * - 前端通过 VITE_API_BASE 直连 8090（避免与用户已占用的 8080 容器冲突；不改其代码/状态）。
 * - 复用已运行实例（reuseExistingServer: true），便于本地调试。
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  retries: 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "e2e/.playwright-report" }]],
  use: {
    baseURL: "http://localhost:5173",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: [
    {
      command: "node e2e/start-api.mjs",
      url: "http://localhost:8090/health",
      reuseExistingServer: true,
      timeout: 60_000,
      stdout: "ignore",
      stderr: "pipe",
    },
    {
      command: "pnpm --filter @ai-cam/web dev",
      url: "http://localhost:5173",
      reuseExistingServer: true,
      timeout: 120_000,
      env: {
        VITE_API_BASE: "http://localhost:8090",
      },
    },
  ],
});
