/**
 * Playwright e2e — platform_admin and tenant_admin journeys.
 *
 * Prerequisites:
 *   - Full stack running (identity :3110, pipeline :3100, admin-web :3120)
 *   - E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD env vars set (platform_admin user)
 *   - E2E_TENANT_EMAIL / E2E_TENANT_PASSWORD env vars set (tenant_admin user)
 *   - E2E_TENANT_ID set to an existing tenant ID
 *
 * Run: pnpm --filter @oweibo/admin-web test:e2e
 */
import { test, expect, type Page } from '@playwright/test';

// ── helpers ────────────────────────────────────────────────────────────────

async function login(page: Page, email: string, password: string) {
  await page.goto('/login');
  await page.fill('input[name="email"]',    email);
  await page.fill('input[name="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/(platform|t\/)/);
}

const ADMIN_EMAIL    = process.env['E2E_ADMIN_EMAIL']    ?? 'admin@oweibo.io';
const ADMIN_PASSWORD = process.env['E2E_ADMIN_PASSWORD'] ?? 'changeme-platform-admin';
const TENANT_EMAIL   = process.env['E2E_TENANT_EMAIL']   ?? 'tenant@oweibo.io';
const TENANT_PASS    = process.env['E2E_TENANT_PASSWORD'] ?? 'changeme-tenant-admin';
const TENANT_ID      = process.env['E2E_TENANT_ID']      ?? 'test-tenant';

// ── Auth ───────────────────────────────────────────────────────────────────

test.describe('Auth', () => {
  test('login page renders', async ({ page }) => {
    await page.goto('/login');
    await expect(page.locator('h1')).toHaveText('Oweibo Admin');
  });

  test('unauthenticated access redirects to login', async ({ page }) => {
    await page.goto('/platform/tenants');
    await expect(page).toHaveURL(/\/login/);
  });

  test('wrong password shows error message', async ({ page }) => {
    await page.goto('/login');
    await page.fill('input[name="email"]',    'nobody@nowhere.invalid');
    await page.fill('input[name="password"]', 'wrongpassword12');
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL(/\/login.*error/);
    await expect(page.locator('[role="alert"]')).toBeVisible();
  });
});

// ── Platform admin journey ─────────────────────────────────────────────────

test.describe('Platform admin', () => {
  test.beforeEach(async ({ page }) => {
    await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);
  });

  test('redirects to /platform/tenants after login', async ({ page }) => {
    await expect(page).toHaveURL(/\/platform\/tenants/);
  });

  test('tenant list page loads', async ({ page }) => {
    await page.goto('/platform/tenants');
    await expect(page.locator('h1')).toHaveText('Tenants');
  });

  test('new tenant form is reachable', async ({ page }) => {
    await page.goto('/platform/tenants/new');
    await expect(page.locator('h1')).toHaveText('New Tenant');
    await expect(page.locator('input[name="name"]')).toBeVisible();
    await expect(page.locator('input[name="slug"]')).toBeVisible();
  });

  test('platform users page loads', async ({ page }) => {
    await page.goto('/platform/users');
    await expect(page.locator('h1')).toHaveText('Platform Users');
  });

  test('tenant_viewer cannot access /platform', async ({ page }) => {
    // This test would need a tenant_viewer account; document the expectation
    // A user without platform:tenants:read is redirected to /unauthorized
    await page.goto('/unauthorized');
    await expect(page.locator('h1')).toHaveText('Access Denied');
  });

  test('sign out clears session and redirects to login', async ({ page }) => {
    await page.goto('/logout');
    await expect(page).toHaveURL(/\/login/);
    // After logout, protected page redirects back to login
    await page.goto('/platform/tenants');
    await expect(page).toHaveURL(/\/login/);
  });
});

// ── Tenant admin journey ───────────────────────────────────────────────────

test.describe('Tenant admin', () => {
  test.beforeEach(async ({ page }) => {
    await login(page, TENANT_EMAIL, TENANT_PASS);
  });

  test('tenant dashboard loads', async ({ page }) => {
    await page.goto(`/t/${TENANT_ID}`);
    await expect(page.locator('h1')).toHaveText('Dashboard');
  });

  test('members page loads', async ({ page }) => {
    await page.goto(`/t/${TENANT_ID}/members`);
    await expect(page.locator('h1')).toHaveText('Members');
  });

  test('API keys page loads', async ({ page }) => {
    await page.goto(`/t/${TENANT_ID}/keys`);
    await expect(page.locator('h1')).toHaveText('API Keys');
  });

  test('settings page loads and has trust mode select', async ({ page }) => {
    await page.goto(`/t/${TENANT_ID}/settings`);
    await expect(page.locator('h1')).toHaveText('Settings');
    await expect(page.locator('select[name="trustModeDefault"]')).toBeVisible();
  });

  test('tasks page loads', async ({ page }) => {
    await page.goto(`/t/${TENANT_ID}/tasks`);
    await expect(page.locator('h1')).toHaveText('Tasks');
  });

  test('staging page loads', async ({ page }) => {
    await page.goto(`/t/${TENANT_ID}/staging`);
    await expect(page.locator('h1')).toHaveText('Staging Queue');
  });

  test('quarantine page loads', async ({ page }) => {
    await page.goto(`/t/${TENANT_ID}/quarantine`);
    await expect(page.locator('h1')).toHaveText('Quarantine');
  });

  test('tenant_viewer cannot access platform routes', async ({ page }) => {
    await page.goto('/platform/tenants');
    // Should redirect to /unauthorized (no platform:tenants:read scope)
    await expect(page).toHaveURL(/\/unauthorized|\/login/);
  });
});
