/**
 * Canonical SMS Consent Wording & Version
 *
 * This is the single source of truth for the CST SMS consent text shown to
 * customers during onboarding and recorded atomically with their opt-in.
 *
 * Do NOT invent alternate wording in UI layers or future surfaces (Early Access,
 * kiosk, app). All opt-in surfaces must call `getConsentWording()` and
 * `CONSENT_WORDING_VERSION` from this module so the recorded `wording_snapshot`
 * is always provably identical to what was displayed.
 *
 * The wording explicitly names the four legal bases for CST SMS communication:
 *   - Customer service (1:1 support)
 *   - vFarm monitoring (operational alerts)
 *   - Account verification (security-related identity confirmations)
 *   - Subscription/appointment confirmations (service lifecycle)
 */

export const CONSENT_WORDING_VERSION = 'cst_sms_consent_v1' as const;

export const CONSENT_WORDING_TEXT =
  'I agree to receive text messages from Customer Service Twin for vFarm monitoring, account verification, subscription and appointment confirmations, and 1:1 support.';

export interface ConsentWording {
  version: typeof CONSENT_WORDING_VERSION;
  text: string;
}

/**
 * Returns the canonical consent wording object.
 * Every UI surface and API endpoint that displays or records consent must
 * call this function rather than inlining its own copy of the text.
 */
export function getConsentWording(): ConsentWording {
  return {
    version: CONSENT_WORDING_VERSION,
    text: CONSENT_WORDING_TEXT,
  };
}

/**
 * Recognized STOP / opt-out keywords.
 * Per Twilio's required keyword set (STOP, STOPALL, UNSUBSCRIBE, QUIT).
 * This is intentionally minimal — do NOT expand beyond the canonical
 * carrier-required set unless product and legal explicitly approve.
 */
export const STOP_KEYWORDS: ReadonlySet<string> = new Set([
  'stop',
  'stopall',
  'unsubscribe',
  'quit',
  'end',
  'cancel',
]);

/**
 * Returns true if the inbound message body contains a known opt-out keyword.
 * Comparison is case-insensitive and uses word-boundary matching so that
 * "please stop" and "I want to unsubscribe" are correctly detected, while
 * "stopped" (where "stop" is part of a longer word) is NOT treated as STOP.
 * This matches Twilio's carrier-level keyword detection: the keyword must
 * appear as a standalone word token.
 */
export function isOptOutMessage(body: string): boolean {
  const normalized = (body || '').trim().toLowerCase();
  if (!normalized) return false;

  // Exact match first (fastest path for the common case)
  if (STOP_KEYWORDS.has(normalized)) return true;

  // Word-boundary match for keywords embedded in longer messages.
  for (const kw of STOP_KEYWORDS) {
    if (new RegExp(`\\b${kw}\\b`).test(normalized)) return true;
  }

  return false;
}

export const CONSENT_AFFIRMATIVE_KEYWORDS: ReadonlySet<string> = new Set([
  'yes',
  'i agree',
  'iagree',
]);

/**
 * Returns true if the inbound message body is an affirmative consent response.
 * Supports only a narrowly defined set (YES, I AGREE) and requires exact match
 * (case-insensitive, trimmed). This prevents accidental consent when a user
 * sends "yes please" or other messages.
 */
export function isConsentResponse(body: string): boolean {
  const normalized = (body || '').trim().toLowerCase();
  if (!normalized) return false;
  return CONSENT_AFFIRMATIVE_KEYWORDS.has(normalized);
}
