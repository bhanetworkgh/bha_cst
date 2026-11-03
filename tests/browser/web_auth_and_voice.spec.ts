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

test.describe('CST Web UI — Authentication, Farm Linking & ElevenLabs Voice', () => {
  test('displays login form with email, password, and project selection', async ({ page }, testInfo) => {
    await page.route('**/api/v1/web/session', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'INVALID_SESSION' }) });
      } else {
        await route.continue();
      }
    });
    await page.route('**/api/v1/web/projects', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{ project_id: 'proj-vfarm-main', name: 'vFarm Austin Alpha' }]),
      });
    });

    await page.goto('/');

    await expect(page.locator('#login-view')).not.toHaveClass(/hidden/);
    await expect(page.locator('#email-input')).toBeVisible();
    await expect(page.locator('#password-input')).toBeVisible();
    await expect(page.locator('#project-select')).toBeVisible();
    await expect(page.locator('#login-form button[type="submit"]')).toContainText('Open workspace');

    await captureEvidence(page, testInfo, 'ui-login-form-view');
  });

  test('displays error message when credentials fail or user not found in vFarm', async ({ page }, testInfo) => {
    await page.route('**/api/v1/web/session', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'INVALID_SESSION' }) });
      } else if (route.request().method() === 'POST') {
        await route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({
            error: 'UNAUTHORIZED',
            message: 'User not found in vFarm or invalid credentials. Please check your credentials.',
          }),
        });
      }
    });

    await page.goto('/');

    await page.locator('#email-input').fill('unknown@vfarm.co');
    await page.locator('#password-input').fill('badpassword');
    await page.locator('#login-form button[type="submit"]').click();

    const loginError = page.locator('#login-error');
    await expect(loginError).toBeVisible();
    await expect(loginError).toHaveText('User not found in vFarm or invalid credentials. Please check your credentials.');
    await expect(page.locator('#login-view')).not.toHaveClass(/hidden/);
    await expect(page.locator('#chat-view')).toHaveClass(/hidden/);

    await captureEvidence(page, testInfo, 'ui-login-error-displayed');
  });

  test('logs in on vFarm match, connects related farms, and permits chat with farm info', async ({ page }, testInfo) => {
    let sessionActive = false;

    await page.route('**/api/v1/web/session', async (route) => {
      if (route.request().method() === 'GET') {
        if (sessionActive) {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              session: 'web_session_grower_alice',
              user: { name: 'Grower Alice', role: 'owner' },
              tenant: { id: 'tenant-vfarm-01', name: 'vFarm Global' },
              project: { id: 'proj-vfarm-main', name: 'vFarm Austin Alpha' },
              farm_count: 2,
              farms: ['farm-alpha-gh', 'farm-beta-tun'],
              farm_details: [
                { farm_id: 'farm-alpha-gh', farm_name: 'Alpha Greenhouse', farm_code: 'alpha-01', role: 'owner' },
                { farm_id: 'farm-beta-tun', farm_name: 'Beta Tunnel', farm_code: 'beta-02', role: 'admin' },
              ],
            }),
          });
        } else {
          await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'INVALID_SESSION' }) });
        }
      } else if (route.request().method() === 'POST') {
        sessionActive = true;
        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({
            session: 'web_session_grower_alice',
            user: { name: 'Grower Alice', role: 'owner' },
            tenant: { id: 'tenant-vfarm-01', name: 'vFarm Global' },
            project: { id: 'proj-vfarm-main', name: 'vFarm Austin Alpha' },
            farm_count: 2,
            farms: ['farm-alpha-gh', 'farm-beta-tun'],
            farm_details: [
              { farm_id: 'farm-alpha-gh', farm_name: 'Alpha Greenhouse', farm_code: 'alpha-01', role: 'owner' },
              { farm_id: 'farm-beta-tun', farm_name: 'Beta Tunnel', farm_code: 'beta-02', role: 'admin' },
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
          reply_text: 'Farm Alpha Greenhouse: Telemetry normal. Temperature is 22.4°C and humidity is 65%.',
          channel: 'web',
          tenant_id: 'tenant-vfarm-01',
          project_id: 'proj-vfarm-main',
          audio_url: '/api/v1/voice/audio/mock-voice-audio-123',
        }),
      });
    });

    await page.goto('/');

    // 1. Submit valid credentials
    await page.locator('#email-input').fill('alice@vfarm.co');
    await page.locator('#password-input').fill('FarmSecret@2026');
    await page.locator('#login-form button[type="submit"]').click();

    // 2. Overview pane appears with connected farms
    await expect(page.locator('#chat-view')).not.toHaveClass(/hidden/);
    await expect(page.locator('#user-name')).toHaveText('Grower Alice');
    await expect(page.locator('#user-role')).toHaveText('owner');
    await expect(page.locator('#farm-count')).toHaveText('2');
    await expect(page.locator('#scope-label')).toHaveText('2 farms in scope');

    const farmList = page.locator('#farm-list');
    await expect(farmList).toContainText('Alpha Greenhouse');
    await expect(farmList).toContainText('Beta Tunnel');

    await captureEvidence(page, testInfo, 'ui-overview-connected-farms');

    // 3. Navigate to chat
    if (testInfo.project.name === 'mobile-chrome') await page.click('#mobile-menu');
    await page.click('#chat-nav');
    await expect(page.locator('#chat-view-panel')).not.toHaveClass(/hidden/);

    // 4. Verify voice toggle and mic button are visible
    await expect(page.locator('#auto-play-voice')).toBeVisible();
    await expect(page.locator('#mic-button')).toBeVisible();

    // 5. Send farm status query
    const input = page.locator('#message-input');
    await input.fill('What is the status of Alpha Greenhouse?');
    await page.click('form#message-form button[type="submit"]');

    // 6. Verify assistant response with farm telemetry
    const messageList = page.locator('#message-list');
    await expect(messageList.locator('.message.assistant')).toHaveCount(2); // greeting + response
    await expect(messageList).toContainText('Farm Alpha Greenhouse: Telemetry normal.');

    // 7. Verify "Listen" button on assistant reply
    const listenButton = messageList.locator('.message.assistant .voice-button').last();
    await expect(listenButton).toBeVisible();
    await expect(listenButton).toContainText('Listen');

    await captureEvidence(page, testInfo, 'ui-chat-farm-status-and-voice');
  });

  test('ElevenLabs voice synthesis and audio playback interaction', async ({ page }, testInfo) => {
    await page.route('**/api/v1/web/session', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          tenant: { name: 'vFarm Global' },
          project: { name: 'vFarm Austin Alpha' },
          user: { name: 'Farmer Bob', role: 'owner' },
          farm_count: 1,
          farms: ['farm-alpha'],
          farm_details: [{ farm_id: 'farm-alpha', farm_name: 'Main Farm' }],
        }),
      });
    });

    await page.route('**/api/v1/web/history', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ messages: [] }) });
    });

    let spokeText = '';
    await page.route('**/api/v1/web/speak', async (route) => {
      const data = JSON.parse(route.request().postData() || '{}');
      spokeText = data.text;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          audio_id: 'synth-audio-bob-01',
          audio_url: '/api/v1/voice/audio/synth-audio-bob-01',
          mime_type: 'audio/mpeg',
          voice_id: 'Hmy97GCI840wuICQesiM',
        }),
      });
    });

    await page.goto('/');
    if (testInfo.project.name === 'mobile-chrome') await page.click('#mobile-menu');
    await page.click('#chat-nav');

    // The greeting message is present
    const greetingMsg = page.locator('#message-list .message.assistant').first();
    const listenButton = greetingMsg.locator('.voice-button');
    await expect(listenButton).toBeVisible();

    // Click listen button to trigger ElevenLabs synthesis
    await listenButton.click();

    // Expect the synthesis endpoint to have been called with greeting text
    expect(spokeText).toContain('Ask me about the farms in your project scope');

    await captureEvidence(page, testInfo, 'ui-elevenlabs-voice-playback');
  });
});
