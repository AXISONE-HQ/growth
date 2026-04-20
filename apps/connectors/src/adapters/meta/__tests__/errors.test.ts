import { describe, expect, it } from 'vitest';
import { classifyMetaError } from '../errors.js';

describe('classifyMetaError', () => {
  it('code 190 = permanent, mark_connection_error', () => {
    const r = classifyMetaError(190);
    expect(r.errorClass).toBe('permanent');
    expect(r.sideEffect).toBe('mark_connection_error');
  });

  it.each([4, 17, 32, 613])('rate limit code %i = transient retry_later', (code) => {
    const r = classifyMetaError(code);
    expect(r.errorClass).toBe('transient');
    expect(r.sideEffect).toBe('retry_later');
  });

  it('HTTP 429 = transient retry_later', () => {
    expect(classifyMetaError(undefined, undefined, 429).sideEffect).toBe('retry_later');
  });

  it.each([10, 200, 294])('permission code %i = permanent alert_oncall', (code) => {
    const r = classifyMetaError(code);
    expect(r.errorClass).toBe('permanent');
    expect(r.sideEffect).toBe('alert_oncall');
  });

  it('code 551 = suppress_contact', () => {
    expect(classifyMetaError(551).sideEffect).toBe('suppress_contact');
  });

  it('subcode 2018108 (outside 24h window) = suppress_contact', () => {
    expect(classifyMetaError(undefined, 2018108).sideEffect).toBe('suppress_contact');
  });

  it('code 368 = flag_in_audit (policy violation)', () => {
    expect(classifyMetaError(368).sideEffect).toBe('flag_in_audit');
  });

  it('HTTP 5xx = transient retry_later', () => {
    expect(classifyMetaError(undefined, undefined, 503).errorClass).toBe('transient');
  });

  it('HTTP 401 = permanent mark_connection_error', () => {
    const r = classifyMetaError(undefined, undefined, 401);
    expect(r.errorClass).toBe('permanent');
    expect(r.sideEffect).toBe('mark_connection_error');
  });

  it('unknown = transient default', () => {
    expect(classifyMetaError(99999).errorClass).toBe('transient');
  });
});
