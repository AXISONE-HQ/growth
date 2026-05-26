/**
 * KAN-1018 — error classifier test matrix.
 *
 * Pins the persistent/transient categorization for every error class the
 * decision-run-push handler can encounter. Default: unknown → persistent
 * (fail-safe — don't auto-storm something we can't recognize).
 */
import { describe, it, expect } from 'vitest';
import { classifyError } from '../error-classifier.js';
import { z } from 'zod';

describe('KAN-1018 — error classifier', () => {
  describe('PERSISTENT — schema / validation / code errors', () => {
    it('ZodError → persistent zod_parse', () => {
      const r = z.object({ id: z.string() }).safeParse({ id: 123 });
      expect(r.success).toBe(false);
      const c = classifyError(r.error);
      expect(c.category).toBe('persistent');
      expect(c.reasonCode).toBe('zod_parse');
    });

    it('TypeError ("cannot read properties of undefined") → persistent type_error', () => {
      let err: unknown;
      try {
        // @ts-expect-error intentional runtime null-deref for the test
        const x: undefined = undefined;
        (x as { foo: unknown }).foo;
      } catch (e) {
        err = e;
      }
      const c = classifyError(err);
      expect(c.category).toBe('persistent');
      expect(c.reasonCode).toBe('type_error');
    });

    it('SyntaxError → persistent', () => {
      const err = new SyntaxError('Unexpected token');
      expect(classifyError(err).category).toBe('persistent');
    });

    it('Prisma P2002 (unique constraint) → persistent', () => {
      const err = Object.assign(new Error('Unique constraint failed'), {
        name: 'PrismaClientKnownRequestError',
        code: 'P2002',
      });
      // Force constructor name to match Prisma's at runtime (the real
      // class isn't in scope; structural match is all the classifier reads).
      Object.defineProperty(err, 'constructor', { value: { name: 'PrismaClientKnownRequestError' } });
      const c = classifyError(err);
      expect(c.category).toBe('persistent');
      expect(c.reasonCode).toBe('prisma_p2002');
    });

    it('Prisma P2025 (record not found) → persistent', () => {
      const err = Object.assign(new Error('Record to update not found'), { name: 'PrismaClientKnownRequestError', code: 'P2025' });
      Object.defineProperty(err, 'constructor', { value: { name: 'PrismaClientKnownRequestError' } });
      const c = classifyError(err);
      expect(c.category).toBe('persistent');
    });

    it('PrismaClientValidationError → persistent', () => {
      const err = Object.assign(new Error('Unknown field'), { name: 'PrismaClientValidationError' });
      Object.defineProperty(err, 'constructor', { value: { name: 'PrismaClientValidationError' } });
      const c = classifyError(err);
      expect(c.category).toBe('persistent');
      expect(c.reasonCode).toBe('prisma_validation');
    });

    it('TRPCError BAD_REQUEST → persistent', () => {
      const err = Object.assign(new Error('Bad request'), { name: 'TRPCError', code: 'BAD_REQUEST' });
      Object.defineProperty(err, 'constructor', { value: { name: 'TRPCError' } });
      const c = classifyError(err);
      expect(c.category).toBe('persistent');
      expect(c.reasonCode).toBe('trpc_bad_request');
    });

    it('TRPCError NOT_FOUND → persistent', () => {
      const err = Object.assign(new Error('Not found'), { name: 'TRPCError', code: 'NOT_FOUND' });
      Object.defineProperty(err, 'constructor', { value: { name: 'TRPCError' } });
      expect(classifyError(err).category).toBe('persistent');
    });

    it('HTTP 400 → persistent', () => {
      const err = Object.assign(new Error('Bad request'), { status: 400 });
      expect(classifyError(err)).toEqual({ category: 'persistent', reasonCode: 'http_400' });
    });
    it('HTTP 404 → persistent', () => {
      expect(classifyError(Object.assign(new Error('not found'), { statusCode: 404 })).category).toBe('persistent');
    });

    it('Message containing "Zod parse" → persistent (fallback pattern)', () => {
      const err = new Error('simulated engine throw — Zod parse, Prisma error, etc.');
      const c = classifyError(err);
      expect(c.category).toBe('persistent');
      expect(c.reasonCode).toBe('msg_persistent_pattern');
    });

    it('Message containing "invalid enum" → persistent', () => {
      expect(classifyError(new Error('Invalid enum value warm_up')).category).toBe('persistent');
    });

    it('Message containing "unique constraint" → persistent', () => {
      expect(classifyError(new Error('unique constraint violated on email')).category).toBe('persistent');
    });
  });

  describe('TRANSIENT — network / timeout / 5xx / rate-limit', () => {
    it('Plain Error("LLM timeout") → transient (msg pattern)', () => {
      const c = classifyError(new Error('LLM timeout'));
      expect(c.category).toBe('transient');
      expect(c.reasonCode).toBe('msg_transient_pattern');
    });

    it('Error("Connection timed out") → transient', () => {
      expect(classifyError(new Error('Connection timed out after 30s')).category).toBe('transient');
    });

    it('Error("overloaded") → transient (Anthropic-style)', () => {
      expect(classifyError(new Error('overloaded_error: please retry')).category).toBe('transient');
    });

    it('Error("rate-limit exceeded") → transient', () => {
      expect(classifyError(new Error('rate-limit exceeded')).category).toBe('transient');
    });
    it('Error("service unavailable") → transient', () => {
      expect(classifyError(new Error('Service Unavailable')).category).toBe('transient');
    });

    it('Error with code=ECONNRESET → transient (network code)', () => {
      const err = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
      expect(classifyError(err)).toEqual({ category: 'transient', reasonCode: 'econnreset' });
    });

    it('Error with code=ETIMEDOUT → transient', () => {
      const err = Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' });
      expect(classifyError(err).category).toBe('transient');
    });

    it('HTTP 503 → transient', () => {
      const err = Object.assign(new Error('Service Unavailable'), { status: 503 });
      expect(classifyError(err)).toEqual({ category: 'transient', reasonCode: 'http_503' });
    });
    it('HTTP 504 → transient', () => {
      expect(classifyError(Object.assign(new Error('gateway timeout'), { statusCode: 504 })).category).toBe('transient');
    });
    it('HTTP 429 → transient', () => {
      expect(classifyError(Object.assign(new Error('rate limited'), { status: 429 })).category).toBe('transient');
    });
    it('HTTP 408 (request timeout) → transient', () => {
      expect(classifyError(Object.assign(new Error('request timeout'), { status: 408 })).category).toBe('transient');
    });

    it('Prisma P1001 (cant reach DB) → transient', () => {
      const err = Object.assign(new Error("Can't reach database server"), { name: 'PrismaClientKnownRequestError', code: 'P1001' });
      Object.defineProperty(err, 'constructor', { value: { name: 'PrismaClientKnownRequestError' } });
      expect(classifyError(err).category).toBe('transient');
    });

    it('Prisma P1017 (server closed connection) → transient', () => {
      const err = Object.assign(new Error('Server closed the connection'), { name: 'PrismaClientKnownRequestError', code: 'P1017' });
      Object.defineProperty(err, 'constructor', { value: { name: 'PrismaClientKnownRequestError' } });
      expect(classifyError(err).category).toBe('transient');
    });

    it('PrismaClientInitializationError → transient (boot races)', () => {
      const err = Object.assign(new Error('init failed'), { name: 'PrismaClientInitializationError' });
      Object.defineProperty(err, 'constructor', { value: { name: 'PrismaClientInitializationError' } });
      expect(classifyError(err).category).toBe('transient');
    });

    it('TRPCError TOO_MANY_REQUESTS → transient', () => {
      const err = Object.assign(new Error('rate limited'), { name: 'TRPCError', code: 'TOO_MANY_REQUESTS' });
      Object.defineProperty(err, 'constructor', { value: { name: 'TRPCError' } });
      expect(classifyError(err).category).toBe('transient');
    });

    it('TRPCError INTERNAL_SERVER_ERROR → transient', () => {
      const err = Object.assign(new Error('internal'), { name: 'TRPCError', code: 'INTERNAL_SERVER_ERROR' });
      Object.defineProperty(err, 'constructor', { value: { name: 'TRPCError' } });
      expect(classifyError(err).category).toBe('transient');
    });
  });

  describe('FAIL-SAFE — unknown defaults to persistent (no auto-storm)', () => {
    it('Plain Error("something unexpected") → persistent unknown_fail_safe', () => {
      const c = classifyError(new Error('something unexpected'));
      expect(c.category).toBe('persistent');
      expect(c.reasonCode).toBe('unknown_fail_safe');
    });

    it('Bare string error → persistent', () => {
      expect(classifyError('mysterious failure').category).toBe('persistent');
    });

    it('undefined → persistent', () => {
      expect(classifyError(undefined).category).toBe('persistent');
    });

    it('null → persistent', () => {
      expect(classifyError(null).category).toBe('persistent');
    });

    it('Object without recognizable shape → persistent', () => {
      expect(classifyError({ weird: 'thing' }).category).toBe('persistent');
    });
  });

  describe('Priority ordering — transient signal wins when both present', () => {
    it('"timeout" + "validation" in same message → transient (retry might help)', () => {
      // Real example: "LLM call timed out during input validation"
      const c = classifyError(new Error('Connection timed out during validation step'));
      expect(c.category).toBe('transient');
    });
  });
});
