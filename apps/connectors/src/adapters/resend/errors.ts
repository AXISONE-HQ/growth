/**
 * Resend error taxonomy — maps API errors to transient/permanent
 * classification so the retry policy can act correctly.
 *
 * Reference: https://resend.com/docs/api-reference/errors
 *
 * Note: Resend's event-webhook classifier (delivered/bounced/opened/clicked)
 * lives in KAN-684's deferred scope alongside the webhook handler itself.
 */

import type { ErrorClass } from '@growth/connector-contracts';

export type ResendSideEffect =
  | 'suppress_contact' // hard bounce, validation failure on a real address — don't send again
  | 'flag_in_audit' // content/payload error — track but not the user's fault
  | 'alert_oncall' // auth or infra problem
  | 'transient_retry' // soft / deferred — retry later
  | 'none';

export interface ResendErrorClassification {
  errorClass: ErrorClass;
  sideEffect: ResendSideEffect;
  description: string;
}

/**
 * Classify a Resend API response.
 *
 * Resend returns `{ data, error }` from `resend.emails.send(...)`. On error,
 * `error.statusCode` carries the HTTP code and `error.message` the human-
 * readable reason. Common codes per Resend docs:
 *   400 validation_error  — payload shape wrong
 *   401 missing_api_key   — bad creds
 *   403 forbidden         — domain not verified, scope insufficient
 *   422 validation_error  — invalid recipient (treat as suppress)
 *   429 rate_limit_exceeded
 *   5xx                   — Resend-side outage
 */
export function classifyResendStatus(status?: number): ResendErrorClassification {
  if (!status) return UNKNOWN;

  if (status >= 500) {
    return { errorClass: 'transient', sideEffect: 'none', description: `Resend ${status}` };
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
    case 422:
      return {
        errorClass: 'permanent',
        sideEffect: 'suppress_contact',
        description: 'Validation error — invalid recipient',
      };
    case 429:
      return { errorClass: 'transient', sideEffect: 'none', description: 'Rate limited' };
    default:
      return { errorClass: 'transient', sideEffect: 'none', description: `HTTP ${status}` };
  }
}

const UNKNOWN: ResendErrorClassification = {
  errorClass: 'transient',
  sideEffect: 'none',
  description: 'Unknown Resend status',
};
