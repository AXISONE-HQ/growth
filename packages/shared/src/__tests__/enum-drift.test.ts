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
  // KAN-1000 Slice 2 fix-forward — adding these to PAIRS prevents the
  // class of drift that hit /campaigns in PROD (Zod enum diverged from
  // Prisma → LLM emitted valid-against-Zod but invalid-against-Prisma
  // values → leaked raw Prisma error to UI).
  LifecycleStage,
  ContactSource,
  // KAN-1001 Campaign Slice 0 — proactive PAIRS coverage for the 4 new
  // Campaign-layer Prisma enums shipped by Phase 1 migration.
  CampaignStrategy,
  CampaignAudienceMode,
  CampaignStatus,
  CampaignMemberSource,
} from "@prisma/client";
import {
  ObjectiveTypeEnum,
  TargetMetricEnum,
  TargetPeriodEnum,
  KnowledgeCategoryEnum,
  LeadAssignmentPostureEnum,
  SignalClassEnum,
  StageOutcomeTypeEnum,
  LifecycleStageEnum,
  ContactSourceEnum,
  CampaignAudienceModeEnum,
  CampaignStatusEnum,
  CampaignMemberSourceEnum,
} from "../enums.js";
import { CampaignStrategyEnum } from "../campaign-proposal.js";
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
  // KAN-1000 Slice 2 fix-forward — newly added PAIRS entries.
  {
    name: "LifecycleStage",
    prismaValues: Object.values(LifecycleStage),
    zodValues: LifecycleStageEnum.options,
  },
  {
    name: "ContactSource",
    prismaValues: Object.values(ContactSource),
    zodValues: ContactSourceEnum.options,
  },
  // KAN-1001 Campaign Slice 0 — proactive PAIRS for the 4 new
  // Campaign-layer enums. Filed in the same PR as the migration that
  // creates them, so the discipline can't slip.
  {
    name: "CampaignStrategy",
    prismaValues: Object.values(CampaignStrategy),
    zodValues: CampaignStrategyEnum.options,
  },
  {
    name: "CampaignAudienceMode",
    prismaValues: Object.values(CampaignAudienceMode),
    zodValues: CampaignAudienceModeEnum.options,
  },
  {
    name: "CampaignStatus",
    prismaValues: Object.values(CampaignStatus),
    zodValues: CampaignStatusEnum.options,
  },
  {
    name: "CampaignMemberSource",
    prismaValues: Object.values(CampaignMemberSource),
    zodValues: CampaignMemberSourceEnum.options,
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
      name: "email_inbox source — happy path with attachments",
      payload: {
        eventId: "evt_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        eventType: "lead.received",
        version: "1.0",
        publishedAt: "2026-04-29T01:00:00.000Z",
        tenantId: "11111111-1111-1111-1111-111111111111",
        contactId: "22222222-2222-2222-2222-222222222222",
        source: "email_inbox",
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
      "email_inbox",
      "form_fill",
      "import",
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

  // ── M3-2.5b — inboundHeaders extension (additive + optional) ──
  it("M3-2.5b — accepts payload WITHOUT inboundHeaders (back-compat)", () => {
    const parsed = LeadReceivedEventSchema.parse(CANONICAL_SAMPLES[0].payload);
    expect(parsed.metadata.inboundHeaders).toBeUndefined();
  });

  it("M3-2.5b — accepts payload WITH inboundHeaders (full shape)", () => {
    const parsed = LeadReceivedEventSchema.parse({
      ...CANONICAL_SAMPLES[0].payload,
      metadata: {
        ...CANONICAL_SAMPLES[0].payload.metadata,
        inboundHeaders: {
          messageId: "<inbound-msg-id@gmail.com>",
          inReplyTo: "<outbound-msg-id@resend.dev>",
          references: "<r1@d1> <r2@d2>",
        },
      },
    });
    expect(parsed.metadata.inboundHeaders).toEqual({
      messageId: "<inbound-msg-id@gmail.com>",
      inReplyTo: "<outbound-msg-id@resend.dev>",
      references: "<r1@d1> <r2@d2>",
    });
  });

  it("M3-2.5b — inboundHeaders fields all optional individually", () => {
    const parsed = LeadReceivedEventSchema.parse({
      ...CANONICAL_SAMPLES[0].payload,
      metadata: {
        ...CANONICAL_SAMPLES[0].payload.metadata,
        inboundHeaders: { inReplyTo: "<o@r.dev>" }, // only In-Reply-To
      },
    });
    expect(parsed.metadata.inboundHeaders?.inReplyTo).toBe("<o@r.dev>");
    expect(parsed.metadata.inboundHeaders?.messageId).toBeUndefined();
    expect(parsed.metadata.inboundHeaders?.references).toBeUndefined();
  });

  // ── KAN-1036 — replyToken extension (additive + optional) ──
  it("KAN-1036 — accepts payload WITHOUT replyToken (back-compat for pre-KAN-1036 producers)", () => {
    const parsed = LeadReceivedEventSchema.parse(CANONICAL_SAMPLES[0].payload);
    expect(parsed.metadata.replyToken).toBeUndefined();
  });

  it("KAN-1036 — accepts payload WITH valid 16-char hex replyToken (canonical shape)", () => {
    const tok = "abcd1234ef567890";
    const parsed = LeadReceivedEventSchema.parse({
      ...CANONICAL_SAMPLES[0].payload,
      metadata: { ...CANONICAL_SAMPLES[0].payload.metadata, replyToken: tok },
    });
    expect(parsed.metadata.replyToken).toBe(tok);
  });

  it("KAN-1036 — rejects malformed replyToken (wrong length)", () => {
    expect(() =>
      LeadReceivedEventSchema.parse({
        ...CANONICAL_SAMPLES[0].payload,
        metadata: { ...CANONICAL_SAMPLES[0].payload.metadata, replyToken: "tooshort" },
      }),
    ).toThrow();
  });

  it("KAN-1036 — rejects malformed replyToken (non-hex charset)", () => {
    expect(() =>
      LeadReceivedEventSchema.parse({
        ...CANONICAL_SAMPLES[0].payload,
        metadata: {
          ...CANONICAL_SAMPLES[0].payload.metadata,
          replyToken: "ABCDEFGHIJKLMNOP", // uppercase = non-hex per the regex
        },
      }),
    ).toThrow();
  });

  // §0.2 — Pub/Sub serialize/deserialize round-trip.
  it("KAN-1036 §0.2 — replyToken round-trips through Pub/Sub JSON serialization", () => {
    const tok = "deadbeefcafe1234";
    const payload = {
      ...CANONICAL_SAMPLES[0].payload,
      metadata: { ...CANONICAL_SAMPLES[0].payload.metadata, replyToken: tok },
    };
    // Simulate the Pub/Sub wire round-trip: producer JSON-stringify, base64-
    // encode, base64-decode, JSON-parse, Zod-validate. The wire formats live
    // in apps/api/src/subscribers/lead-received-push.ts:466 and
    // apps/connectors/src/webhooks/resend-inbound.ts:548; this test confirms
    // the replyToken survives both directions cleanly.
    const wire = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
    const decoded = JSON.parse(Buffer.from(wire, "base64").toString("utf8"));
    const parsed = LeadReceivedEventSchema.parse(decoded);
    expect(parsed.metadata.replyToken).toBe(tok);
    // And re-stringifying the parsed Zod output preserves the field.
    const re = JSON.parse(JSON.stringify(parsed));
    expect(re.metadata.replyToken).toBe(tok);
  });
});
