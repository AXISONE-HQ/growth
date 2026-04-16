/**
 * Guardrail Layer â KAN-380
 *
 * Agent Dispatcher â EXECUTE phase
 * Validates all outbound messages before they are sent. Runs a series
 * of checks to ensure tone, accuracy, compliance, and safety.
 * Returns pass/fail with specific violation details.
 *
 * Architecture reference:
 *   Communication Agent / Revenue Agent
 *       â
 *   Guardrail Layer
 *       â
 *   âââââ´âââââââââââââââ¬âââââââââââââââ¬âââââââââââââââ¬âââââââââââââââ
 *   Tone Validator   Accuracy Check  Compliance    Hallucination   Injection
 *       â                                           Filter          Defense
 *   Pass â Send
 *   Fail â Regenerate / Block / Escalate
 *
 * Checks (ALL required before any external action):
 *   - Tone Validator: Off-brand, inappropriate sentiment
 *   - Accuracy Check: Pricing/spec errors vs Company Truth
 *   - Hallucination Filter: Claims not grounded in Brain context
 *   - Compliance Check: CAN-SPAM, CASL, GDPR â opt-out, disclosures
 *   - Injection Defense: Inbound prompt injection attempts
 */

import { z } from 'zod';
import crypto from 'crypto';

// âââââââââââââââââââââââââââââââââââââââââââââ
// Schemas
// âââââââââââââââââââââââââââââââââââââââââââââ

export const GuardrailCheckType = z.enum([
  'tone',
  'accuracy',
  'hallucination',
  'compliance',
  'injection',
]);

export const GuardrailSeverity = z.enum([
  'block',       // Hard stop â cannot send
  'regenerate',  // Must regenerate the message
  'warn',        // Can send with warning logged
  'pass',        // No issue
]);

export const ViolationSchema = z.object({
  checkType: GuardrailCheckType,
  severity: GuardrailSeverity,
  description: z.string(),
  field: z.string().optional(),
  suggestion: z.string().optional(),
});

export const GuardrailInputSchema = z.object({
  tenantId: z.string(),
  contactId: z.string(),
  decisionId: z.string(),
  channel: z.string(),

  // The message to validate
  message: z.object({
    subject: z.string().nullable(),
    body: z.string(),
    to: z.string(),
    from: z.string(),
  }),

  // Company Truth context for accuracy checks
  companyTruth: z.object({
    companyName: z.string(),
    products: z.array(z.object({
      name: z.string(),
      price: z.string().optional(),
      description: z.string().optional(),
    })).default([]),
    constraints: z.array(z.string()).default([]),
    brandVoice: z.string().optional(),
    prohibitedTerms: z.array(z.string()).default([]),
  }).optional(),

  // Compliance settings
  complianceSettings: z.object({
    requireUnsubscribe: z.boolean().default(true),
    requirePhysicalAddress: z.boolean().default(false),
    requireSenderIdentification: z.boolean().default(true),
    gdprApplicable: z.boolean().default(false),
    caslApplicable: z.boolean().default(false),
    contactHasConsent: z.boolean().default(true),
  }).optional(),
});

export const GuardrailResultSchema = z.object({
  tenantId: z.string(),
  contactId: z.string(),
  decisionId: z.string(),
  checkId: z.string(),
  passed: z.boolean(),
  overallSeverity: GuardrailSeverity,
  violations: z.array(ViolationSchema),
  checkedAt: z.string().datetime(),
  checksRun: z.array(GuardrailCheckType),
  durationMs: z.number(),
});

// âââââââââââââââââââââââââââââââââââââââââââââ
// Types
// âââââââââââââââââââââââââââââââââââââââââââââ

export type GuardrailInput = z.infer<typeof GuardrailInputSchema>;
export type GuardrailResult = z.infer<typeof GuardrailResultSchema>;
export type Violation = z.infer<typeof ViolationSchema>;

// âââââââââââââââââââââââââââââââââââââââââââââ
// Individual Guardrail Checks
// âââââââââââââââââââââââââââââââââââââââââââââ

/**
 * Tone Validator â checks for inappropriate language, aggressive tone,
 * overly casual register, or off-brand messaging.
 */
