import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir:  './e2e',
  timeout:  30_000,
  reporter: 'list',
  use: {
    baseURL:     'http://localhost:3120',
    trace:       'on-first-retry',
    screenshot:  'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  // Start the dev server before running e2e tests
  webServer: {
    command:              'pnpm dev',
    url:                  'http://localhost:3120',
    reuseExistingServer:  !process.env['CI'],
  },
});
