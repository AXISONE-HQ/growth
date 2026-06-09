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
  normalizeInboundLeadApi,
  preParseEmail,
  preParseLeadApi,
  NotImplementedError,
  type EmailPayload,
  type LeadApiPayload,
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

    expect(result.source).toBe('email_inbox');
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
        companyName: 'Acme Corp',
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

    expect(result.source).toBe('email_inbox');
    expect(result.extractionConfidence).toBe('high');
    expect(result.extractionError).toBeNull();
    expect(result.extracted.firstName).toBe('Maria');
    expect(result.extracted.lastName).toBe('Lopez');
    expect(result.extracted.companyName).toBe('Acme Corp');
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
        companyName: null,
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
    expect(result.extracted.companyName).toBeNull();
  });

  it('caps qualificationSignals at 5 items + filters non-strings', async () => {
    mockLLMResponse(
      JSON.stringify({
        firstName: 'Tom',
        lastName: 'Test',
        companyName: 'TestCo',
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
        companyName: 'Z',
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
        companyName: null,
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
        companyName: 'Co',
        phone: null,
        intentSummary: 'Checking dispatch.',
        qualificationSignals: [],
      }),
    );

    const result = await normalizeInbound({
      source: 'email_inbox',
      tenantId: TENANT_A,
      payload: {
        fromAddress: 'routed@example.com',
        subject: 'Dispatch test',
        bodyPreview: 'body',
      },
    });

    expect(result.source).toBe('email_inbox');
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

  // KAN-1141 PR 0 — lead_api dispatcher case (previously threw
  // NotImplementedError; now routes through normalizeInboundLeadApi).
  it('lead_api source routes through normalizeInboundLeadApi successfully', async () => {
    const result = await normalizeInbound({
      source: 'lead_api',
      tenantId: TENANT_A,
      payload: {
        email: 'caller@acme.com',
        firstName: 'Alice',
        lastName: 'Caller',
      },
    });
    expect(result.source).toBe('lead_api');
    expect(result.extractionConfidence).toBe('high');
    expect(result.extractionError).toBeNull();
    expect(result.extracted.firstName).toBe('Alice');
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
        companyName: 'StartupXYZ',
        phone: '+1-555-0142',
        intentSummary: 'Wants enterprise pricing for their growing team.',
        qualificationSignals: ['asking about pricing', 'enterprise tier', 'growth stage'],
      }),
    );

    const result: NormalizedLead = await normalizeInbound({
      source: 'email_inbox',
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
      source: 'email_inbox',
      preParsed: {
        source: 'email_inbox',
        senderEmail: 'alice@startupxyz.com',
        senderNameGuess: 'Alice Founder',
        subject: 'Enterprise pricing inquiry',
        bodyText: expect.stringContaining('enterprise pricing'),
        metadata: { attachmentCount: 0 },
      },
      extracted: {
        firstName: 'Alice',
        lastName: 'Founder',
        companyName: 'StartupXYZ',
        phone: '+1-555-0142',
        intentSummary: 'Wants enterprise pricing for their growing team.',
        qualificationSignals: ['asking about pricing', 'enterprise tier', 'growth stage'],
      },
      extractionConfidence: 'high',
      extractionError: null,
    });
  });
});

// ─────────────────────────────────────────────
// KAN-1141 PR 0 — Lead-API pre-parser + normalizer (no LLM per Q3a(i))
// ─────────────────────────────────────────────

describe('preParseLeadApi — KAN-1141 PR 0', () => {
  it('extracts email + senderNameGuess from full payload', () => {
    const payload: LeadApiPayload = {
      email: 'caller@acme.com',
      firstName: 'Alice',
      lastName: 'Caller',
    };
    const result = preParseLeadApi(payload);
    expect(result.source).toBe('lead_api');
    expect(result.senderEmail).toBe('caller@acme.com');
    expect(result.senderNameGuess).toBe('Alice Caller');
    expect(result.subject).toBeNull();
    expect(result.bodyText).toBeNull();
    expect(result.metadata.attachmentCount).toBe(0);
  });

  it('handles missing firstName/lastName → senderNameGuess: null', () => {
    const payload: LeadApiPayload = { email: 'caller@acme.com' };
    const result = preParseLeadApi(payload);
    expect(result.senderEmail).toBe('caller@acme.com');
    expect(result.senderNameGuess).toBeNull();
  });

  it('handles partial name (firstName only) → senderNameGuess uses what is present', () => {
    const payload: LeadApiPayload = { email: 'caller@acme.com', firstName: 'Alice' };
    const result = preParseLeadApi(payload);
    expect(result.senderNameGuess).toBe('Alice');
  });

  it('preserves arbitrary metadata under rawApiMetadata on the intermediate shape', () => {
    const payload: LeadApiPayload = {
      email: 'caller@acme.com',
      metadata: { campaign: 'spring-2026', referrer: 'partner-x' },
    };
    const result = preParseLeadApi(payload);
    expect(result.metadata.rawApiMetadata).toEqual({
      campaign: 'spring-2026',
      referrer: 'partner-x',
    });
  });

  it('lowercases the email + populates apiKeyTag on metadata when supplied', () => {
    const payload: LeadApiPayload = {
      email: 'Caller@ACME.com',
      apiKeyTag: 'abc123def456',
    };
    const result = preParseLeadApi(payload);
    expect(result.senderEmail).toBe('caller@acme.com');
    expect(result.metadata.apiKeyTag).toBe('abc123def456');
  });
});

