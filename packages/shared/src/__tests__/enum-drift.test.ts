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

  // ── KAN-1140 Phase 3 PR 6 — parseCorrections + parseConfidenceOverride
  // (additive + optional; backs the synthetic-republish path from
  // recommendations.reclassify) ──
  it("KAN-1140 Phase 3 PR 6 — accepts payload WITHOUT parseCorrections/parseConfidenceOverride (back-compat)", () => {
    const parsed = LeadReceivedEventSchema.parse(CANONICAL_SAMPLES[0].payload);
    expect(parsed.metadata.parseCorrections).toBeUndefined();
    expect(parsed.metadata.parseConfidenceOverride).toBeUndefined();
  });

  it("KAN-1140 Phase 3 PR 6 — round-trips parseCorrections + parseConfidenceOverride through Pub/Sub JSON", () => {
    const payload = {
      ...CANONICAL_SAMPLES[0].payload,
      metadata: {
        ...CANONICAL_SAMPLES[0].payload.metadata,
        parseCorrections: {
          format: "adf",
          language: "fr",
          vendor: "formspree",
        },
        parseConfidenceOverride: true,
      },
    };
    const wire = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
    const decoded = JSON.parse(Buffer.from(wire, "base64").toString("utf8"));
    const parsed = LeadReceivedEventSchema.parse(decoded);
    expect(parsed.metadata.parseCorrections).toEqual({
      format: "adf",
      language: "fr",
      vendor: "formspree",
    });
    expect(parsed.metadata.parseConfidenceOverride).toBe(true);
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

// ─────────────────────────────────────────────────────────────────────────
// KAN-1037-PR3 hotfix — ContactRepliedEvent schema regression with
// REAL PRISMA ID SHAPES. Mirrors the KAN-741 LeadReceivedEvent regression
// block but uses cuid-shaped fixture IDs for Deal + Engagement IDs (which
// are `String @id @default(cuid())` in `packages/db/prisma/schema.prisma`)
// and uuid-shaped fixture IDs for Tenant + Contact (which are uuid). This
// is the test that WOULD have caught the post-PR3-deploy publish-failed
// crash where a real Engagement cuid failed the schema's `.uuid()` validator
// — see `feedback_class_fix_not_instance_fix.md` for the discipline
// correction.
//
// Empirical anchor: the publish at 2026-05-31 13:41:34 UTC threw on
// `cmpttw3nu000f114x15xs082d` (a real Engagement cuid) against a schema
// that declared `inboundEngagementId: z.string().uuid()`. The IIFE's
// outer catch swallowed the throw + warn-logged but no `contact.replied`
// event ever fired, blocking the downstream subscriber chain. Hotfix
// flips both `inboundEngagementId` + `outboundEngagementId` + `dealId`
// from `.uuid()` to `.min(1)` to match the Prisma cuid convention (same
// shape as `decisionId` per KAN-657 doctrine).
// ─────────────────────────────────────────────────────────────────────────
import {
  ContactRepliedEventSchema,
  buildContactRepliedEvent,
} from "../contact-replied.js";

describe("ContactRepliedEvent schema regression (KAN-1037-PR3 hotfix)", () => {
  /**
   * Canonical sample mirroring REAL PROD shapes:
   *   - tenantId / contactId / inboundEngagementId / outboundEngagementId
   *     reflect the actual Prisma id types from
   *     `packages/db/prisma/schema.prisma` (uuid vs cuid).
   *   - Cuid samples are shaped like real Prisma cuids:
   *     `cmpttw3nu000f114x15xs082d` is verbatim from the 2026-05-31 13:41
   *     UTC failure log; we use it as the canonical "this MUST parse"
   *     fixture so a future schema regression to `.uuid()` fails this
   *     test before the change can ship.
   */
  const REAL_DEAL_CUID = "cmot2yl720002q1qyh63iy5rc";
  const REAL_INBOUND_ENGAGEMENT_CUID = "cmpttw3nu000f114x15xs082d";
  const REAL_OUTBOUND_ENGAGEMENT_CUID = "cmpttsj3e000c114x9l4r6m7n";
  const REAL_DECISION_CUID = "10a15b5b-af88-4320-9797-27eee689c196";

  const CANONICAL_SAMPLE = {
    eventId: "feedbeef-cafe-babe-dead-feedface0000",
    eventType: "contact.replied",
    version: "1.0",
    publishedAt: "2026-05-31T13:41:34.000Z",
    tenantId: "9ca85088-f65b-4bac-b098-fff742281ede", // uuid (Tenant.id)
    contactId: "a0b73f88-7a8f-4860-bb3e-46e089ff0268", // uuid (Contact.id)
    dealId: REAL_DEAL_CUID, // cuid (Deal.id) — was .uuid() pre-hotfix
    decisionId: REAL_DECISION_CUID, // cuid per KAN-657
    inboundEngagementId: REAL_INBOUND_ENGAGEMENT_CUID, // cuid (Engagement.id)
    outboundEngagementId: REAL_OUTBOUND_ENGAGEMENT_CUID, // cuid (Engagement.id)
    replyText: "Yes — Tuesday afternoon works for the call.",
    replyReceivedAt: "2026-05-31T13:41:12.000Z",
    metadata: {
      senderEmail: "fred@axisone.ca",
      subjectLine: "Re: TestPayload - Next Steps Forward",
      threadDepth: 1,
    },
  };

  it("parses cleanly with REAL Prisma cuid shapes for Deal + Engagement IDs", () => {
    // The load-bearing assertion. Pre-hotfix this throws on EVERY field
    // declared `.uuid()` against a real cuid.
    const parsed = ContactRepliedEventSchema.parse(CANONICAL_SAMPLE);
    expect(parsed.eventType).toBe("contact.replied");
    expect(parsed.version).toBe("1.0");
    expect(parsed.dealId).toBe(REAL_DEAL_CUID);
    expect(parsed.decisionId).toBe(REAL_DECISION_CUID);
    expect(parsed.inboundEngagementId).toBe(REAL_INBOUND_ENGAGEMENT_CUID);
    expect(parsed.outboundEngagementId).toBe(REAL_OUTBOUND_ENGAGEMENT_CUID);
  });

  it("buildContactRepliedEvent produces a parseable payload with real cuid IDs", () => {
    // End-to-end: builder calls .parse() internally; this exercises the
    // exact code path the publisher hits in lead-received-push.ts at
    // emitContactRepliedIfCorrelated.
    const event = buildContactRepliedEvent({
      tenantId: CANONICAL_SAMPLE.tenantId,
      contactId: CANONICAL_SAMPLE.contactId,
      dealId: REAL_DEAL_CUID,
      decisionId: REAL_DECISION_CUID,
      inboundEngagementId: REAL_INBOUND_ENGAGEMENT_CUID,
      outboundEngagementId: REAL_OUTBOUND_ENGAGEMENT_CUID,
      replyText: CANONICAL_SAMPLE.replyText,
      replyReceivedAt: CANONICAL_SAMPLE.replyReceivedAt,
      metadata: CANONICAL_SAMPLE.metadata,
    });
    expect(event.eventType).toBe("contact.replied");
    expect(event.dealId).toBe(REAL_DEAL_CUID);
    expect(event.inboundEngagementId).toBe(REAL_INBOUND_ENGAGEMENT_CUID);
    expect(event.outboundEngagementId).toBe(REAL_OUTBOUND_ENGAGEMENT_CUID);
  });

  it("nullable dealId + outboundEngagementId both accept null (pre-KAN-1044 publisher shape)", () => {
    // PR3 publisher passes outboundEngagementId: null per the honest-
    // nullable shape until KAN-1044 lands. dealId is also nullable when
    // the originator has no open Deal.
    const event = buildContactRepliedEvent({
      tenantId: CANONICAL_SAMPLE.tenantId,
      contactId: CANONICAL_SAMPLE.contactId,
      dealId: null,
      decisionId: REAL_DECISION_CUID,
      inboundEngagementId: REAL_INBOUND_ENGAGEMENT_CUID,
      outboundEngagementId: null,
      replyText: CANONICAL_SAMPLE.replyText,
      replyReceivedAt: CANONICAL_SAMPLE.replyReceivedAt,
      metadata: CANONICAL_SAMPLE.metadata,
    });
    expect(event.dealId).toBeNull();
    expect(event.outboundEngagementId).toBeNull();
  });

  it("still rejects empty-string IDs (the .min(1) floor catches accidental empties)", () => {
    expect(() =>
      ContactRepliedEventSchema.parse({
        ...CANONICAL_SAMPLE,
        inboundEngagementId: "",
      }),
    ).toThrow();
    expect(() =>
      ContactRepliedEventSchema.parse({ ...CANONICAL_SAMPLE, decisionId: "" }),
    ).toThrow();
  });

  it("still rejects non-uuid tenantId / contactId (uuid-typed fields stay strict)", () => {
    // Defense-in-depth: the hotfix loosens ONLY the cuid-typed fields.
    // Tenant + Contact remain uuid-validated.
    expect(() =>
      ContactRepliedEventSchema.parse({
        ...CANONICAL_SAMPLE,
        tenantId: "not-a-uuid",
      }),
    ).toThrow();
    expect(() =>
      ContactRepliedEventSchema.parse({
        ...CANONICAL_SAMPLE,
        contactId: REAL_INBOUND_ENGAGEMENT_CUID, // a cuid in a uuid field
      }),
    ).toThrow();
  });

  // ─── KAN-1056 — threadDepth schema relax (.min(1) → .min(0)) ────────────
  // Phase B PR I un-puts the PR3-era hardcode at the publisher; the schema
  // must now accept depth=0 so a publish with zero prior outbounds doesn't
  // throw inside buildContactRepliedEvent.parse(...) at publisher emit time.
  //
  // In practice the reply path always sees ≥1 (correlation reached the
  // publisher by reply_token, so a prior outbound exists), but the schema
  // relax forward-compats with Phase B+ correlation paths that may not
  // require a prior-outbound row to exist.

  it("KAN-1056 — accepts threadDepth=0 (schema relax for forward-compat with non-reply correlation paths)", () => {
    const parsed = ContactRepliedEventSchema.parse({
      ...CANONICAL_SAMPLE,
      metadata: { ...CANONICAL_SAMPLE.metadata, threadDepth: 0 },
    });
    expect(parsed.metadata.threadDepth).toBe(0);
  });

  it("KAN-1056 — buildContactRepliedEvent round-trips threadDepth=0 without throwing at .parse()", () => {
    // The publisher's emit path calls buildContactRepliedEvent which
    // invokes ContactRepliedEventSchema.parse internally — if the schema
    // floor reverts to .min(1), this test fires loudly because the
    // publisher's IIFE catch-and-warn would silently drop every
    // matchedDealId-zero-prior-outbound publish in production.
    const event = buildContactRepliedEvent({
      tenantId: CANONICAL_SAMPLE.tenantId,
      contactId: CANONICAL_SAMPLE.contactId,
      dealId: REAL_DEAL_CUID,
      decisionId: REAL_DECISION_CUID,
      inboundEngagementId: REAL_INBOUND_ENGAGEMENT_CUID,
      outboundEngagementId: REAL_OUTBOUND_ENGAGEMENT_CUID,
      replyText: CANONICAL_SAMPLE.replyText,
      replyReceivedAt: CANONICAL_SAMPLE.replyReceivedAt,
      metadata: { ...CANONICAL_SAMPLE.metadata, threadDepth: 0 },
    });
    expect(event.metadata.threadDepth).toBe(0);
  });

  it("KAN-1056 — still rejects negative threadDepth (the .min(0) floor catches sign errors)", () => {
    // Defense-in-depth: relaxing from 1 to 0 should NOT open the gate to
    // -1, -42, etc. The schema's `.int().min(0)` keeps the floor.
    expect(() =>
      ContactRepliedEventSchema.parse({
        ...CANONICAL_SAMPLE,
        metadata: { ...CANONICAL_SAMPLE.metadata, threadDepth: -1 },
      }),
    ).toThrow();
  });

  it("KAN-1056 — back-compat: threadDepth=1 still parses unchanged", () => {
    // Schema relax MUST be a pure expansion — existing depth=1 payloads
    // (PR3-era publishers + all current contact-replied-push test fixtures
    // at L190/338 + enum-drift CANONICAL_SAMPLE) keep parsing.
    const parsed = ContactRepliedEventSchema.parse(CANONICAL_SAMPLE);
    expect(parsed.metadata.threadDepth).toBe(1);
  });
});
