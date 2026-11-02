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

test.describe('CST web chat — pending-feedback UX', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    await page.route('**/api/v1/web/session', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          tenant: { name: 'vFarm' },
          project: { name: 'Main Operations' },
          user: { name: 'Test Owner', role: 'owner' },
          farm_count: 1,
          farms: ['farm-test'],
        }),
      });
    });
    await page.route('**/api/v1/web/history', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ messages: [] }) });
    });
    await page.route('**/api/v1/web/message', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ reply_text: 'Farm status is available from vFarm.' }),
      });
    });
    // The mocked existing session initializes the workspace. Wait for that
    // navigation to settle before entering Support desk; a second manual login
    // would race this initialization and navigate back to Overview.
    await page.goto('/');
    await expect(page.locator('#chat-view')).not.toHaveClass(/hidden/);
    await expect(page.locator('#page-title')).toHaveText('Project overview');
    if (testInfo.project.name === 'mobile-chrome') await page.click('#mobile-menu');
    await page.click('#chat-nav');
    await expect(page.locator('#chat-view-panel')).not.toHaveClass(/hidden/);
  });

  test('successful text message: user message renders immediately, pending shows, assistant reply replaces pending', async ({ page }, testInfo) => {
    let releaseResponse!: () => void;
    const responseGate = new Promise<void>((resolve) => { releaseResponse = resolve; });
    await page.route('**/api/v1/web/message', async (route) => {
      await responseGate;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ reply_text: 'Farm status is available from vFarm.' }),
      });
    });
    const messageList = page.locator('#message-list');
    const typingState = page.locator('#typing-state');
    const sendButton = page.locator('#send-button');
    const input = page.locator('#message-input');

    await input.fill('What is the status of my farm?');
    await page.click('form#message-form button[type="submit"]');

    // 1. User message appears immediately.
    await expect(messageList.locator('.message.user')).toHaveCount(1);
    await expect(messageList.locator('.message.user .message-bubble')).toContainText('What is the status of my farm?');

    // 2. Pending indicator and disabled composer while request runs.
    await expect(typingState).not.toHaveClass(/hidden/);
    await expect(sendButton).toBeDisabled();
    await expect(input).toBeDisabled();
    await expect(typingState).toContainText('Message accepted. CST is processing your request.');
    await captureEvidence(page, testInfo, 'text-pending-processing');

    const respondingSeen = page.waitForFunction(
      () =>
        document.querySelector('#message-status')?.textContent === 'CST is responding.' ||
        document.querySelector('#message-status')?.textContent === 'Response delivered.',
      undefined,
      { polling: 'raf', timeout: 10000 },
    );
    releaseResponse();
    await respondingSeen;

    // Wait for the assistant response (mocked endpoint responds on the test gate).
    await expect(messageList.locator('.message.assistant')).toHaveCount(2, { timeout: 10000 });

    // 3. Pending cleared after response.
    await expect(typingState).toHaveClass(/hidden/);
    await expect(sendButton).toBeEnabled();
    await expect(input).toBeEnabled();
    await expect(page.locator('#message-status')).toHaveText('Response delivered.');
    await captureEvidence(page, testInfo, 'text-response-delivered');
  });

  test('composer disabled during request prevents duplicate submissions', async ({ page }) => {
    const sendButton = page.locator('#send-button');
    const input = page.locator('#message-input');
    const messageList = page.locator('#message-list');

    await input.fill('Duplicate test');
    await page.click('form#message-form button[type="submit"]');

    await expect(sendButton).toBeDisabled();
    await expect(input).toBeDisabled();

    // Attempt second submission — disabled button cannot be clicked.
    await expect(sendButton).toBeDisabled();

    await expect(messageList.locator('.message.assistant')).toHaveCount(2, { timeout: 10000 });

    // After response, composer is re-enabled.
    await expect(sendButton).toBeEnabled();
    await expect(input).toBeEnabled();
    await expect(messageList.locator('.message.user')).toHaveCount(1);
  });

  test('server error renders error message and restores composer', async ({ page }, testInfo) => {
    // Intercept the message API to return a 500 error.
    await page.route('/api/v1/web/message', (route) => {
      route.fulfill({ status: 500, body: JSON.stringify({ error: 'SERVER_ERROR', message: 'Upstream failure' }) });
    });

    const messageList = page.locator('#message-list');
    const sendButton = page.locator('#send-button');
    const input = page.locator('#message-input');

    await input.fill('Error test');
    await page.click('form#message-form button[type="submit"]');

    await expect(sendButton).toBeDisabled();

    // Error message should render.
    await expect(messageList.locator('.message-error')).toHaveCount(1, { timeout: 10000 });
    await expect(messageList.locator('.message-error .message-bubble')).toContainText("We couldn't complete that request");

    // Composer restored.
    await expect(sendButton).toBeEnabled();
    await expect(input).toBeEnabled();
    await expect(page.locator('#typing-state')).toHaveClass(/hidden/);
    await expect(page.locator('#message-status')).toContainText('response could not be delivered');
    await captureEvidence(page, testInfo, 'text-response-error');
  });

  test('timeout renders an explicit failure and restores the message for retry', async ({ page }, testInfo) => {
    await page.clock.install();
    await page.route('**/api/v1/web/message', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ reply_text: 'Late response must not replace the timeout.' }),
      });
    });

    await page.locator('#message-input').fill('Timeout test');
    await page.click('form#message-form button[type="submit"]');
    await expect(page.locator('#send-button')).toBeDisabled();
    await page.clock.fastForward(30000);

    await expect(page.locator('.message-error')).toHaveCount(1);
    await expect(page.locator('.message-error')).toContainText('The request timed out');
    await expect(page.locator('#message-input')).toHaveValue('Timeout test');
    await expect(page.locator('#message-input')).toBeEnabled();
    await expect(page.locator('#typing-state')).toHaveClass(/hidden/);
    await captureEvidence(page, testInfo, 'text-response-timeout');
  });

  test('network interruption is explicit and a manual retry preserves conversation order', async ({ page }, testInfo) => {
    let attempts = 0;
    await page.route('**/api/v1/web/message', async (route) => {
      attempts++;
      if (attempts === 1) {
        await route.abort('internetdisconnected');
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ reply_text: 'Retry succeeded.' }),
      });
    });

    await page.locator('#message-input').fill('Retry after interruption');
    await page.click('form#message-form button[type="submit"]');
    await expect(page.locator('.message-error')).toHaveCount(1);
    await expect(page.locator('#message-input')).toHaveValue('Retry after interruption');
    await expect(page.locator('#message-input')).toBeEnabled();
    await captureEvidence(page, testInfo, 'text-network-interruption');

    await page.click('form#message-form button[type="submit"]');
    await expect(page.locator('.message.user')).toHaveCount(2);
    await expect(page.locator('.message.assistant .message-bubble').last()).toHaveText('Retry succeeded.');
    await expect(page.locator('#message-status')).toHaveText('Response delivered.');
    expect(attempts).toBe(2);
    const messages = await page.locator('#message-list > .message').allTextContents();
    expect(messages.findIndex((text) => text.includes('Retry after interruption'))).toBeLessThan(
      messages.findIndex((text) => text.includes('Retry succeeded.')),
    );
    await captureEvidence(page, testInfo, 'text-retry-delivered');
  });

  test('accessibility: pending state announces via ARIA live region', async ({ page }) => {
    const typingState = page.locator('#typing-state');
    const sendButton = page.locator('#send-button');

    await page.locator('#message-input').fill('A11y test');
    await page.click('form#message-form button[type="submit"]');

    // Typing state is a live status region.
    await expect(typingState).toHaveAttribute('aria-live', 'assertive');
    await expect(typingState).toHaveAttribute('aria-atomic', 'true');
    await expect(typingState).not.toHaveClass(/hidden/);
    await expect(sendButton).toHaveAttribute('aria-disabled', 'true');

    await expect(page.locator('.message.assistant')).toHaveCount(2, { timeout: 10000 });
    await expect(typingState).toHaveClass(/hidden/);
    await expect(sendButton).toHaveAttribute('aria-disabled', 'false');
  });

  test('mobile viewport: chat composer remains usable', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.locator('#message-input').fill('Mobile test');
    await page.click('form#message-form button[type="submit"]');

    await expect(page.locator('.message.user')).toHaveCount(1);
    await expect(page.locator('#typing-state')).not.toHaveClass(/hidden/);
    await expect(page.locator('#send-button')).toBeDisabled();

    await expect(page.locator('.message.assistant')).toHaveCount(2, { timeout: 10000 });
    await expect(page.locator('#typing-state')).toHaveClass(/hidden/);
    await expect(page.locator('#send-button')).toBeEnabled();
  });
});
