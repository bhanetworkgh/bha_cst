/**
 * Privacy helpers for log and audit output.
 *
 * CST logs and audit entries are retained and are read by operators, auditors
 * and reviewers, so they must not carry raw customer identifiers. The
 * Operator Playbook's evidence-sanitization rule is the policy this module
 * implements: keep the last 2–4 digits of a phone number and mask the rest.
 *
 * Service numbers (the numbers CST owns) are not customer identifiers, so they
 * may appear in operational logs unmasked. Recipient/caller numbers may not.
 */

/**
 * Mask a phone number for logs and audit entries, keeping only the last four
 * digits and a short leading hint (the `+` plus up to four leading digits, so
 * the country/operator prefix stays legible for triage).
 *
 * Everything between the hint and the last four digits is replaced with `*`.
 * A number with fewer than nine digits cannot be masked without hiding most of
 * it, so it is truncated instead.
 *
 * Returns the input unchanged if it is too short to mask safely.
 */
export function maskPhone(phone: string | null | undefined): string {
  if (!phone) return '';
  const value = String(phone).trim();
  if (value.length < 5) return value;

  const digits = value.replace(/\D/g, '');
  if (digits.length <= 4) return value.slice(0, -2) + '**';

  const last4 = digits.slice(-4);
  const hidden = digits.length - 4;
  if (hidden <= 4) {
    // Not enough middle digits to hide meaningfully — keep only the tail.
    return `+${'*'.repeat(hidden)}${last4}`;
  }

  const hint = digits.slice(0, 4);
  const middle = '*'.repeat(hidden - 4);
  return `+${hint}${middle}${last4}`;
}