describe('normalizeInboundLeadApi — KAN-1141 PR 0', () => {
  it('produces a complete NormalizedLead with extractionConfidence=high (no LLM, structured data is source of truth)', async () => {
    const result: NormalizedLead = await normalizeInboundLeadApi(TENANT_A, {
      email: 'caller@acme.com',
      firstName: 'Alice',
      lastName: 'Caller',
      metadata: { utm_source: 'partner' },
    });

    expect(result).toMatchObject({
      source: 'lead_api',
      preParsed: {
        source: 'lead_api',
        senderEmail: 'caller@acme.com',
        senderNameGuess: 'Alice Caller',
        subject: null,
        bodyText: null,
      },
      extracted: {
        firstName: 'Alice',
        lastName: 'Caller',
        companyName: null,
        phone: null,
        intentSummary: null,
        qualificationSignals: [],
      },
      extractionConfidence: 'high',
      extractionError: null,
    });
  });
});

// ─────────────────────────────────────────────
// KAN-1140 Phase 2 — locale-aware multilingual Haiku prompt
// ─────────────────────────────────────────────
//
// Q5(b) single multilingual prompt with locale instruction: when an
// `EmailPayload.locale` is threaded through (from the webhook's resolved
// language), `runAIExtraction()` injects a `## Email language` block into
// the userPrompt and the prompt header instructs Haiku to emit
// `intentSummary` + `qualificationSignals` in that locale.

describe('preParseEmail — KAN-1140 Phase 2 locale pass-through', () => {
  it('propagates EmailPayload.locale onto PreParsedLead.locale verbatim', () => {
    const result = preParseEmail({
      fromAddress: 'maria@acmecorp.com',
      subject: 'Demo',
      bodyPreview: 'demo body',
      attachmentCount: 0,
      locale: 'fr',
    });
    expect(result.locale).toBe('fr');
  });

  it('normalizes whitespace-only locale to null (empty string is meaningless to prompt)', () => {
    const result = preParseEmail({
      fromAddress: 'a@b.com',
      subject: 'x',
      bodyPreview: 'x',
      locale: '   ',
    });
    expect(result.locale).toBeNull();
  });

  it('defaults locale to null when EmailPayload omits the field (legacy callers)', () => {
    const result = preParseEmail({
      fromAddress: 'a@b.com',
      subject: 'x',
      bodyPreview: 'x',
    });
    expect(result.locale).toBeNull();
  });
});

describe('normalizeInboundEmail — KAN-1140 Phase 2 locale-aware prompt', () => {
  it('injects "## Email language\\n${locale}" block into userPrompt when locale is present', async () => {
    mockLLMResponse(
      JSON.stringify({
        firstName: 'Marie',
        lastName: 'Dupont',
        companyName: 'Acme SARL',
        phone: null,
        intentSummary: 'Souhaite une démonstration produit.',
        qualificationSignals: ['demande de démonstration'],
      }),
    );

    await normalizeInboundEmail(TENANT_A, {
      fromAddress: '"Marie Dupont" <marie@acme.fr>',
      subject: 'Demande de démonstration',
      bodyPreview: 'Bonjour, je souhaiterais voir une démonstration produit.',
      locale: 'fr',
    });

    expect(llmCompleteMock).toHaveBeenCalledTimes(1);
    const callArgs = llmCompleteMock.mock.calls[0]![0] as Record<string, unknown>;
    const userPrompt = callArgs.userPrompt as string;
    expect(userPrompt).toContain('## Email language\nfr');
  });

  it('omits the locale block entirely when EmailPayload.locale is null (English-default)', async () => {
    mockLLMResponse(
      JSON.stringify({
        firstName: 'John',
        lastName: 'Smith',
        companyName: null,
        phone: null,
        intentSummary: 'Asking about pricing.',
        qualificationSignals: ['asking about pricing'],
      }),
    );

    await normalizeInboundEmail(TENANT_A, {
      fromAddress: 'john@example.com',
      subject: 'Pricing',
      bodyPreview: 'How much does it cost?',
      // no locale field
    });

    const callArgs = llmCompleteMock.mock.calls[0]![0] as Record<string, unknown>;
    const userPrompt = callArgs.userPrompt as string;
    expect(userPrompt).not.toContain('## Email language');
  });

  it('handles non-default locale (es) — verifies the block is verbatim from PreParsedLead.locale', async () => {
    mockLLMResponse(
      JSON.stringify({
        firstName: 'Carlos',
        lastName: 'Garcia',
        companyName: 'Hispano S.A.',
        phone: null,
        intentSummary: 'Pregunta sobre precios empresariales.',
        qualificationSignals: ['preguntando precios'],
      }),
    );

    await normalizeInboundEmail(TENANT_A, {
      fromAddress: '"Carlos Garcia" <carlos@hispano.es>',
      subject: 'Consulta de precios',
      bodyPreview: 'Hola, me interesa conocer los precios de su nivel empresarial.',
      locale: 'es',
    });

    const callArgs = llmCompleteMock.mock.calls[0]![0] as Record<string, unknown>;
    const userPrompt = callArgs.userPrompt as string;
    expect(userPrompt).toContain('## Email language\nes');
  });
});