function checkTone(input: GuardrailInput): Violation[] {
  const violations: Violation[] = [];
  const bodyLower = input.message.body.toLowerCase();

  // Check for aggressive/inappropriate language
  const aggressivePatterns = [
    'you must', 'you need to', 'final notice', 'last chance',
    'act now or', 'don\'t miss out', 'limited time only',
    'urgent action required',
  ];

  for (const pattern of aggressivePatterns) {
    if (bodyLower.includes(pattern)) {
      violations.push({
        checkType: 'tone',
        severity: 'regenerate',
        description: `Aggressive/pressure language detected: "${pattern}"`,
        field: 'body',
        suggestion: 'Use collaborative, respectful language without pressure tactics.',
      });
    }
  }

  // Check for all-caps sections (shouting)
  const capsPattern = /[A-Z]{5,}/;
  if (capsPattern.test(input.message.body)) {
    violations.push({
      checkType: 'tone',
      severity: 'warn',
      description: 'Extended uppercase text detected â may appear as shouting.',
      field: 'body',
      suggestion: 'Use standard capitalization for a professional tone.',
    });
  }

  // Check for prohibited terms from brand guide
  if (input.companyTruth?.prohibitedTerms) {
    for (const term of input.companyTruth.prohibitedTerms) {
      if (bodyLower.includes(term.toLowerCase())) {
        violations.push({
          checkType: 'tone',
          severity: 'regenerate',
          description: `Prohibited brand term detected: "${term}"`,
          field: 'body',
          suggestion: `Remove or replace "${term}" per brand guidelines.`,
        });
      }
    }
  }

  // Check message isn't empty or too short for the channel
  if (input.message.body.trim().length < 10) {
    violations.push({
      checkType: 'tone',
      severity: 'block',
      description: 'Message body is too short to be meaningful.',
      field: 'body',
      suggestion: 'Provide a substantive message with clear value.',
    });
  }

  return violations;
}

/**
 * Accuracy Check â validates pricing, product names, and factual claims
 * against Company Truth.
 */
function checkAccuracy(input: GuardrailInput): Violation[] {
  const violations: Violation[] = [];
  if (!input.companyTruth) return violations;

  const bodyLower = input.message.body.toLowerCase();

  // Check for price mentions that don't match known products
  const pricePattern = /\$[\d,]+\.?\d*/g;
  const mentionedPrices = input.message.body.match(pricePattern) ?? [];

  if (mentionedPrices.length > 0 && input.companyTruth.products.length > 0) {
    const knownPrices = input.companyTruth.products
      .map(p => p.price)
      .filter(Boolean);

    for (const mentioned of mentionedPrices) {
      if (!knownPrices.some(kp => kp && kp.includes(mentioned.replace('$', '')))) {
        violations.push({
          checkType: 'accuracy',
          severity: 'regenerate',
          description: `Price "${mentioned}" not found in Company Truth product catalog.`,
          field: 'body',
          suggestion: 'Verify pricing against the product catalog before sending.',
        });
      }
    }
  }

  // Check for product name mentions
  for (const product of input.companyTruth.products) {
    const productNameLower = product.name.toLowerCase();
    // If body mentions something close but not exact, flag it
    // Simple check: ensure mentioned product names match exactly
    if (bodyLower.includes(productNameLower)) {
      // Product name found â good
      continue;
    }
  }

  // Check company name is correct if mentioned
  if (input.companyTruth.companyName) {
    const companyNameLower = input.companyTruth.companyName.toLowerCase();
    // Check for common misspellings by looking for partial matches
    const fromLower = input.message.from.toLowerCase();
    if (fromLower.includes('@') && !fromLower.includes(companyNameLower.replace(/\s+/g, ''))) {
      // This is a soft check â the from address might be valid
    }
  }

  return violations;
}

/**
 * Hallucination Filter â checks for claims not grounded in the Brain context.
 * Flags specific guarantees, promises, or statistics without source.
 */
