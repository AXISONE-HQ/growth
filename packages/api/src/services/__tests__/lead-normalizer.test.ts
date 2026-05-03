/**
 * KAN-792 — AI Lead Normalizer tests.
 *
 * Tests the source-aware dispatch + email pre-parser + AI extraction step
 * + failure-isolation per PRD §4 KAN-792 row.
 *
 * Test runner: apps/connectors vitest config picks up
 * packages/api/src/services/__tests__/*.test.ts per
 * reference_cross_workspace_test_runner.
 *
 * llm-client mocked via vi.mock — same idiom as csv-import-llm-client.test.ts
 * (the canonical sibling for Haiku field-extraction unit tests).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock llm-client BEFORE importing the module under test.
const llmCompleteMock = vi.fn();
vi.mock('../llm-client.js', () => ({
  complete: (...args: unknown[]) => llmCompleteMock(...args),
}));

import {
  normalizeInbound,
  normalizeInboundEmail,
  preParseEmail,
  NotImplementedError,
  type EmailPayload,
  type NormalizedLead,
} from '../lead-normalizer.js';

const TENANT_A = '11111111-1111-1111-1111-111111111111';

function mockLLMResponse(text: string): void {
  llmCompleteMock.mockResolvedValueOnce({
    text,
    provider: 'anthropic',
    model: 'claude-haiku-4-5-20251001',
    inputTokens: 100,
    outputTokens: 50,
    costUsd: 0.0001,
    latencyMs: 250,
  });
}

beforeEach(() => {
  llmCompleteMock.mockReset();
});

// ─────────────────────────────────────────────
// Email pre-parser (pure function, no LLM)
// ─────────────────────────────────────────────

describe('preParseEmail — Resend webhook payload extraction', () => {
  it('extracts sender email + subject + body from a typical Formspree-style payload', () => {
    const payload: EmailPayload = {
      fromAddress: 'accounts@formspree.io',
      subject: 'New form submission from contact form',
      bodyPreview: 'Name: Alice Chen\nEmail: alice@acmecorp.com\nMessage: Looking for enterprise pricing.',
      attachmentCount: 0,
    };

    const result = preParseEmail(payload);

    expect(result.source).toBe('email');
    expect(result.senderEmail).toBe('accounts@formspree.io');
    expect(result.senderNameGuess).toBeNull();
    expect(result.subject).toBe('New form submission from contact form');
    expect(result.bodyText).toContain('alice@acmecorp.com');
    expect(result.metadata.attachmentCount).toBe(0);
  });

  it('parses RFC 5322 "Display Name <email>" format', () => {
    const payload: EmailPayload = {
      fromAddress: '"James Miller" <james@techstartup.io>',
      subject: 'Demo request',
      bodyPreview: 'Hi team, can we schedule a demo next week?',
    };

    const result = preParseEmail(payload);
    expect(result.senderEmail).toBe('james@techstartup.io');
    expect(result.senderNameGuess).toBe('James Miller');
  });

  it('parses unquoted display-name format', () => {
    const payload: EmailPayload = {
      fromAddress: 'Sarah Patel <sarah.patel@example.com>',
      subject: 'Question',
    };

    const result = preParseEmail(payload);
    expect(result.senderEmail).toBe('sarah.patel@example.com');
    expect(result.senderNameGuess).toBe('Sarah Patel');
  });

  it('lowercases the email address', () => {
    const payload: EmailPayload = {
      fromAddress: 'Mixed.Case@Example.COM',
      subject: 'Re: pricing',
    };
    const result = preParseEmail(payload);
    expect(result.senderEmail).toBe('mixed.case@example.com');
  });

  it('handles missing/empty subject + body gracefully (returns null, not empty string)', () => {
    const payload: EmailPayload = {
      fromAddress: 'noreply@example.com',
      subject: '',
      bodyPreview: undefined,
    };
    const result = preParseEmail(payload);
    expect(result.subject).toBeNull();
    expect(result.bodyText).toBeNull();
  });

  it('handles malformed fromAddress (no @ sign) by setting empty senderEmail', () => {
    const payload: EmailPayload = {
      fromAddress: 'not-an-email',
      subject: 'oops',
    };
    const result = preParseEmail(payload);
    expect(result.senderEmail).toBe('');
    expect(result.senderNameGuess).toBeNull();
  });
});

// ─────────────────────────────────────────────
// AI extraction step (mocked llm-client)
// ─────────────────────────────────────────────

describe('normalizeInboundEmail — AI extraction happy paths', () => {
  it('extracts canonical fields for a clear demo-request email', async () => {
    mockLLMResponse(
      JSON.stringify({
        firstName: 'Maria',
        lastName: 'Lopez',
        company: 'Acme Corp',
        phone: null,
        intentSummary: 'Wants a 30-min product demo for their team.',
        qualificationSignals: ['demo request', 'team adoption'],
      }),
    );

    const result = await normalizeInboundEmail(TENANT_A, {
      fromAddress: '"Maria Lopez" <maria@acmecorp.com>',
      subject: 'Demo request',
      bodyPreview: "Hi team, I'm Maria from Acme Corp. Can we get a 30-min demo for our 8-person team next Tuesday? Thanks.",
    });

    expect(result.source).toBe('email');
    expect(result.extractionConfidence).toBe('high');
    expect(result.extractionError).toBeNull();
    expect(result.extracted.firstName).toBe('Maria');
    expect(result.extracted.lastName).toBe('Lopez');
    expect(result.extracted.company).toBe('Acme Corp');
    expect(result.extracted.intentSummary).toContain('demo');
    expect(result.extracted.qualificationSignals).toEqual(['demo request', 'team adoption']);
    expect(result.preParsed.senderEmail).toBe('maria@acmecorp.com');
    expect(result.preParsed.senderNameGuess).toBe('Maria Lopez');

    // Confirm llm-client called with expected shape
    expect(llmCompleteMock).toHaveBeenCalledTimes(1);
    const callArgs = llmCompleteMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(callArgs.tenantId).toBe(TENANT_A);
    expect(callArgs.tier).toBe('cheap');
    expect(callArgs.callerTag).toBe('lead-normalizer:email-extraction');
  });

  it('classifies as "medium" confidence when only some canonical fields are populated', async () => {
    mockLLMResponse(
      JSON.stringify({
        firstName: 'Anonymous',
        lastName: null,
        company: null,
        phone: null,
        intentSummary: 'Generic pricing question.',
        qualificationSignals: ['asking about pricing'],
      }),
    );

    const result = await normalizeInboundEmail(TENANT_A, {
      fromAddress: 'someone@gmail.com',
      subject: 'Pricing question',
      bodyPreview: 'How much does it cost?',
    });

    // 2 populated (firstName + intentSummary) → 'medium' per classifyConfidence
    expect(result.extractionConfidence).toBe('medium');
    expect(result.extracted.firstName).toBe('Anonymous');
    expect(result.extracted.company).toBeNull();
  });

  it('caps qualificationSignals at 5 items + filters non-strings', async () => {
    mockLLMResponse(
      JSON.stringify({
        firstName: 'Tom',
        lastName: 'Test',
        company: 'TestCo',
        intentSummary: 'Many signals',
        qualificationSignals: [
          'signal 1',
          'signal 2',
          'signal 3',
          'signal 4',
          'signal 5',
          'signal 6',
          'signal 7',
          42,
          null,
          '',
        ],
      }),
    );

    const result = await normalizeInboundEmail(TENANT_A, {
      fromAddress: 'tom@test.com',
      subject: 's',
      bodyPreview: 'b',
    });

    expect(result.extracted.qualificationSignals).toHaveLength(5);
    expect(result.extracted.qualificationSignals).toEqual([
      'signal 1',
      'signal 2',
      'signal 3',
      'signal 4',
      'signal 5',
    ]);
  });

  it('truncates intentSummary at 140 chars', async () => {
    const longText = 'a'.repeat(200);
    mockLLMResponse(
      JSON.stringify({
        firstName: 'X',
        lastName: 'Y',
        company: 'Z',
        intentSummary: longText,
        qualificationSignals: [],
      }),
    );

    const result = await normalizeInboundEmail(TENANT_A, {
      fromAddress: 'x@y.com',
      subject: 's',
      bodyPreview: 'b',
    });

    expect(result.extracted.intentSummary).toHaveLength(140);
  });
});

// ─────────────────────────────────────────────
// AI extraction step — failure-isolation paths
// ─────────────────────────────────────────────

describe('normalizeInboundEmail — failure isolation (PRD §4 spec d)', () => {
  it('LLM call throws → extractionConfidence=low, extractionError populated, preParsed still populated', async () => {
    llmCompleteMock.mockRejectedValueOnce(new Error('429 rate-limited'));

    const result = await normalizeInboundEmail(TENANT_A, {
      fromAddress: '"Test User" <test@example.com>',
      subject: 'Test',
      bodyPreview: 'body',
    });

    expect(result.extractionConfidence).toBe('low');
    expect(result.extractionError).toContain('llm-call-failed');
    expect(result.extractionError).toContain('429 rate-limited');
    // Pre-parsed fields are still populated (failure isolation)
    expect(result.preParsed.senderEmail).toBe('test@example.com');
    expect(result.preParsed.senderNameGuess).toBe('Test User');
    expect(result.preParsed.subject).toBe('Test');
    // Extracted fields are all null
    expect(result.extracted.firstName).toBeNull();
    expect(result.extracted.qualificationSignals).toEqual([]);
  });

  it('LLM returns no JSON object → extractionConfidence=low, no-json-object error', async () => {
    mockLLMResponse('I cannot process this request.');

    const result = await normalizeInboundEmail(TENANT_A, {
      fromAddress: 'test@example.com',
      subject: 's',
      bodyPreview: 'b',
    });

    expect(result.extractionConfidence).toBe('low');
    expect(result.extractionError).toBe('no-json-object-in-llm-response');
    expect(result.extracted.firstName).toBeNull();
  });

  it('LLM returns malformed JSON (object delimiters present but invalid syntax) → json-parse-failed', async () => {
    // Has both `{` and `}` (so the regex matches), but the inside is invalid JSON.
    // Triggers json-parse-failed (vs no-json-object-in-llm-response which fires
    // when the regex itself can't find a {...} block).
    mockLLMResponse('{ "firstName": "Bob" "lastName": "Test" }');

    const result = await normalizeInboundEmail(TENANT_A, {
      fromAddress: 'bob@example.com',
      subject: 's',
      bodyPreview: 'b',
    });

    expect(result.extractionConfidence).toBe('low');
    expect(result.extractionError).toContain('json-parse-failed');
  });

  it('LLM returns valid JSON with all nulls → low confidence, no error (genuine "could not extract" outcome)', async () => {
    mockLLMResponse(
      JSON.stringify({
        firstName: null,
        lastName: null,
        company: null,
        phone: null,
        intentSummary: null,
        qualificationSignals: [],
      }),
    );

    const result = await normalizeInboundEmail(TENANT_A, {
      fromAddress: 'noreply@bounceback.example.com',
      subject: 'Auto-reply',
      bodyPreview: 'Out of office until Monday',
    });

    expect(result.extractionConfidence).toBe('low');
    // No error — this is a successful LLM response that yielded no extractable fields
    expect(result.extractionError).toBeNull();
    expect(result.extracted.firstName).toBeNull();
  });
});

// ─────────────────────────────────────────────
// Source dispatch (NotImplementedError for non-email sources)
// ─────────────────────────────────────────────

describe('normalizeInbound — source dispatch (V1 supports email only)', () => {
  it('email source routes through normalizeInboundEmail successfully', async () => {
    mockLLMResponse(
      JSON.stringify({
        firstName: 'Routed',
        lastName: 'OK',
        company: 'Co',
        phone: null,
        intentSummary: 'Checking dispatch.',
        qualificationSignals: [],
      }),
    );

    const result = await normalizeInbound({
      source: 'email',
      tenantId: TENANT_A,
      payload: {
        fromAddress: 'routed@example.com',
        subject: 'Dispatch test',
        bodyPreview: 'body',
      },
    });

    expect(result.source).toBe('email');
    expect(result.extracted.firstName).toBe('Routed');
  });

  it('meta_lead_ads throws NotImplementedError naming KAN-799', async () => {
    await expect(
      normalizeInbound({ source: 'meta_lead_ads', tenantId: TENANT_A, payload: {} }),
    ).rejects.toThrow(NotImplementedError);
    await expect(
      normalizeInbound({ source: 'meta_lead_ads', tenantId: TENANT_A, payload: {} }),
    ).rejects.toThrow(/KAN-799/);
  });

  it('sms throws NotImplementedError naming KAN-800', async () => {
    await expect(
      normalizeInbound({ source: 'sms', tenantId: TENANT_A, payload: {} }),
    ).rejects.toThrow(/KAN-800/);
  });

  it('whatsapp throws NotImplementedError naming KAN-802', async () => {
    await expect(
      normalizeInbound({ source: 'whatsapp', tenantId: TENANT_A, payload: {} }),
    ).rejects.toThrow(/KAN-802/);
  });

  it('voice throws NotImplementedError naming KAN-803', async () => {
    await expect(
      normalizeInbound({ source: 'voice', tenantId: TENANT_A, payload: {} }),
    ).rejects.toThrow(/KAN-803/);
  });

  it('lead_api throws NotImplementedError', async () => {
    await expect(
      normalizeInbound({ source: 'lead_api', tenantId: TENANT_A, payload: {} }),
    ).rejects.toThrow(NotImplementedError);
  });
});

// ─────────────────────────────────────────────
// End-to-end (NormalizedLead shape verification)
// ─────────────────────────────────────────────

describe('normalizeInbound — end-to-end NormalizedLead shape', () => {
  it('produces a complete NormalizedLead from a valid email payload (eyeball the shape)', async () => {
    mockLLMResponse(
      JSON.stringify({
        firstName: 'Alice',
        lastName: 'Founder',
        company: 'StartupXYZ',
        phone: '+1-555-0142',
        intentSummary: 'Wants enterprise pricing for their growing team.',
        qualificationSignals: ['asking about pricing', 'enterprise tier', 'growth stage'],
      }),
    );

    const result: NormalizedLead = await normalizeInbound({
      source: 'email',
      tenantId: TENANT_A,
      payload: {
        fromAddress: '"Alice Founder" <alice@startupxyz.com>',
        subject: 'Enterprise pricing inquiry',
        bodyPreview: "Hi, we're growing fast at StartupXYZ and need to understand your enterprise pricing. Can we chat? +1-555-0142",
        attachmentCount: 0,
      },
    });

    // Shape verification — every public field present and correctly typed
    expect(result).toMatchObject({
      source: 'email',
      preParsed: {
        source: 'email',
        senderEmail: 'alice@startupxyz.com',
        senderNameGuess: 'Alice Founder',
        subject: 'Enterprise pricing inquiry',
        bodyText: expect.stringContaining('enterprise pricing'),
        metadata: { attachmentCount: 0 },
      },
      extracted: {
        firstName: 'Alice',
        lastName: 'Founder',
        company: 'StartupXYZ',
        phone: '+1-555-0142',
        intentSummary: 'Wants enterprise pricing for their growing team.',
        qualificationSignals: ['asking about pricing', 'enterprise tier', 'growth stage'],
      },
      extractionConfidence: 'high',
      extractionError: null,
    });
  });
});
