import { defineConfig, devices } from '@playwright/test'

/**
 * Runs against the production build, not the dev server: the perf harness is
 * gated behind `?bench=1` in production, dev has different chunking, and the
 * numbers this suite asserts are only meaningful on the shipped bundle.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'retain-on-failure',
    // DPR 2 so the devicePixelRatio path is the one under test.
    deviceScaleFactor: 2,
    viewport: { width: 1440, height: 900 },
    ...devices['Desktop Chrome'],
    // This sandbox can't reach cdn.playwright.dev to fetch the pinned
    // Chromium build, so run against the system-installed Google Chrome
    // instead of the bundled browser. Remove once the download works.
    channel: 'chrome',
  },
  webServer: {
    // `vite preview` still honours `server.proxy` for `/events`, so without
    // the SSE backend the FUNSD document's HEAD probe 502s and Chromium logs
    // it as a console error — start `dev:sse` alongside the built preview so
    // the default document boots clean, same as it would with real infra.
    command: 'pnpm exec concurrently -k "pnpm dev:sse" "pnpm build && pnpm preview --port 4173"',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
})