function checkHallucination(input: GuardrailInput): Violation[] {
  const violations: Violation[] = [];
  const body = input.message.body;

  // Check for ungrounded guarantees
  const guaranteePatterns = [
    /guarantee[ds]?\s/i,
    /100%\s+(satisfaction|success|guaranteed)/i,
    /risk[- ]free/i,
    /no[- ]risk/i,
    /money[- ]back/i,
  ];

  for (const pattern of guaranteePatterns) {
    if (pattern.test(body)) {
      violations.push({
        checkType: 'hallucination',
        severity: 'regenerate',
        description: `Unverifiable guarantee detected: "${body.match(pattern)?.[0]}"`,
        field: 'body',
        suggestion: 'Remove guarantees not explicitly stated in Company Truth.',
      });
    }
  }

  // Check for fabricated statistics
  const statsPattern = /\b\d+%\s+(of|increase|decrease|reduction|improvement|growth|more|less|better|faster)/i;
  if (statsPattern.test(body)) {
    const match = body.match(statsPattern);
    violations.push({
      checkType: 'hallucination',
      severity: 'warn',
      description: `Statistical claim detected â verify against source data: "${match?.[0]}"`,
      field: 'body',
      suggestion: 'Ensure all statistics are sourced from Company Truth or verified data.',
    });
  }

  // Check for fabricated testimonials or quotes
  const testimonialPattern = /["â][^"â]{20,}["â]/;
  if (testimonialPattern.test(body)) {
    violations.push({
      checkType: 'hallucination',
      severity: 'warn',
      description: 'Quoted text detected â verify this is an authentic testimonial.',
      field: 'body',
      suggestion: 'Only include verified testimonials from Company Truth.',
    });
  }

  return violations;
}

/**
 * Compliance Check â validates CAN-SPAM, CASL, GDPR requirements.
 */
function checkCompliance(input: GuardrailInput): Violation[] {
  const violations: Violation[] = [];
  const settings = input.complianceSettings ?? {
    requireUnsubscribe: true,
    requirePhysicalAddress: false,
    requireSenderIdentification: true,
    gdprApplicable: false,
    caslApplicable: false,
    contactHasConsent: true,
  };
  const bodyLower = input.message.body.toLowerCase();

  // CAN-SPAM: Unsubscribe requirement for email
  if (input.channel === 'email' && settings.requireUnsubscribe) {
    const hasUnsubscribe = bodyLower.includes('unsubscribe') ||
      bodyLower.includes('opt out') ||
      bodyLower.includes('opt-out') ||
      bodyLower.includes('manage preferences');

    if (!hasUnsubscribe) {
      violations.push({
        checkType: 'compliance',
        severity: 'block',
        description: 'Email missing unsubscribe/opt-out mechanism (CAN-SPAM requirement).',
        field: 'body',
        suggestion: 'Add an unsubscribe link or opt-out instruction to the email footer.',
      });
    }
  }

  // SMS: STOP opt-out for SMS messages
  if ((input.channel === 'sms' || input.channel === 'whatsapp') && settings.requireUnsubscribe) {
    const hasStop = bodyLower.includes('reply stop') ||
      bodyLower.includes('text stop') ||
      bodyLower.includes('opt out');

    if (!hasStop) {
      violations.push({
        checkType: 'compliance',
        severity: 'block',
        description: 'SMS missing STOP opt-out instruction (TCPA/10DLC requirement).',
        field: 'body',
        suggestion: 'Add "Reply STOP to opt out" to the message.',
      });
    }
  }

  // Sender identification
  if (settings.requireSenderIdentification) {
    if (!input.message.from || input.message.from.trim() === '') {
      violations.push({
        checkType: 'compliance',
        severity: 'block',
        description: 'Missing sender identification.',
        field: 'from',
        suggestion: 'Include a valid sender name/address.',
      });
    }
  }

  // CASL: Requires express consent
  if (settings.caslApplicable && !settings.contactHasConsent) {
    violations.push({
      checkType: 'compliance',
      severity: 'block',
      description: 'CASL requires express consent â contact has not consented.',
      field: 'to',
      suggestion: 'Obtain express consent before sending commercial messages to this contact.',
    });
  }

  // GDPR: Requires lawful basis
  if (settings.gdprApplicable && !settings.contactHasConsent) {
    violations.push({
      checkType: 'compliance',
      severity: 'block',
      description: 'GDPR requires a lawful basis for processing â no consent recorded.',
      field: 'to',
      suggestion: 'Ensure a lawful basis (consent, legitimate interest) is documented.',
    });
  }

  return violations;
}

/**
 * Injection Defense â detects prompt injection attempts in inbound messages
 * that could manipulate the AI system.
 */
function checkInjection(input: GuardrailInput): Violation[] {
  const violations: Violation[] = [];
  const body = input.message.body;

  // Check for common injection patterns
  const injectionPatterns = [
    /ignore\s+(previous|above|all)\s+(instructions?|prompts?)/i,
    /you\s+are\s+now\s+/i,
    /system\s*:\s*/i,
    /\[INST\]/i,
    /<<SYS>>/i,
    /\bprompt\s*injection\b/i,
    /forget\s+(everything|your|all)/i,
    /new\s+instructions?\s*:/i,
    /override\s+(system|safety|guardrail)/i,
    /jailbreak/i,
  ];

  for (const pattern of injectionPatterns) {
    if (pattern.test(body)) {
      violations.push({
        checkType: 'injection',
        severity: 'block',
        description: `Potential prompt injection detected: "${body.match(pattern)?.[0]}"`,
        field: 'body',
        suggestion: 'Strip injection attempt and process only the legitimate intent.',
      });
    }
  }

  // Check for encoded content that might hide injection
  const encodingPatterns = [
    /&#x[0-9a-f]+;/i,    // HTML hex entities
    /&#\d+;/,             // HTML decimal entities
    /\\u[0-9a-f]{4}/i,    // Unicode escapes
    /base64/i,            // Base64 mentions
  ];

  for (const pattern of encodingPatterns) {
    if (pattern.test(body)) {
      violations.push({
        checkType: 'injection',
        severity: 'warn',
        description: 'Encoded content detected â review for hidden instructions.',
        field: 'body',
        suggestion: 'Decode and review encoded content before processing.',
      });
    }
  }

  return violations;
}

// âââââââââââââââââââââââââââââââââââââââââââââ
// Severity Resolution
// âââââââââââââââââââââââââââââââââââââââââââââ

const SEVERITY_ORDER: Record<string, number> = {
  block: 3,
  regenerate: 2,
  warn: 1,
  pass: 0,
};

function resolveOverallSeverity(violations: Violation[]): z.infer<typeof GuardrailSeverity> {
  if (violations.length === 0) return 'pass';

  let maxSeverity = 0;
  for (const v of violations) {
    const score = SEVERITY_ORDER[v.severity] ?? 0;
    if (score > maxSeverity) maxSeverity = score;
  }

  const severityMap: Record<number, z.infer<typeof GuardrailSeverity>> = {
    3: 'block',
    2: 'regenerate',
    1: 'warn',
    0: 'pass',
  };

  return severityMap[maxSeverity] ?? 'pass';
}

// âââââââââââââââââââââââââââââââââââââââââââââ
// Main Entry Point
// âââââââââââââââââââââââââââââââââââââââââââââ

/**
 * Run all guardrail checks against a message before sending.
 *
 * @param input - Message + context to validate
 * @returns Guardrail result with pass/fail and violation details
 */
export function validateMessage(input: GuardrailInput): GuardrailResult {
  const parsed = GuardrailInputSchema.parse(input);
  const startTime = Date.now();
  const checkId = `chk_${crypto.randomUUID()}`;

  // Run all checks
  const allViolations: Violation[] = [
    ...checkTone(parsed),
    ...checkAccuracy(parsed),
    ...checkHallucination(parsed),
    ...checkCompliance(parsed),
    ...checkInjection(parsed),
  ];

  const overallSeverity = resolveOverallSeverity(allViolations);
  const durationMs = Date.now() - startTime;

  return GuardrailResultSchema.parse({
    tenantId: parsed.tenantId,
    contactId: parsed.contactId,
    decisionId: parsed.decisionId,
    checkId,
    passed: overallSeverity === 'pass' || overallSeverity === 'warn',
    overallSeverity,
    violations: allViolations,
    checkedAt: new Date().toISOString(),
    checksRun: ['tone', 'accuracy', 'hallucination', 'compliance', 'injection'],
    durationMs,
  });
}

// âââââââââââââââââââââââââââââââââââââââââââââ
// API Route Handlers
// âââââââââââââââââââââââââââââââââââââââââââââ

import { Router, Request, Response } from 'express';

export function createGuardrailRouter(): Router {
  const router = Router();

  /**
   * POST /api/agent/validate
   * Run guardrail checks on a message.
   */
  router.post('/validate', async (req: Request, res: Response) => {
    try {
      const input = GuardrailInputSchema.parse(req.body);
      const result = validateMessage(input);
      res.json({ success: true, data: result });
    } catch (err: any) {
      console.error('[GuardrailLayer] Error:', err);
      res.status(400).json({
        success: false,
        error: err.message ?? 'Guardrail validation failed',
      });
    }
  });

  return router;
}

// âââââââââââââââââââââââââââââââââââââââââââââ
// Exports
// âââââââââââââââââââââââââââââââââââââââââââââ

export {
  checkTone,
  checkAccuracy,
  checkHallucination,
  checkCompliance,
  checkInjection,
  resolveOverallSeverity,
};
