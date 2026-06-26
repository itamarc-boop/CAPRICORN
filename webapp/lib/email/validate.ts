/**
 * Shared email-address validation. Single source of truth so the contact
 * form, the compose panel, and the draft API routes all agree on what a
 * valid send-to address is (previously each hand-rolled its own check —
 * the contact form only tested for an "@", which let "jane@" through and
 * surfaced the failure later at send time).
 */
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** True when `value` is a syntactically valid email address. */
export function isEmail(value: string): boolean {
  return EMAIL_RE.test(value.trim());
}
