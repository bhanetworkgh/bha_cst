import { test, expect, type Page, type TestInfo } from '@playwright/test';
import path from 'node:path';

const PROD_URL = 'https://bha-cst-7u9e.onrender.com/web';

async function captureProdEvidence(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const screenshotPath = path.resolve(
    'docs/evidence/browser',
    `${name}-${testInfo.project.name}.png`
  );
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await testInfo.attach(name, { path: screenshotPath, contentType: 'image/png' });
}

test.describe('Production Live UI Acceptance Tests — Chrome Verification', () => {
  test.use({ baseURL: undefined });

  test('loads live production login view with project selector from vFarm', async ({ page }, testInfo) => {
    // Navigate directly to the live deployed URL on Render
    await page.goto(PROD_URL, { waitUntil: 'networkidle', timeout: 30000 });

    // Validate page structure
    await expect(page).toHaveTitle(/CST \| Customer Service Twin/i);
    await expect(page.locator('#login-view')).toBeVisible();
    await expect(page.locator('#email-input')).toBeVisible();
    await expect(page.locator('#password-input')).toBeVisible();
    await expect(page.locator('#project-select')).toBeVisible();

    // Verify project selector received live projects from production API
    const projectSelect = page.locator('#project-select');
    await expect(projectSelect).toHaveValue('proj-vfarm-main');
    await expect(page.locator('#project-select option').first()).toHaveText('vFarm Austin HQ');

    // Capture visual screenshot
    await captureProdEvidence(page, testInfo, 'prod-live-login-view');
  });

  test('verifies live authentication guard refuses unauthorized login with explicit error message', async ({ page }, testInfo) => {
    await page.goto(PROD_URL, { waitUntil: 'networkidle', timeout: 30000 });

    // 1. First verify submitting without credentials triggers explicit auth requirement
    await page.locator('#login-form button[type="submit"]').click();
    const loginError = page.locator('#login-error');
    await expect(loginError).toBeVisible({ timeout: 10000 });
    await expect(loginError).toContainText(/Production web access requires email and password authentication/i);

    // Capture visual screenshot of the live empty credentials refusal
    await captureProdEvidence(page, testInfo, 'prod-live-empty-creds-error');

    // 2. Next verify entering invalid credentials against production
    await page.locator('#email-input').fill('unauthorized-grower@vfarm.co');
    await page.locator('#password-input').fill('InvalidPassword999!');
    await page.locator('#login-form button[type="submit"]').click();

    // Verify either explicit vFarm refusal or strict production auth guard
    await expect(loginError).toBeVisible({ timeout: 10000 });
    await expect(loginError).toContainText(/(User not found in vFarm|Production web access requires)/i);

    // Verify chat view remains locked/hidden
    await expect(page.locator('#chat-view')).toHaveClass(/hidden/);

    // Capture visual screenshot of the live invalid credentials refusal
    await captureProdEvidence(page, testInfo, 'prod-live-auth-error');
  });

  test('verifies live UI accessibility: landmarks, ARIA labels, and form attributes', async ({ page }, testInfo) => {
    await page.goto(PROD_URL, { waitUntil: 'networkidle', timeout: 30000 });

    // Verify accessible labels and inputs
    await expect(page.locator('#email-input')).toHaveAttribute('type', 'email');
    await expect(page.locator('#password-input')).toHaveAttribute('type', 'password');
    await expect(page.locator('#login-error')).toHaveAttribute('role', 'alert');
    await expect(page.locator('main#app')).toHaveClass(/app-shell/);

    // Capture accessibility landmark view
    await captureProdEvidence(page, testInfo, 'prod-live-a11y-landmarks');
  });
});
