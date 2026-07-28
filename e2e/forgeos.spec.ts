import { expect, test } from '@playwright/test';

/**
 * End-to-end coverage of the paths a first-time user actually takes.
 *
 * These run against a real build with an empty environment — no database, no
 * API key — which is precisely the configuration the project promises works.
 */
test.describe('ForgeOS', () => {
  test('the landing page explains the product and links into the app', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('one workspace');
    await expect(page.getByRole('link', { name: 'Open the app' }).first()).toBeVisible();
  });

  test('the health endpoint reports the active subsystems', async ({ request }) => {
    const response = await request.get('/api/system/health');
    expect(response.ok()).toBeTruthy();

    const body = (await response.json()) as {
      status: string;
      defaultModel: string;
      storage: string;
    };
    expect(body.status).toBe('ok');
    // With no configuration the local provider must be the default: the product
    // must never reach for a paid model unless one was configured.
    expect(body.defaultModel).toBe('forge-local');
    expect(body.storage).toBeTruthy();
  });

  test('a fresh workspace is seeded with the sample repository', async ({ page }) => {
    await page.goto('/repositories');
    await expect(page.getByText('Sample: orders-service')).toBeVisible();
  });

  test('analysing the sample produces real metrics', async ({ page }) => {
    await page.goto('/repositories');
    await page.getByRole('button', { name: /Analyse|Re-analyse/ }).first().click();

    // The analysis renders derived facts, not placeholders.
    await expect(page.getByText(/\d+ modules/)).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(/LOC/).first()).toBeVisible();
  });

  test('the repository detail page shows hotspots and findings', async ({ page }) => {
    await page.goto('/repositories');
    await page.getByRole('link', { name: 'Sample: orders-service' }).click();

    await expect(page.getByRole('heading', { name: /orders-service/ })).toBeVisible();
    await expect(page.getByText('Highest-risk modules')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('Technical debt')).toBeVisible();
  });

  test('the command palette opens, searches and navigates', async ({ page }) => {
    await page.goto('/dashboard');
    await page.getByRole('button', { name: 'Open the command palette' }).click();

    const dialog = page.getByRole('dialog', { name: 'Command palette' });
    await expect(dialog).toBeVisible();

    await page.getByRole('textbox', { name: 'Search' }).fill('security');
    await expect(dialog.getByText('Security').first()).toBeVisible();

    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/security/);
  });

  test('the security module scans and reports a posture', async ({ page }) => {
    await page.goto('/security');
    await page.getByRole('button', { name: 'Run security scan' }).click();

    await expect(page.getByText(/Posture|posture/).first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('Advisory sources consulted')).toBeVisible();
  });

  test('the assistant answers from workspace context', async ({ page }) => {
    await page.goto('/dashboard');
    await page.getByRole('button', { name: /Open the assistant/ }).click();

    const panel = page.getByRole('complementary', { name: 'ForgeOS assistant' });
    await expect(panel).toBeVisible();

    await panel.getByRole('textbox', { name: 'Message' }).fill('list repositories');
    await panel.getByRole('button').last().click();

    // The answer must arrive and must not be an error.
    await expect(panel.getByText(/orders-service|repositor/i).first()).toBeVisible({
      timeout: 60_000,
    });
  });

  test('every module route renders without an error boundary', async ({ page }) => {
    const routes = [
      '/dashboard',
      '/repositories',
      '/architecture',
      '/documentation',
      '/apis',
      '/workflows',
      '/evaluation',
      '/security',
      '/automation',
      '/memory',
      '/settings',
    ];

    for (const route of routes) {
      const response = await page.goto(route);
      expect(response?.status(), `${route} should respond 200`).toBe(200);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(page.getByText('Application error')).toHaveCount(0);
    }
  });

  test('the interface is navigable by keyboard and exposes a skip link', async ({ page }) => {
    await page.goto('/dashboard');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
  });

  test('dark and light themes both apply', async ({ page }) => {
    await page.goto('/dashboard');
    const toggle = page.getByRole('button', { name: /Switch theme/ });

    await toggle.click();
    const first = await page.locator('html').getAttribute('data-theme');
    await toggle.click();
    const second = await page.locator('html').getAttribute('data-theme');

    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(first).not.toBe(second);
  });
});
