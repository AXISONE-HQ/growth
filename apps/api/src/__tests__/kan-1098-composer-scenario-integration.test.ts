/**
 * KAN-1098 (Cluster IV-B PR III) — Sentinel test: scenario + persona
 * injection MUST flow through both production message-construction paths.
 *
 * Failure modes the sentinel locks against:
 *   1. Behavioral: composer's `composeMessage` stops injecting
 *      `scenario.promptBlock` into its userPrompt (would regress KAN-1094)
 *   2. Behavioral: shaper's `buildShapePrompt` stops injecting
 *      `scenario.promptBlock` (the KAN-1098 wiring)
 *   3. Behavioral: shaper's `buildShapePrompt` stops rendering the persona
 *      voice line when a persona is provided
 *   4. Behavioral: helper's email-only channel filter (Phase 1 item 6 lock)
 *      stops returning `scenario: null` for non-email channels
 *   5. Structural: a NEW dispatch subscriber adds composeMessage/shapeMessage
 *      without wiring resolveScenarioContext (the catch that would have
 *      surfaced KAN-1094's omission at CI rather than smoke time)
 *
 * Per `feedback_phase_1_must_enumerate_all_callers_of_modified_service_helpers.md`
 * — this test is the procedural Phase 1 enumeration discipline made
 * machine-enforced: future authors get a CI failure instead of a smoke catch.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { PrismaClient } from '@prisma/client';

// ─────────────────────────────────────────────
// Behavioral tests — prompt builders render the blocks correctly
// ─────────────────────────────────────────────

// Mock llm-client.complete BEFORE any composer/shaper import so the spy
// captures the userPrompt that gets sent to the LLM. Pattern lifted from
// `m3-1b-composer-gap-context.test.ts`.
const completeMock = vi.fn(async (input: { userPrompt: string }) => {
  void input.userPrompt;
  return {
    text: JSON.stringify({
      subject: 'Sentinel-test echo',
      body: 'Sentinel-test echo body',
    }),
    llmInputTokens: 100,
    llmOutputTokens: 50,
    modelTier: 'cheap',
  };
});
vi.mock('../../../../packages/api/src/services/llm-client.js', () => ({
  complete: completeMock,
}));

// KAN-689 cohort hygiene — variable-specifier dynamic imports bypass TS6059
// for the apps/api → packages/api cross-rootDir bridge. Literal-string
// `await import('...')` drags the imported module into apps/api's rootDir
// graph (the same constraint that governs production subscribers). Stash
// each spec in a `const` so the static analyzer can't pin it to a literal.
//
// `typeof import('literal')` ALSO triggers TS6059 (verified during KAN-1098
// fixup), so static type-check on the test-side imports is sacrificed.
// Acceptable cost: assertions are runtime-shape based (string substring
// match on rendered prompts, `expect(...).toContain(...)` style) — no
// static-type-driven assertions on the imported symbols. Functions are
// typed `any` after destructure; runtime behavior is identical.
const messageComposerSpec = '../../../../packages/api/src/services/message-composer.js';
const { composeMessage } = await import(messageComposerSpec);
const messageShaperSpec = '../../../../packages/api/src/services/message-shaper.js';
const { buildShapePrompt } = await import(messageShaperSpec);
const { DEFAULT_SCENARIOS_GENERIC_B2B, DEFAULT_PERSONA_GENERIC_B2B } = await import(
  '@growth/shared'
);
const scenarioResolutionContextSpec = '../../../../packages/api/src/services/scenario-resolution-context.js';
const { resolveScenarioContext } = await import(scenarioResolutionContextSpec);

function makeComposerStubPrisma(): PrismaClient {
  return {
    contact: {
      findFirst: async () => ({
        firstName: 'Sarah',
        lastName: 'Test',
        email: 'sarah@test.local',
      }),
    },
    brainSnapshot: { findFirst: async () => null },
  } as unknown as PrismaClient;
}

function lastComposerUserPrompt(): string {
  const args = completeMock.mock.calls.at(-1)![0] as { userPrompt: string };
  return args.userPrompt;
}

// Pick a known scenario from the default registry — guarantees the helper
// + composer + shaper all key off the same canonical promptBlock string.
const QUALIFY_INITIAL_INBOUND = DEFAULT_SCENARIOS_GENERIC_B2B.find(
  (s) =>
    s.persona === 'Generic B2B SaaS' &&
    s.phase === 'qualify' &&
    s.trigger === 'initial_inbound',
);
if (!QUALIFY_INITIAL_INBOUND) {
  throw new Error(
    '[kan-1098-sentinel] Fixture invariant violated: qualify×initial_inbound scenario missing from DEFAULT_SCENARIOS_GENERIC_B2B',
  );
}

// Distinct substring chosen from the actual promptBlock so the assertion
// fails loudly if registry phrasing drifts (this is intentional — phrasing
// drift IS a test failure since downstream LLM behavior depends on it).
const QUALIFY_PROMPT_SUBSTRING = 'CURIOUS open-ended question';

describe('KAN-1098 behavioral — composer path scenarioBlock injection', () => {
  it('Test B: composeMessage with matched scenario renders scenarioBlock containing promptBlock', async () => {
    completeMock.mockClear();
    await composeMessage(makeComposerStubPrisma(), {
      tenantId: 'tenant-a',
      contactId: 'contact-a',
      decisionId: 'd-1',
      instruction: 'follow up',
      publicWebhookBaseUrl: 'https://growth.axisone.ca',
      scenario: QUALIFY_INITIAL_INBOUND,
    });
    const prompt = lastComposerUserPrompt();
    expect(prompt).toMatch(/Scenario guidance/);
    expect(prompt).toContain(QUALIFY_PROMPT_SUBSTRING);
  });

  it('composeMessage without scenario omits scenarioBlock entirely (legacy posture preserved)', async () => {
    completeMock.mockClear();
    await composeMessage(makeComposerStubPrisma(), {
      tenantId: 'tenant-a',
      contactId: 'contact-a',
      decisionId: 'd-1',
      instruction: 'follow up',
      publicWebhookBaseUrl: 'https://growth.axisone.ca',
    });
    const prompt = lastComposerUserPrompt();
    expect(prompt).not.toMatch(/Scenario guidance/);
    expect(prompt).not.toContain(QUALIFY_PROMPT_SUBSTRING);
  });
});

describe('KAN-1098 behavioral — shaper path scenarioBlock + personaBlock injection', () => {
  // buildShapePrompt is a pure function — exercise it directly with a
  // fixture-built input rather than spinning up the full shapeMessage
  // pipeline + LLM mock. The integration path through shapeMessage is
  // structurally guaranteed by the loader-test below + manual smoke.
  const fixtureInput = {
    contact: {
      firstName: 'Sarah',
      lastName: 'Test',
      email: 'sarah@test.local',
      companyName: 'Acme Inc',
    },
    pipeline: {
      name: 'Default Sales Pipeline',
      objectiveType: 'warm_up_lead',
      objectiveDescription: null,
    },
    currentStage: { name: 'New', outcomeType: 'open' as const },
    brainReasoning: 'Engine recommends warm-up follow-up.',
    channel: 'email' as const,
    tone: 'curious' as const,
    recentOutbound: [],
    recentInbound: null,
  };

  it('Test A: buildShapePrompt with matched scenario renders scenarioBlock containing promptBlock', () => {
    const prompt = buildShapePrompt({
      ...fixtureInput,
      scenario: QUALIFY_INITIAL_INBOUND,
    });
    expect(prompt).toMatch(/## Scenario guidance/);
    expect(prompt).toContain(QUALIFY_PROMPT_SUBSTRING);
  });

  it('Test C structural-counterpart: buildShapePrompt with scenario=null omits scenarioBlock entirely', () => {
    const prompt = buildShapePrompt({
      ...fixtureInput,
      scenario: null,
    });
    expect(prompt).not.toMatch(/## Scenario guidance/);
    expect(prompt).not.toContain(QUALIFY_PROMPT_SUBSTRING);
  });

  it('Test D: buildShapePrompt with persona renders personaBlock with Voice line (DEFAULT empty arrays → only Voice renders)', () => {
    const prompt = buildShapePrompt({
      ...fixtureInput,
      persona: DEFAULT_PERSONA_GENERIC_B2B,
    });
    expect(prompt).toMatch(/## Persona voice guidance/);
    expect(prompt).toContain(`Voice: ${DEFAULT_PERSONA_GENERIC_B2B.voice}`);
    // DEFAULT_PERSONA_GENERIC_B2B has empty brandAttributes + voiceExamples
    // per discipline-pin-1 — those lines must NOT render.
    expect(prompt).not.toMatch(/Brand attributes:/);
    expect(prompt).not.toMatch(/Voice examples:/);
  });

  it('buildShapePrompt with branded persona renders brandAttributes + voiceExamples lines', () => {
    const prompt = buildShapePrompt({
      ...fixtureInput,
      persona: {
        name: 'Acme Branded',
        voice: 'witty and confident',
        toneDefaults: {},
        brandAttributes: ['fast', 'reliable'],
        voiceExamples: ["What's the catch?", 'Show me the numbers.'],
      },
    });
    expect(prompt).toContain('Voice: witty and confident');
    expect(prompt).toContain('Brand attributes: fast, reliable');
    expect(prompt).toContain('Voice examples:');
    expect(prompt).toContain('- "What\'s the catch?"');
  });

  it('buildShapePrompt without persona omits personaBlock entirely (legacy + replay caller posture preserved)', () => {
    const prompt = buildShapePrompt(fixtureInput);
    expect(prompt).not.toMatch(/## Persona voice guidance/);
    expect(prompt).not.toMatch(/Voice: /);
  });
});

describe('KAN-1098 behavioral — helper email-only channel filter (Phase 1 item 6)', () => {
  // Minimal prisma stub that lets the helper's resolveBlueprintPersona +
  // resolveEnginePhases + engagement.groupBy + contactSubObjectiveGapState
  // calls all complete with safe defaults. Channel filter triggers BEFORE
  // scenario lookup, so the lookup machinery isn't strictly needed for
  // the sms path — but we exercise the full path to lock the filter
  // semantics.
  function makeHelperStubPrisma(): PrismaClient {
    return {
      tenant: {
        findUnique: async () => ({
          personaOverride: null,
          blueprint: { persona: null },
        }),
      },
      blueprint: { findFirst: async () => null },
      engagement: {
        groupBy: async () => [],
      },
      contactSubObjectiveGapState: {
        findMany: async () => [],
      },
      auditLog: { create: async () => ({ id: 'a-1' }) },
    } as unknown as PrismaClient;
  }

  it('Test C: resolveScenarioContext with channel="sms" returns scenario=null regardless of tuple match', async () => {
    const ctx = await resolveScenarioContext(makeHelperStubPrisma(), {
      tenantId: 'tenant-a',
      contactId: 'contact-a',
      dealId: 'deal-a',
      channel: 'sms',
      actionType: 'send_follow_up',
    });
    expect(ctx.scenario).toBeNull();
    // Persona + phase still resolve so the caller can use them for
    // downstream rendering decisions (telemetry, audit) if it wants.
    expect(ctx.persona).toBeDefined();
  });

  it('resolveScenarioContext with channel="meta_messenger" also returns scenario=null', async () => {
    const ctx = await resolveScenarioContext(makeHelperStubPrisma(), {
      tenantId: 'tenant-a',
      contactId: 'contact-a',
      dealId: 'deal-a',
      channel: 'meta_messenger',
      actionType: 'send_follow_up',
    });
    expect(ctx.scenario).toBeNull();
  });
});

// ─────────────────────────────────────────────
// Structural sentinel — would have caught KAN-1094's omission at CI
// ─────────────────────────────────────────────

describe('KAN-1098 structural sentinel — every composer/shaper invocation site wires resolveScenarioContext', () => {
  // __dirname = apps/api/src/__tests__; 4 levels up = repo root.
  const REPO_ROOT = resolve(__dirname, '../../../../');
  const SCAN_DIRS = [
    join(REPO_ROOT, 'apps/api/src/subscribers'),
    join(REPO_ROOT, 'apps/api/src/internal'),
  ];

  // Dispatch-site patterns that trigger the "scenario context required" rule.
  const PROMPT_BUILDER_PATTERNS: Array<{ pattern: RegExp; description: string }> = [
    {
      pattern: /\bcomposeMessage\s*\(/g,
      description: 'composeMessage call (legacy action.decided composer path)',
    },
    {
      pattern: /\bshapeMessage\s*\(/g,
      description: 'shapeMessage call (Brain-driven Phase 2 shaper path)',
    },
  ];

  // Files that legitimately reference these APIs but don't construct
  // prompts at runtime (e.g. cron-deferred-send replays already-composed
  // bodies — scenario injection happened at T1).
  const ALLOWLIST: Array<{ pathSuffix: string; reason: string }> = [
    {
      pathSuffix: 'apps/api/src/internal/cron-deferred-send.ts',
      reason:
        'KAN-814 cron handler: re-dispatches the already-composed `deferred_sends.payload.composed.body` via publishActionSend. No prompt construction at re-dispatch — scenario injection happened at T1.',
    },
  ];

  function listTsFiles(dir: string): string[] {
    const out: string[] = [];
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return out;
    }
    for (const name of entries) {
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) {
        if (name === '__tests__' || name === 'node_modules' || name === 'dist') continue;
        out.push(...listTsFiles(full));
      } else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) {
        out.push(full);
      }
    }
    return out;
  }

  function stripComments(src: string): string {
    let out = src.replace(/\/\*[\s\S]*?\*\//g, '');
    out = out.replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');
    return out;
  }

  function fileEngagesScenarioHelper(src: string): boolean {
    const stripped = stripComments(src);
    // Import path may be static OR variable-specifier dynamic import.
    const importsCanonically =
      /from\s+['"][^'"]*scenario-resolution-context[^'"]*['"]/.test(stripped) ||
      /['"][^'"]*scenario-resolution-context[^'"]*\.js['"]/.test(stripped);
    const callsResolve = /\bresolveScenarioContext\s*\(/.test(stripped);
    return importsCanonically && callsResolve;
  }

  const allFiles = SCAN_DIRS.flatMap(listTsFiles);

  it('scan-scope check: at least one source file found', () => {
    expect(allFiles.length).toBeGreaterThan(0);
  });

  for (const { pattern, description } of PROMPT_BUILDER_PATTERNS) {
    it(`every "${description}" site is in a file that engages resolveScenarioContext`, () => {
      const violations: string[] = [];

      for (const file of allFiles) {
        const relPath = file.replace(REPO_ROOT + '/', '');
        const isAllowlisted = ALLOWLIST.some((a) => relPath.endsWith(a.pathSuffix));
        if (isAllowlisted) continue;

        const src = readFileSync(file, 'utf8');
        const stripped = stripComments(src);
        const re = new RegExp(pattern.source, pattern.flags);
        let m: RegExpExecArray | null;
        while ((m = re.exec(stripped)) !== null) {
          if (!fileEngagesScenarioHelper(src)) {
            const origIdx = src.indexOf(m[0]);
            const lineNo =
              origIdx >= 0
                ? src.slice(0, origIdx).split('\n').length
                : stripped.slice(0, m.index).split('\n').length;
            violations.push(
              `${relPath}:${lineNo} — ${description}, but file does NOT import or call resolveScenarioContext`,
            );
          }
        }
      }

      if (violations.length > 0) {
        const msg =
          `\n\n=== KAN-1098 SCENARIO-CONTEXT NO-BYPASS GATE VIOLATIONS ===\n` +
          violations.map((v) => `  ✗ ${v}`).join('\n') +
          `\n\nEvery prompt-construction site (composeMessage / shapeMessage) MUST be in a file\n` +
          `that calls resolveScenarioContext. Scenario + persona injection is the canonical\n` +
          `prompt-enrichment surface for Cluster IV-B (KAN-1093 persona + KAN-1094 scenarios).\n\n` +
          `If you are adding a new subscriber or dispatch path:\n` +
          `  1. Import resolveScenarioContext from packages/api/src/services/scenario-resolution-context.ts\n` +
          `     (or dynamic-import the .js spec for cross-rootDir bypass — KAN-689 cohort)\n` +
          `  2. Call resolveScenarioContext(prisma, { tenantId, contactId, dealId, channel, actionType })\n` +
          `     BEFORE composeMessage / shapeMessage\n` +
          `  3. Thread context.scenario + context.persona into the prompt-builder input\n\n` +
          `If you have a genuine reason to bypass (e.g., the file replays already-composed\n` +
          `payloads instead of constructing fresh prompts), add an allowlist entry at the top\n` +
          `of this file with a written reason and Jira reference.\n`;
        throw new Error(msg);
      }
    });
  }
});
