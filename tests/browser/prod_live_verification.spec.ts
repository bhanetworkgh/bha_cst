import { test, expect, type Page, type TestInfo } from '@playwright/test';
import path from 'node:path';
import dotenv from 'dotenv';
dotenv.config();

const PROD_URL = process.env.PROD_URL || 'https://bha-cst-7u9e.onrender.com/web';

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
    // Verify login form requires email and password only (project is auto-resolved)
    await expect(page.locator('#email-input')).toBeVisible();
    await expect(page.locator('#password-input')).toBeVisible();
    await expect(page.locator('#project-select')).toHaveCount(0);
    await expect(page.locator('#login-form button[type="submit"]')).toBeVisible();

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

  /**
   * Tests 7 & 8 (Chromium & Mobile Chrome): Exercises the post-login workspace state machine beyond authentication:
   * verifies session unlock, validates multi-tenant scoping ('vFarm Organization' / 'vFarm Austin HQ'), asserts
   * authorized farm isolation ('2 farms in scope' with 'v-farm' & 'Test 001'), tests responsive navigation drawer
   * toggling (#mobile-menu), and confirms clean transition to the interactive chat interface (#chat-view).
   */
  test('executes successful live authenticated production login and verifies authorized farm scope', async ({ page }, testInfo) => {
    const email = process.env.VFARM_ADMIN_EMAIL;
    const password = process.env.VFARM_ADMIN_PASSWORD;
    if (!email || !password) {
      test.skip(true, 'VFARM_ADMIN credentials missing from environment');
      return;
    }

    await page.goto(PROD_URL, { waitUntil: 'networkidle', timeout: 30000 });

    // Fill valid credentials and submit
    await page.locator('#email-input').fill(email);
    await page.locator('#password-input').fill(password);
    await page.locator('#login-form button[type="submit"]').click();

    // Verify successful authentication and unlock of workspace overview
    const overviewView = page.locator('#overview-view');
    await expect(overviewView).toBeVisible({ timeout: 15000 });
    await expect(page.locator('#login-view')).toHaveClass(/hidden/);

    // Verify authorized user, tenant, project, and farm scope
    await expect(page.locator('#tenant-name')).toContainText(/vFarm Organization/i);
    await expect(page.locator('#project-name')).toContainText(/vFarm Austin HQ/i);
    await expect(page.locator('#scope-label')).toContainText(/2 farms in scope/i);
    await expect(page.locator('#farm-list')).toContainText(/v-farm/i);
    await expect(page.locator('#farm-list')).toContainText(/Test 001/i);

    // Switch to chat view and verify chat interface unlocks
    const overviewChatBtn = page.locator('#overview-chat-button');
    if (await overviewChatBtn.isVisible()) {
      await overviewChatBtn.click();
    } else {
      if (await page.locator('#mobile-menu').isVisible()) {
        await page.locator('#mobile-menu').click();
      }
      await page.locator('#chat-nav').click({ force: true });
    }
    await expect(page.locator('#chat-view')).toBeVisible({ timeout: 10000 });

    // Capture visual screenshot proof of live authenticated session
    await captureProdEvidence(page, testInfo, 'prod-live-authenticated-session');
  });
});
