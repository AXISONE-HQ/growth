/**
 * Unit tests for Resend error classification.
 *
 * Note: classifyResendEvent (the event-webhook classifier) is deferred to
 * KAN-684 alongside the Resend webhook handler. Tests for it land with that
 * ticket — same shape as the prior classifySendGridEvent suite.
 */

import { describe, expect, it } from 'vitest';
import { classifyResendStatus } from '../errors.js';

describe('classifyResendStatus', () => {
  it('5xx = transient', () => {
    expect(classifyResendStatus(500).errorClass).toBe('transient');
    expect(classifyResendStatus(502).errorClass).toBe('transient');
  });

  it('401 / 403 = permanent + alert_oncall', () => {
    const r = classifyResendStatus(401);
    expect(r.errorClass).toBe('permanent');
    expect(r.sideEffect).toBe('alert_oncall');
  });

  it('429 = transient', () => {
    expect(classifyResendStatus(429).errorClass).toBe('transient');
  });

  it('400 = permanent flag_in_audit', () => {
    const r = classifyResendStatus(400);
    expect(r.errorClass).toBe('permanent');
    expect(r.sideEffect).toBe('flag_in_audit');
  });

  it('422 = permanent suppress_contact (invalid recipient)', () => {
    const r = classifyResendStatus(422);
    expect(r.errorClass).toBe('permanent');
    expect(r.sideEffect).toBe('suppress_contact');
  });

  it('413 = permanent flag_in_audit (payload too large)', () => {
    const r = classifyResendStatus(413);
    expect(r.errorClass).toBe('permanent');
    expect(r.sideEffect).toBe('flag_in_audit');
  });

  it('undefined status = transient unknown', () => {
    const r = classifyResendStatus(undefined);
    expect(r.errorClass).toBe('transient');
    expect(r.sideEffect).toBe('none');
  });
});
