/**
 * Unit tests for SendGrid error + event classification.
 */

import { describe, expect, it } from 'vitest';
import { classifySendGridEvent, classifySendGridStatus } from '../errors.js';

describe('classifySendGridStatus', () => {
  it('5xx = transient', () => {
    expect(classifySendGridStatus(500).errorClass).toBe('transient');
    expect(classifySendGridStatus(502).errorClass).toBe('transient');
  });

  it('401 / 403 = permanent + alert_oncall', () => {
    const r = classifySendGridStatus(401);
    expect(r.errorClass).toBe('permanent');
    expect(r.sideEffect).toBe('alert_oncall');
  });

  it('429 = transient', () => {
    expect(classifySendGridStatus(429).errorClass).toBe('transient');
  });

  it('400 = permanent flag_in_audit', () => {
    const r = classifySendGridStatus(400);
    expect(r.errorClass).toBe('permanent');
    expect(r.sideEffect).toBe('flag_in_audit');
  });
});

describe('classifySendGridEvent', () => {
  it('delivered + open + click = no-op', () => {
    expect(classifySendGridEvent({ event: 'delivered' }).sideEffect).toBe('none');
    expect(classifySendGridEvent({ event: 'open' }).sideEffect).toBe('none');
    expect(classifySendGridEvent({ event: 'click' }).sideEffect).toBe('none');
  });

  it('spamreport = suppress_contact permanent', () => {
    const r = classifySendGridEvent({ event: 'spamreport' });
    expect(r.errorClass).toBe('permanent');
    expect(r.sideEffect).toBe('suppress_contact');
  });

  it('unsubscribe = suppress_contact permanent', () => {
    const r = classifySendGridEvent({ event: 'unsubscribe' });
    expect(r.sideEffect).toBe('suppress_contact');
  });

  it('hard bounce (5.x) = permanent suppress', () => {
    const r = classifySendGridEvent({ event: 'bounce', type: 'bounce', status: '5.7.1' });
    expect(r.errorClass).toBe('permanent');
    expect(r.sideEffect).toBe('suppress_contact');
  });

  it('soft bounce (4.x) = transient retry', () => {
    const r = classifySendGridEvent({ event: 'bounce', type: 'bounce', status: '4.2.1' });
    expect(r.errorClass).toBe('transient');
    expect(r.sideEffect).toBe('transient_retry');
  });

  it('deferred = transient retry', () => {
    const r = classifySendGridEvent({ event: 'deferred' });
    expect(r.errorClass).toBe('transient');
    expect(r.sideEffect).toBe('transient_retry');
  });

  it('dropped = suppress_contact', () => {
    const r = classifySendGridEvent({ event: 'dropped', reason: 'bounced address' });
    expect(r.sideEffect).toBe('suppress_contact');
  });

  it('group_resubscribe = no-op', () => {
    expect(classifySendGridEvent({ event: 'group_resubscribe' }).sideEffect).toBe('none');
  });

  it('unknown event = transient default', () => {
    expect(classifySendGridEvent({ event: 'mystery' }).errorClass).toBe('transient');
  });
});
