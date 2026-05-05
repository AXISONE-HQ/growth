/**
 * KAN-817 — ActionExecutedEventSchema contract tests.
 *
 * Pins the `subject` / `bodyPreview` additive fields' validation behavior:
 *   - Both populated → validates
 *   - Neither populated → validates (back-compat for the webhook-side
 *     publisher and any legacy producers)
 *   - Only one populated → validates
 *   - Over-cap subject → ZodError
 *   - Over-cap bodyPreview → ZodError
 *
 * If anyone changes the caps in the canonical schema without updating this
 * test (and the inline mirror in apps/api/src/subscribers/action-executed-push.ts),
 * the cap-drift gets caught here.
 */
import { describe, it, expect } from 'vitest';
import { ActionExecutedEventSchema } from '@growth/connector-contracts';

const BASE_EVENT = {
  topic: 'action.executed' as const,
  timestamp: '2026-05-04T22:00:00.000Z',
  tenantId: '9ca85088-f65b-4bac-b098-fff742281ede',
  actionId: '550e8400-e29b-41d4-a716-446655440000',
  decisionId: 'decision_brain_v1_test',
  contactId: '11111111-aaaa-bbbb-cccc-222222222222',
  connectionId: '35ad29cd-9c96-4a05-8b90-ec3376936d1d',
  channel: 'EMAIL' as const,
  provider: 'resend',
  status: 'sent' as const,
  attemptNumber: 1,
};

describe('KAN-817 — ActionExecutedEventSchema additive fields', () => {
  it('validates with both subject + bodyPreview populated', () => {
    const result = ActionExecutedEventSchema.safeParse({
      ...BASE_EVENT,
      subject: 'Quick question about pricing',
      bodyPreview: 'Hi Alice — saw your reply yesterday. Curious what caught your eye?',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.subject).toBe('Quick question about pricing');
      expect(result.data.bodyPreview).toContain('Hi Alice');
    }
  });

  it('validates with neither subject nor bodyPreview (legacy / webhook-side producer)', () => {
    const result = ActionExecutedEventSchema.safeParse(BASE_EVENT);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.subject).toBeUndefined();
      expect(result.data.bodyPreview).toBeUndefined();
    }
  });

  it('validates with only subject populated (webhook-side: subject from evt.data.subject, no body)', () => {
    const result = ActionExecutedEventSchema.safeParse({
      ...BASE_EVENT,
      subject: 'Subject only',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.subject).toBe('Subject only');
      expect(result.data.bodyPreview).toBeUndefined();
    }
  });

  it('validates with only bodyPreview populated', () => {
    const result = ActionExecutedEventSchema.safeParse({
      ...BASE_EVENT,
      bodyPreview: 'Body only',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.subject).toBeUndefined();
      expect(result.data.bodyPreview).toBe('Body only');
    }
  });

  it('rejects subject longer than 200 chars (cap drift guard)', () => {
    const tooLong = 'x'.repeat(201);
    const result = ActionExecutedEventSchema.safeParse({
      ...BASE_EVENT,
      subject: tooLong,
    });
    expect(result.success).toBe(false);
  });

  it('rejects bodyPreview longer than 500 chars (cap drift guard)', () => {
    const tooLong = 'x'.repeat(501);
    const result = ActionExecutedEventSchema.safeParse({
      ...BASE_EVENT,
      bodyPreview: tooLong,
    });
    expect(result.success).toBe(false);
  });

  it('accepts exactly-at-cap subject (200 chars) + bodyPreview (500 chars)', () => {
    const subjectAtCap = 'x'.repeat(200);
    const bodyPreviewAtCap = 'y'.repeat(500);
    const result = ActionExecutedEventSchema.safeParse({
      ...BASE_EVENT,
      subject: subjectAtCap,
      bodyPreview: bodyPreviewAtCap,
    });
    expect(result.success).toBe(true);
  });

  it('strips unknown fields silently (zod default — rolling-deploy back-compat)', () => {
    const result = ActionExecutedEventSchema.safeParse({
      ...BASE_EVENT,
      futureField: 'some-future-value',
      anotherFutureField: 42,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      // Unknown fields should not appear on the parsed object.
      expect((result.data as Record<string, unknown>).futureField).toBeUndefined();
      expect((result.data as Record<string, unknown>).anotherFutureField).toBeUndefined();
    }
  });
});
