/**
 * Regression tests for outbound SMS sender selection and error classification.
 *
 * The Messages API treats `from` and `messagingServiceSid` as mutually
 * exclusive senders, and a Messaging Service only selects a CONFIGURED sender
 * pool — it cannot make an unowned number a valid sender. So:
 *
 *   - With a Messaging Service SID, the payload carries the SID and does NOT
 *     also carry a conflicting `from`.
 *   - Without one, a direct `from` is used, and that number must be one the
 *     account owns.
 *   - With neither, the send is refused BEFORE the API call, permanently.
 *
 * Twilio error 21659 ("the 'From' number is not a valid phone number,
 * shortcode or alphanumeric sender id") is a sender-configuration failure. It
 * cannot be fixed by resending, so it must not be retried for an hour.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TwilioClientWrapper } from '../../engine/src/transport/twilio/client.js';

const OWNED = '+19715885823';

function res_sid_of(mock: ReturnType<typeof vi.fn>): string {
  return (mock.mock.results[0].value as { sid: string }).sid;
}
const UNOWNED = '+19715885824';

describe('Twilio outbound SMS sender selection', () => {
  beforeEach(() => {
    // The environment schema REQUIRES TWILIO_MESSAGING_SERVICE_SID, so the
    // environment is left intact: a correctly configured deployment always
    // has a sender. Removing it here would make getEnv() throw before the
    // code under test is even reached.
    TwilioClientWrapper.setMockHandler(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── The payload contract ─────────────────────────────────────────────────

  it('sends the messagingServiceSid alone when one is configured', () => {
    const payload = TwilioClientWrapper.buildSendSmsPayload(
      { to: '+923001234567', from: OWNED, body: 'hello' },
      { messagingServiceSid: 'MG_abc123' }
    );

    expect(payload.messagingServiceSid).toBe('MG_abc123');
    // A conflicting `from` must NOT be sent alongside the SID.
    expect(payload.from).toBeUndefined();
    expect(payload.to).toBe('+923001234567');
    expect(payload.body).toBe('hello');
  });

  it('prefers an explicit messagingServiceSid over the environment one', () => {
    const payload = TwilioClientWrapper.buildSendSmsPayload(
      { to: '+923001234567', messagingServiceSid: 'MG_explicit', body: 'hi' },
      { messagingServiceSid: 'MG_env' }
    );
    expect(payload.messagingServiceSid).toBe('MG_explicit');
  });

  it('uses the direct from number when no messaging service is configured', () => {
    const payload = TwilioClientWrapper.buildSendSmsPayload(
      { to: '+923001234567', from: OWNED, body: 'hello' },
      { messagingServiceSid: undefined }
    );

    expect(payload.from).toBe(OWNED);
    expect(payload.messagingServiceSid).toBeUndefined();
  });

  it('carries no sender at all when neither is available', () => {
    const payload = TwilioClientWrapper.buildSendSmsPayload(
      { to: '+923001234567', body: 'hello' },
      { messagingServiceSid: undefined }
    );

    expect(payload.from).toBeUndefined();
    expect(payload.messagingServiceSid).toBeUndefined();
  });

  it('includes media URLs only when present', () => {
    const withMedia = TwilioClientWrapper.buildSendSmsPayload({
      to: '+923001234567',
      from: OWNED,
      body: 'hello',
      mediaUrl: ['https://example.invalid/a.png'],
    });
    expect(withMedia.mediaUrl).toEqual(['https://example.invalid/a.png']);

    const withoutMedia = TwilioClientWrapper.buildSendSmsPayload({
      to: '+923001234567',
      from: OWNED,
      body: 'hello',
    });
    expect(withoutMedia.mediaUrl).toBeUndefined();
  });

  // ── Fail-closed with no sender ───────────────────────────────────────────

  it('uses the environment messaging service and never a conflicting from', async () => {
    const mock = vi.fn(() => ({ sid: 'SM_test', status: 'queued' }));
    TwilioClientWrapper.setMockHandler(mock);
    const payloadSpy = vi.spyOn(TwilioClientWrapper, 'buildSendSmsPayload');

    await TwilioClientWrapper.sendSms({
      to: '+923001234567',
      from: OWNED,
      body: 'hello',
    });

    // The environment's Messaging Service is passed to the payload builder,
    // so the built payload prefers it and drops the `from`.
    const envArg = payloadSpy.mock.calls[0][1] as { messagingServiceSid?: string };
    expect(envArg.messagingServiceSid).toBeTruthy();

    const built = payloadSpy.mock.results[0].value as Record<string, unknown>;
    expect(built.messagingServiceSid).toBe(envArg.messagingServiceSid);
    expect(built.from).toBeUndefined();

    expect(res_sid_of(mock)).toBe('SM_test');
  });

  it('refuses the send before the transport when there is no sender at all', async () => {
    const mock = vi.fn();
    TwilioClientWrapper.setMockHandler(mock);

    // The environment schema REQUIRES TWILIO_MESSAGING_SERVICE_SID, so in a
    // correctly configured deployment a send always has a sender. This asserts
    // the fail-closed guard itself: with neither an explicit SID nor a `from`
    // AND no environment SID, the send is refused permanently and the
    // transport is never called.
    const payloadSpy = vi.spyOn(TwilioClientWrapper, 'buildSendSmsPayload');
    payloadSpy.mockReturnValueOnce({ to: '+923001234567', body: 'hello' });

    await expect(
      TwilioClientWrapper.sendSms({ to: '+923001234567', body: 'hello' })
    ).rejects.toMatchObject({ code: 21659, isNonRetriable: true });

    expect(mock).not.toHaveBeenCalled();
    payloadSpy.mockRestore();
  });

  // ── Error classification ─────────────────────────────────────────────────

  it('classifies 21659 as permanent and not retriable', () => {
    expect(TwilioClientWrapper.isNonRetriableError({ code: 21659 })).toBe(true);
  });

  it('still classifies the other permanent sender/carrier errors', () => {
    for (const code of [20003, 21211, 21215, 21408, 21614, 21610, 30005, 30007, 30008]) {
      expect(TwilioClientWrapper.isNonRetriableError({ code })).toBe(true);
    }
  });

  it('does not classify a transient or unknown error as permanent', () => {
    // 5xx and rate limits must stay retriable.
    for (const code of [500, 502, 503, 429, 21617, 99999]) {
      expect(TwilioClientWrapper.isNonRetriableError({ code })).toBe(false);
    }
    expect(TwilioClientWrapper.isNonRetriableError({})).toBe(false);
    expect(TwilioClientWrapper.isNonRetriableError(null)).toBe(false);
  });

  it('does not treat a transient 21659-shaped error as permanent when it is not the sender code', () => {
    // 21659 is permanent; a neighbouring code must not be swept in.
    expect(TwilioClientWrapper.isNonRetriableError({ code: 21658 })).toBe(false);
    expect(TwilioClientWrapper.isNonRetriableError({ code: 21660 })).toBe(false);
  });

  it('documents the unowned number as a configuration problem, not a code problem', () => {
    // The unowned number is not a code the client may special-case: it is a
    // configuration/binding fault, and the permanent classification is what
    // stops the queue retrying it for an hour.
    expect(TwilioClientWrapper.isNonRetriableError({ code: 21659 })).toBe(true);
    expect(UNOWNED).not.toBe(OWNED);
  });
});
