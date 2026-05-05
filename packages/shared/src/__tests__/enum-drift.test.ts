/**
 * Generalized enum-drift prevention test for the schema.prisma ↔ @growth/shared
 * zod-mirror pair list, AND shared event-schema regression tests.
 *
 * Relocated from apps/api/src/__tests__/enum-drift.test.ts as part of KAN-737:
 * canonical zod mirrors now live in @growth/shared/src/enums.ts so the
 * assertion belongs alongside the canonical types it guards.
 *
 * RCA documented in memory: feedback_class_fix_not_instance_fix.md.
 *
 * Pattern (Prisma enum ↔ zod mirror — PAIRS list):
 *   - PAIRS is the explicit list of every Prisma enum + its zod mirror
 *   - Adding a new Prisma enum FORCES the next person to add a PAIRS entry
 *   - Each pair becomes its own test case for failure-isolation clarity
 *
 * Pattern (shared event-schema regression — KAN-741 extension):
 *   - Each canonical zod schema in @growth/shared that crosses producer ↔
 *     consumer boundaries gets a regression block here. The block parses
 *     canonical sample payloads against the schema; shape changes that
 *     accidentally break old samples fail their dedicated case.
 *   - Same drift-prevention discipline as PAIRS, different mechanics:
 *     PAIRS asserts enum-set parity; schema regression asserts shape parity.
 *   - Adding a new shared event schema FORCES the next person to add a
 *     regression block here (same tripwire as PAIRS).
 */
import { describe, it, expect } from "vitest";
import {
  ObjectiveType,
  TargetMetric,
  TargetPeriod,
  KnowledgeCategory,
  LeadAssignmentPosture,
  SignalClass,
  StageOutcomeType,
} from "@prisma/client";
import {
  ObjectiveTypeEnum,
  TargetMetricEnum,
  TargetPeriodEnum,
  KnowledgeCategoryEnum,
  LeadAssignmentPostureEnum,
  SignalClassEnum,
  StageOutcomeTypeEnum,
} from "../enums.js";
// KAN-826 — KnowledgeSourceType + KnowledgeSourceStatus PAIRS removed.
// Sprint 11a Architect Spec replaced KAN-706 enum models with string columns
// on the new KnowledgeSource model (sourceType + status are unconstrained
// strings per spec §2; rationale §1.4 + §1.5 admit broader value sets without
// schema migration as ingestion sources expand).

interface EnumPair {
  name: string;
  prismaValues: readonly string[];
  zodValues: readonly string[];
}

const PAIRS: EnumPair[] = [
  {
    name: "ObjectiveType",
    prismaValues: Object.values(ObjectiveType),
    zodValues: ObjectiveTypeEnum.options,
  },
  {
    name: "TargetMetric",
    prismaValues: Object.values(TargetMetric),
    zodValues: TargetMetricEnum.options,
  },
  {
    name: "TargetPeriod",
    prismaValues: Object.values(TargetPeriod),
    zodValues: TargetPeriodEnum.options,
  },
  {
    name: "KnowledgeCategory",
    prismaValues: Object.values(KnowledgeCategory),
    zodValues: KnowledgeCategoryEnum.options,
  },
  {
    name: "LeadAssignmentPosture",
    prismaValues: Object.values(LeadAssignmentPosture),
    zodValues: LeadAssignmentPostureEnum.options,
  },
  {
    name: "SignalClass",
    prismaValues: Object.values(SignalClass),
    zodValues: SignalClassEnum.options,
  },
  {
    name: "StageOutcomeType",
    prismaValues: Object.values(StageOutcomeType),
    zodValues: StageOutcomeTypeEnum.options,
  },
];

describe("enum drift (schema.prisma ↔ @growth/shared zod mirrors)", () => {
  for (const pair of PAIRS) {
    it(`${pair.name}: zod mirror options exactly match Prisma enum values`, () => {
      const zodValues = [...pair.zodValues].sort();
      const prismaValues = [...pair.prismaValues].sort();
      expect(zodValues).toEqual(prismaValues);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Shared event-schema regression — KAN-741 extension to the drift-prevention
// pattern. Each canonical event schema parses canonical sample payloads.
// ─────────────────────────────────────────────────────────────────────────
import { LeadReceivedEventSchema, LeadSourceEnum } from "../lead-received.js";

describe("LeadReceivedEvent schema regression (KAN-741)", () => {
  const CANONICAL_SAMPLES = [
    {
      name: "inbox_email source — happy path with attachments",
      payload: {
        eventId: "evt_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        eventType: "lead.received",
        version: "1.0",
        publishedAt: "2026-04-29T01:00:00.000Z",
        tenantId: "11111111-1111-1111-1111-111111111111",
        contactId: "22222222-2222-2222-2222-222222222222",
        source: "inbox_email",
        metadata: {
          fromAddress: "alice@customer.example",
          subject: "Re: pricing inquiry",
          bodyPreview: "Hi team, wondering about your enterprise tier...",
          attachmentCount: 2,
          leadInboxEventId: "33333333-3333-3333-3333-333333333333",
        },
        receivedAt: "2026-04-29T01:00:00.000Z",
      },
    },
    {
      name: "lead_api source — minimum required fields",
      payload: {
        eventId: "evt_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        eventType: "lead.received",
        version: "1.0",
        publishedAt: "2026-04-29T01:00:00.000Z",
        tenantId: "11111111-1111-1111-1111-111111111111",
        contactId: "44444444-4444-4444-4444-444444444444",
        source: "lead_api",
        metadata: {
          attachmentCount: 0,
          apiKeyTag: "key_test123",
        },
        receivedAt: "2026-04-29T01:00:00.000Z",
      },
    },
  ];

  for (const sample of CANONICAL_SAMPLES) {
    it(`parses cleanly: ${sample.name}`, () => {
      const parsed = LeadReceivedEventSchema.parse(sample.payload);
      expect(parsed.eventType).toBe("lead.received");
      expect(parsed.version).toBe("1.0");
    });
  }

  it("LeadSourceEnum covers the documented producer set", () => {
    expect([...LeadSourceEnum.options].sort()).toEqual([
      "crm_sync",
      "form_fill",
      "import",
      "inbox_email",
      "lead_api",
    ]);
  });

  it("rejects payload with wrong eventType literal", () => {
    expect(() =>
      LeadReceivedEventSchema.parse({ ...CANONICAL_SAMPLES[0].payload, eventType: "lead.received.v2" }),
    ).toThrow();
  });

  it("rejects payload with wrong version literal", () => {
    expect(() =>
      LeadReceivedEventSchema.parse({ ...CANONICAL_SAMPLES[0].payload, version: "2.0" }),
    ).toThrow();
  });

  it("rejects payload with unknown source value", () => {
    expect(() =>
      LeadReceivedEventSchema.parse({
        ...CANONICAL_SAMPLES[0].payload,
        source: "carrier_pigeon",
      }),
    ).toThrow();
  });

  it("rejects payload with non-UUID tenantId or contactId", () => {
    expect(() =>
      LeadReceivedEventSchema.parse({ ...CANONICAL_SAMPLES[0].payload, tenantId: "not-a-uuid" }),
    ).toThrow();
    expect(() =>
      LeadReceivedEventSchema.parse({ ...CANONICAL_SAMPLES[0].payload, contactId: "not-a-uuid" }),
    ).toThrow();
  });
});
