/**
 * SendGrid error taxonomy — maps API + SMTP errors to transient/permanent
 * classification so the retry policy can act correctly.
 *
 * Reference: https://docs.sendgrid.com/for-developers/sending-email/error-codes
 */

import type { ErrorClass } from '@growth/connector-contracts';

export type SendGridSideEffect =
  | 'suppress_contact' // hard bounce, spam complaint — don't send again
  | 'flag_in_audit' // content filter — track but not the user's fault
  | 'alert_oncall' // auth or infra problem
  | 'transient_retry' // soft bounce, deferred — retry later
  | 'none';

export interface SendGridErrorClassification {
  errorClass: ErrorClass;
  sideEffect: SendGridSideEffect;
  description: string;
}

/**
 * Classify a SendGrid API response or event.
 * API errors: HTTP status + body.errors[0].message
 * Event errors: `type` field on event ("bounce", "dropped", etc.) + `reason`
 */
export function classifySendGridStatus(status?: number): SendGridErrorClassification {
  if (!status) return UNKNOWN;

  if (status >= 500) {
    return { errorClass: 'transient', sideEffect: 'none', description: `SendGrid ${status}` };
  }

  switch (status) {
    case 400:
      return {
        errorClass: 'permanent',
        sideEffect: 'flag_in_audit',
        description: 'Bad request — malformed payload',
      };
    case 401:
    case 403:
      return {
        errorClass: 'permanent',
        sideEffect: 'alert_oncall',
        description: `Auth failure ${status}`,
      };
    case 413:
      return {
        errorClass: 'permanent',
        sideEffect: 'flag_in_audit',
        description: 'Payload too large',
      };
    case 429:
      return { errorClass: 'transient', sideEffect: 'none', description: 'Rate limited' };
    default:
      return { errorClass: 'transient', sideEffect: 'none', description: `HTTP ${status}` };
  }
}

/**
 * Classify an event from the SendGrid Event Webhook.
 * event.type: processed | deferred | delivered | open | click | bounce | dropped | spamreport | unsubscribe | group_unsubscribe | group_resubscribe
 */
export interface SendGridEvent {
  event: string;
  reason?: string;
  status?: string; // SMTP status like "5.7.1"
  type?: string; // "bounce" sub-type: "bounce" | "blocked"
}

export function classifySendGridEvent(e: SendGridEvent): SendGridErrorClassification {
  switch (e.event) {
    case 'delivered':
    case 'open':
    case 'click':
    case 'processed':
      return { errorClass: 'transient', sideEffect: 'none', description: 'Event — no action' };

    case 'deferred':
      return {
        errorClass: 'transient',
        sideEffect: 'transient_retry',
        description: e.reason ?? 'Deferred by receiving server',
      };

    case 'bounce': {
      // Hard bounce (permanent) vs soft bounce (temporary)
      const isHard = e.type === 'bounce' && (e.status?.startsWith('5.') ?? true);
      return {
        errorClass: isHard ? 'permanent' : 'transient',
        sideEffect: isHard ? 'suppress_contact' : 'transient_retry',
        description: e.reason ?? `Bounce (${e.type ?? 'unknown'})`,
      };
    }

    case 'dropped':
      return {
        errorClass: 'permanent',
        sideEffect: 'suppress_contact',
        description: `Dropped: ${e.reason ?? 'suppressed'}`,
      };

    case 'spamreport':
      return {
        errorClass: 'permanent',
        sideEffect: 'suppress_contact',
        description: 'Spam complaint',
      };

    case 'unsubscribe':
    case 'group_unsubscribe':
      return {
        errorClass: 'permanent',
        sideEffect: 'suppress_contact',
        description: 'Recipient unsubscribed',
      };

    case 'group_resubscribe':
      return { errorClass: 'transient', sideEffect: 'none', description: 'Re-subscribed' };

    default:
      return UNKNOWN;
  }
}

const UNKNOWN: SendGridErrorClassification = {
  errorClass: 'transient',
  sideEffect: 'none',
  description: 'Unknown SendGrid event/status',
};
