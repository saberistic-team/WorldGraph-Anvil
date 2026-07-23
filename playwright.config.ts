import { defineConfig, devices } from '@playwright/test';

// Keep browser tests isolated from the local Compose web service, which owns port 3000.
const requestedPort = Number(process.env.PLAYWRIGHT_PORT ?? '3100');
const webPort =
  Number.isInteger(requestedPort) && requestedPort >= 1 && requestedPort <= 65_535
    ? requestedPort
    : 3100;
const baseURL = `http://127.0.0.1:${webPort}`;

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: true,
  retries: process.env.CI ? 2 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    {
      name: 'mobile-320',
      use: { ...devices['Pixel 5'], viewport: { height: 720, width: 320 } },
    },
  ],
  webServer: {
    command: `apps/web/node_modules/.bin/next dev apps/web --hostname 127.0.0.1 --port ${webPort}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    url: `${baseURL}/health/live`,
  },
});
