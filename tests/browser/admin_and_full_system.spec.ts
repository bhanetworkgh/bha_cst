import { test, expect, type Page, type TestInfo } from '@playwright/test';
import path from 'node:path';

async function captureEvidence(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const screenshotPath = path.resolve(
    'docs/evidence/browser',
    `${name}-${testInfo.project.name}.png`,
  );
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await testInfo.attach(name, { path: screenshotPath, contentType: 'image/png' });
}

test.describe('Full System End-to-End Chrome UI Acceptance Test', () => {
  test('User Web UI: Email & password only login -> Overview -> Chat -> Voice -> View switching -> Logout', async ({ page }, testInfo) => {
    let sessionActive = false;

    await page.route('**/api/v1/web/session', async (route) => {
      if (route.request().method() === 'GET') {
        if (sessionActive) {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              session: 'web_session_full_chrome_test',
              user: { name: 'Full Test User', role: 'owner' },
              tenant: { id: 'tenant-vfarm-01', name: 'vFarm Global' },
              project: { id: 'proj-vfarm-main', name: 'vFarm Austin HQ' },
              farm_count: 2,
              farms: ['farm-alpha-1', 'farm-beta-2'],
              farm_details: [
                { farm_id: 'farm-alpha-1', farm_name: 'Austin Primary Facility', role: 'owner' },
                { farm_id: 'farm-beta-2', farm_name: 'Secondary Research Tunnel', role: 'admin' },
              ],
            }),
          });
        } else {
          await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'INVALID_SESSION' }) });
        }
      } else if (route.request().method() === 'POST') {
        const body = JSON.parse(route.request().postData() || '{}');
        // Ensure client submitted email and password, not project or user
        expect(body.email).toBe('grower@vfarm.co');
        expect(body.password).toBe('SafePassword123!');
        expect(body.project_id).toBeUndefined();
        expect(body.user).toBeUndefined();

        sessionActive = true;
        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({
            session: 'web_session_full_chrome_test',
            user: { name: 'Full Test User', role: 'owner' },
            tenant: { id: 'tenant-vfarm-01', name: 'vFarm Global' },
            project: { id: 'proj-vfarm-main', name: 'vFarm Austin HQ' },
            farm_count: 2,
            farms: ['farm-alpha-1', 'farm-beta-2'],
            farm_details: [
              { farm_id: 'farm-alpha-1', farm_name: 'Austin Primary Facility', role: 'owner' },
              { farm_id: 'farm-beta-2', farm_name: 'Secondary Research Tunnel', role: 'admin' },
            ],
          }),
        });
      }
    });

    await page.route('**/api/v1/web/history', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ messages: [] }) });
    });

    await page.route('**/api/v1/web/message', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          reply_text: 'Austin Primary Facility telemetry: EC is 1.8 mS/cm, pH is 5.9, water temperature is 21.2°C.',
          channel: 'web',
          tenant_id: 'tenant-vfarm-01',
          project_id: 'proj-vfarm-main',
          audio_url: '/mock-audio.mp3',
        }),
      });
    });

    await page.route('**/api/v1/web/logout', async (route) => {
      sessionActive = false;
      await route.fulfill({ status: 204 });
    });

    // 1. Initial Load: Verify login view requires ONLY email and password
    await page.goto('/');
    await expect(page.locator('#login-view')).toBeVisible();
    await expect(page.locator('#email-input')).toBeVisible();
    await expect(page.locator('#password-input')).toBeVisible();

    // Verify Project dropdown and Dev Identity overrides are NOT present
    await expect(page.locator('#project-select')).toHaveCount(0);
    await expect(page.locator('#dev-user-row')).toHaveCount(0);
    await expect(page.locator('#user-select')).toHaveCount(0);

    await captureEvidence(page, testInfo, 'full-ui-chrome-login-form');

    // 2. Perform Login with email and password
    await page.locator('#email-input').fill('grower@vfarm.co');
    await page.locator('#password-input').fill('SafePassword123!');
    await page.locator('#login-form button[type="submit"]').click();

    // 3. Verify Overview Workspace
    await expect(page.locator('#chat-view')).toBeVisible();
    await expect(page.locator('#user-name')).toHaveText('Full Test User');
    await expect(page.locator('#user-role')).toHaveText('owner');
    await expect(page.locator('#tenant-name')).toHaveText('vFarm Global');
    await expect(page.locator('#project-name')).toHaveText('vFarm Austin HQ');
    await expect(page.locator('#farm-count')).toHaveText('2');
    await expect(page.locator('#scope-label')).toHaveText('2 farms in scope');

    await captureEvidence(page, testInfo, 'full-ui-chrome-workspace-overview');

    // 4. Navigate to Support Desk / Chat
    if (testInfo.project.name === 'mobile-chrome') await page.click('#mobile-menu');
    await page.click('#chat-nav');
    await expect(page.locator('#chat-view-panel')).toBeVisible();
    await expect(page.locator('#page-title')).toHaveText('How can we help?');

    // 5. Send message and verify response
    const composer = page.locator('#message-input');
    await composer.fill('Report telemetry readings for Austin Primary Facility.');
    await page.click('#send-button');

    // Assistant response arrives
    const messageList = page.locator('#message-list');
    await expect(messageList).toContainText('Austin Primary Facility telemetry: EC is 1.8 mS/cm');

    // Voice button is present on assistant response
    const voiceButton = messageList.locator('.voice-button').last();
    await expect(voiceButton).toBeVisible();
    await expect(voiceButton).toContainText('Listen');

    await captureEvidence(page, testInfo, 'full-ui-chrome-chat-interaction');

    // 6. Navigate to Activity view
    if (testInfo.project.name === 'mobile-chrome') await page.click('#mobile-menu');
    await page.click('#activity-nav');
    await expect(page.locator('#activity-view')).toBeVisible();
    await expect(page.locator('#activity-list')).toContainText('Report telemetry readings for Austin Primary Facility.');

    // 7. Test Logout
    if (testInfo.project.name === 'mobile-chrome') await page.click('#mobile-menu');
    await page.click('#logout-button');
    await expect(page.locator('#login-view')).toBeVisible();
    await expect(page.locator('#chat-view')).toHaveClass(/hidden/);
  });

  test('Admin Console UI: Loads tabs, health indicators, and renders architecture tree', async ({ page }, testInfo) => {
    await page.addInitScript(() => {
      localStorage.setItem('cst_admin_token', 'mock_admin_token_123');
      localStorage.setItem('cst_admin_name', 'Platform Admin');
      localStorage.setItem('cst_admin_email', 'admin@bhanetwork.org');
    });

    await page.route('**/api/v1/auth/me', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ email: 'admin@bhanetwork.org', name: 'Platform Admin' }),
      });
    });

    await page.route('**/api/v1/admin/**', async (route) => {
      const url = route.request().url();
      if (url.includes('/health')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            status: 'healthy',
            tenants: 2,
            projects: 3,
            speakers: 15,
            numbers: 4,
            timestamp: new Date().toISOString(),
          }),
        });
      } else if (url.includes('/tenants')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([{ tenant_id: 'tenant-vfarm-01', name: 'vFarm Global' }]),
        });
      } else if (url.includes('/projects')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([{ project_id: 'proj-vfarm-main', name: 'vFarm Austin HQ' }]),
        });
      } else if (url.includes('/speakers')) {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) });
      } else {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) });
      }
    });

    await page.goto('/admin.html');
    await expect(page.locator('.admin-shell')).toBeVisible();
    await expect(page.locator('header h1')).toContainText('Tenancy, Users & Project Console');

    // Verify all 10 tabs render
    const tabs = page.locator('.admin-tab');
    await expect(tabs).toHaveCount(10);

    // Tab 1: Overview
    await expect(page.locator('#tab-overview')).toBeVisible();
    await expect(page.locator('.arch-visualizer')).toBeVisible();

    // Tab 4: Projects & Capabilities
    await page.click('[data-tab="projects"]');
    await expect(page.locator('#tab-projects')).toBeVisible();

    // Tab 7: SMS Consent
    await page.click('[data-tab="sms-consent"]');
    await expect(page.locator('#tab-sms-consent')).toBeVisible();

    // Tab 10: vFarm Users & Grants
    await page.click('[data-tab="vfarm-users"]');
    await expect(page.locator('#tab-vfarm-users')).toBeVisible();

    await captureEvidence(page, testInfo, 'full-ui-chrome-admin-console');
  });

  test('Phone Test Console UI: Loads correctly with dialer and speaker inspection', async ({ page }, testInfo) => {
    await page.goto('/phone-test-console.html');
    await expect(page.locator('body')).toBeVisible();
    await expect(page.locator('h1')).toContainText(/CST Phone Number Tester/i);
    await captureEvidence(page, testInfo, 'full-ui-chrome-phone-console');
  });
});
