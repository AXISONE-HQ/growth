/**
 * Unit tests for Twilio error classification.
 * Runs with Vitest (standard in the repo).
 */

import { describe, expect, it } from 'vitest';
import { classifyTwilioError } from '../errors.js';

describe('classifyTwilioError', () => {
  it('classifies opt-out as permanent + suppress_contact', () => {
    const r = classifyTwilioError(21610);
    expect(r.errorClass).toBe('permanent');
    expect(r.sideEffect).toBe('suppress_contact');
  });

  it('classifies rate limit as transient', () => {
    const r = classifyTwilioError(20429);
    expect(r.errorClass).toBe('transient');
    expect(r.sideEffect).toBe('none');
  });

  it('classifies auth failure as alert_oncall', () => {
    const r = classifyTwilioError(20003);
    expect(r.errorClass).toBe('permanent');
    expect(r.sideEffect).toBe('alert_oncall');
  });

  it('classifies carrier filter as flag_in_audit', () => {
    const r = classifyTwilioError(30007);
    expect(r.sideEffect).toBe('flag_in_audit');
  });

  it('defaults unknown codes to transient', () => {
    const r = classifyTwilioError(99999);
    expect(r.errorClass).toBe('transient');
  });

  it('falls back to HTTP 5xx = transient', () => {
    const r = classifyTwilioError(undefined, 503);
    expect(r.errorClass).toBe('transient');
  });

  it('falls back to HTTP 401 = alert_oncall permanent', () => {
    const r = classifyTwilioError(undefined, 401);
    expect(r.errorClass).toBe('permanent');
    expect(r.sideEffect).toBe('alert_oncall');
  });

  it('handles invalid To number as suppress_contact', () => {
    const r = classifyTwilioError(21211);
    expect(r.sideEffect).toBe('suppress_contact');
  });
});
