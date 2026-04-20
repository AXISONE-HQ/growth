/**
 * Meta Graph API error taxonomy.
 *
 * Reference: https://developers.facebook.com/docs/graph-api/guides/error-handling
 * Messenger-specific: https://developers.facebook.com/docs/messenger-platform/error-codes
 */

import type { ErrorClass } from '@growth/connector-contracts';

export type MetaSideEffect =
  | 'mark_connection_error' // token revoked / expired — tenant must reconnect
  | 'suppress_contact' // user blocked the Page / not reachable
  | 'flag_in_audit' // policy violation — track
  | 'retry_later' // transient rate limit / server error
  | 'alert_oncall' // App-level auth problem
  | 'none';

export interface MetaErrorClassification {
  errorClass: ErrorClass;
  sideEffect: MetaSideEffect;
  description: string;
}

const UNKNOWN: MetaErrorClassification = {
  errorClass: 'transient',
  sideEffect: 'none',
  description: 'Unknown Meta error',
};

/**
 * Classify an error from the Graph API.
 *
 * Meta returns errors with `code`, `subcode`, `type`, `message`.
 *   code 190 = OAuthException (token problem)
 *   code 100 + subcode 2018028 = params malformed
 *   code 4 / 17 / 613 = rate limiting
 *   code 10 = permission denied
 *   code 551 / 1545041 = user can't be messaged (blocked, out of window)
 *   code 200 range = permission errors
 *   code 2018108 = user hasn't interacted with Page recently (24h window)
 */
export function classifyMetaError(
  code?: number,
  subcode?: number,
  httpStatus?: number,
): MetaErrorClassification {
  // Token problems — always kill the connection
  if (code === 190) {
    return {
      errorClass: 'permanent',
      sideEffect: 'mark_connection_error',
      description: 'Access token invalid or expired',
    };
  }

  // Rate limits
  if (code === 4 || code === 17 || code === 32 || code === 613 || httpStatus === 429) {
    return {
      errorClass: 'transient',
      sideEffect: 'retry_later',
      description: 'Rate limit reached',
    };
  }

  // Permission denied on an operation
  if (code === 10 || code === 200 || code === 294) {
    return {
      errorClass: 'permanent',
      sideEffect: 'alert_oncall',
      description: 'Missing permission — App Review needed',
    };
  }

  // User can't be messaged
  if (code === 551 || subcode === 1545041 || subcode === 2018108) {
    return {
      errorClass: 'permanent',
      sideEffect: 'suppress_contact',
      description: 'User not reachable via Messenger (blocked Page or outside 24h window)',
    };
  }

  // Messenger platform policy error
  if (code === 368 || code === 2018109) {
    return {
      errorClass: 'permanent',
      sideEffect: 'flag_in_audit',
      description: 'Messenger platform policy violation',
    };
  }

  // HTTP status fallback
  if (httpStatus) {
    if (httpStatus >= 500) {
      return { errorClass: 'transient', sideEffect: 'retry_later', description: `HTTP ${httpStatus}` };
    }
    if (httpStatus === 401 || httpStatus === 403) {
      return {
        errorClass: 'permanent',
        sideEffect: 'mark_connection_error',
        description: `Auth failure ${httpStatus}`,
      };
    }
  }

  return UNKNOWN;
}
