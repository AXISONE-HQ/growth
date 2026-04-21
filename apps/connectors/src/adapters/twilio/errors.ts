/**
 * Twilio error taxonomy — maps provider error codes to transient/permanent
 * classification so the retry policy can act correctly.
 *
 * Reference: https://www.twilio.com/docs/api/errors
 * KAN-498, KAN-584
 */

import type { ErrorClass } from '@growth/connector-contracts';

/** Side-effect classes — tell upstream what to do with the contact. */
export type SideEffect =
  | 'suppress_contact' // Permanent: contact unreachable or opted-out
  | 'flag_in_audit' // Carrier filter / spam — not contact's fault, but track
  | 'alert_oncall' // Our auth broke — urgent
  | 'none';

export interface TwilioErrorClassification {
  errorClass: ErrorClass;
  sideEffect: SideEffect;
  description: string;
}

/**
 * Known Twilio error codes. Unknown codes default to transient with
 * a log warning so we learn about them in ops and add them here.
 */
const TWILIO_ERROR_MAP: Record<number, TwilioErrorClassification> = {
  // ── 1xxxx — API / auth issues ───────────────────────────
  20003: { errorClass: 'permanent', sideEffect: 'alert_oncall', description: 'Authentication failed' },
  20404: { errorClass: 'permanent', sideEffect: 'alert_oncall', description: 'Resource not found (check subaccount SID)' },
  20429: { errorClass: 'transient', sideEffect: 'none', description: 'Too many requests — rate limited' },

  // ── 21xxx — Request validation ───────────────────────────
  21211: { errorClass: 'permanent', sideEffect: 'suppress_contact', description: 'Invalid To phone number' },
  21212: { errorClass: 'permanent', sideEffect: 'alert_oncall', description: 'Invalid From phone number (our number)' },
  21408: { errorClass: 'permanent', sideEffect: 'alert_oncall', description: 'Permission to send SMS not enabled for region' },
  21610: { errorClass: 'permanent', sideEffect: 'suppress_contact', description: 'Attempt to send to opt-out number' },
  21611: { errorClass: 'permanent', sideEffect: 'none', description: 'Queue overflow (backlog full)' },
  21614: { errorClass: 'permanent', sideEffect: 'suppress_contact', description: "'To' number is not a valid mobile number" },

  // ── 30xxx — Delivery failures ────────────────────────────
  30003: { errorClass: 'permanent', sideEffect: 'suppress_contact', description: 'Unreachable destination handset' },
  30004: { errorClass: 'permanent', sideEffect: 'suppress_contact', description: 'Message blocked (user-initiated block)' },
  30005: { errorClass: 'permanent', sideEffect: 'suppress_contact', description: 'Unknown destination handset' },
  30006: { errorClass: 'permanent', sideEffect: 'suppress_contact', description: 'Landline or unreachable carrier' },
  30007: { errorClass: 'permanent', sideEffect: 'flag_in_audit', description: 'Carrier violation — message filtered' },
  30008: { errorClass: 'transient', sideEffect: 'none', description: 'Unknown error (retry)' },
};

/** Safe default for unmapped codes — transient so we retry once, and log. */
const UNKNOWN_CLASSIFICATION: TwilioErrorClassification = {
  errorClass: 'transient',
  sideEffect: 'none',
  description: 'Unknown Twilio error code',
};

export function classifyTwilioError(code: number | undefined, status?: number): TwilioErrorClassification {
  if (code && TWILIO_ERROR_MAP[code]) {
    return TWILIO_ERROR_MAP[code];
  }
  // Fallback by HTTP status class
  if (status) {
    if (status >= 500) {
      return { errorClass: 'transient', sideEffect: 'none', description: `Twilio ${status}` };
    }
    if (status === 401 || status === 403) {
      return { errorClass: 'permanent', sideEffect: 'alert_oncall', description: `Twilio ${status} auth failure` };
    }
  }
  return UNKNOWN_CLASSIFICATION;
}
