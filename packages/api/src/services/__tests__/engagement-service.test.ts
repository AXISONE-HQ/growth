/**
 * KAN-786 Phase 1 — engagement-service module-function tests.
 *
 * Sibling to agentic-tools.test.ts vitest pattern: hand-rolled prisma
 * mocks with vi.fn() returning hardcoded values, no external test DB.
 * Per reference_cross_workspace_test_runner — runs via apps/connectors
 * vitest config which includes packages/api/src/services/__tests__/*.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Engagement, PrismaClient } from "@prisma/client";
import {
  classifySignal,
  listEngagementsForContact,
  listEngagementsSinceForLearning,
  logEngagement,
  type EngagementInput,
} from "../engagement-service.js";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const CONTACT_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

function makeMockPrisma() {
  const findUnique = vi.fn(
    async (_args: { where: { correlationId: string } }): Promise<Engagement | null> => null,
  );
  const create = vi.fn(async ({ data }: { data: Record<string, unknown> }): Promise<Engagement> => ({
    id: "eng_" + Math.random().toString(36).slice(2, 10),
    tenantId: data.tenantId as string,
    contactId: data.contactId as string,
    correlationId: (data.correlationId as string | undefined) ?? null,
    engagementType: data.engagementType as string,
    signalClass: data.signalClass as never,
    channel: (data.channel as string | null | undefined) ?? null,
    metadata: (data.metadata as object) ?? {},
    occurredAt: data.occurredAt as Date,
    createdAt: new Date(),
  }));
  const findMany = vi.fn(async (_args: unknown): Promise<Engagement[]> => []);

  const prisma = {
    engagement: { findUnique, create, findMany },
  } as unknown as PrismaClient;

  return { prisma, findUnique, create, findMany };
}

describe("classifySignal — initial taxonomy per PRD §4", () => {
  it("returns positive for known positive types", () => {
    expect(classifySignal("email_open")).toBe("positive");
    expect(classifySignal("email_click")).toBe("positive");
    expect(classifySignal("email_reply")).toBe("positive");
    expect(classifySignal("form_submit")).toBe("positive");
  });

  it("returns negative for known negative types", () => {
    expect(classifySignal("email_bounce")).toBe("negative");
    expect(classifySignal("email_unsubscribe")).toBe("negative");
    expect(classifySignal("contact_optout")).toBe("negative");
  });

  it("returns neutral for unknown / unclassified types (default posture)", () => {
    expect(classifySignal("email_send")).toBe("neutral");
    expect(classifySignal("page_view")).toBe("neutral");
    expect(classifySignal("anything_unrecognized")).toBe("neutral");
    expect(classifySignal("")).toBe("neutral");
  });
});

describe("logEngagement — create path", () => {
  let mock: ReturnType<typeof makeMockPrisma>;

  beforeEach(() => {
    mock = makeMockPrisma();
  });

  it("creates a row with correct fields, signalClass derived from engagementType", async () => {
    const input: EngagementInput = {
      tenantId: TENANT_A,
      contactId: CONTACT_A,
      engagementType: "email_open",
      channel: "email",
      occurredAt: new Date("2026-05-03T12:00:00Z"),
      metadata: { messageId: "msg_123" },
    };

    const result = await logEngagement(mock.prisma, input);

    expect(mock.findUnique).not.toHaveBeenCalled();
    expect(mock.create).toHaveBeenCalledTimes(1);
    const createArgs = mock.create.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(createArgs.data.tenantId).toBe(TENANT_A);
    expect(createArgs.data.contactId).toBe(CONTACT_A);
    expect(createArgs.data.engagementType).toBe("email_open");
    expect(createArgs.data.signalClass).toBe("positive");
    expect(createArgs.data.channel).toBe("email");
    expect(createArgs.data.metadata).toEqual({ messageId: "msg_123" });
    expect(createArgs.data.occurredAt).toEqual(new Date("2026-05-03T12:00:00Z"));
    expect("correlationId" in createArgs.data).toBe(false);
    expect(result.engagementType).toBe("email_open");
  });

  it("defaults metadata to {} when not provided", async () => {
    await logEngagement(mock.prisma, {
      tenantId: TENANT_A,
      contactId: CONTACT_A,
      engagementType: "email_send",
      occurredAt: new Date("2026-05-03T12:00:00Z"),
    });
    const createArgs = mock.create.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(createArgs.data.metadata).toEqual({});
    expect(createArgs.data.signalClass).toBe("neutral");
    expect(createArgs.data.channel).toBeNull();
  });
});

describe("logEngagement — correlationId idempotency contract (PRD §4)", () => {
  it("WITH correlationId: first call creates, second call with same correlationId is no-op (returns existing, no duplicate)", async () => {
    const mock = makeMockPrisma();
    const input: EngagementInput = {
      tenantId: TENANT_A,
      contactId: CONTACT_A,
      engagementType: "email_reply",
      occurredAt: new Date("2026-05-03T12:00:00Z"),
      correlationId: "msg_abc123",
    };

    // First call: findUnique returns null → create runs
    const first = await logEngagement(mock.prisma, input);
    expect(mock.findUnique).toHaveBeenCalledTimes(1);
    expect(mock.create).toHaveBeenCalledTimes(1);
    const firstCreateArgs = mock.create.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(firstCreateArgs.data.correlationId).toBe("msg_abc123");

    // Second call: re-arm findUnique to return the existing row
    const existing: Engagement = { ...first, id: first.id };
    mock.findUnique.mockResolvedValueOnce(existing);

    const second = await logEngagement(mock.prisma, input);
    expect(mock.findUnique).toHaveBeenCalledTimes(2);
    expect(mock.create).toHaveBeenCalledTimes(1); // create NOT called second time
    expect(second).toBe(existing);
    expect(second.id).toBe(first.id);
  });

  it("WITHOUT correlationId: multiple calls create multiple rows (no dedup, no findUnique)", async () => {
    const mock = makeMockPrisma();
    const input: EngagementInput = {
      tenantId: TENANT_A,
      contactId: CONTACT_A,
      engagementType: "email_send",
      occurredAt: new Date("2026-05-03T12:00:00Z"),
    };

    await logEngagement(mock.prisma, input);
    await logEngagement(mock.prisma, input);
    await logEngagement(mock.prisma, input);

    expect(mock.findUnique).not.toHaveBeenCalled(); // never queried for dedup
    expect(mock.create).toHaveBeenCalledTimes(3); // 3 separate creates
  });
});

describe("listEngagementsForContact — query shape", () => {
  let mock: ReturnType<typeof makeMockPrisma>;

  beforeEach(() => {
    mock = makeMockPrisma();
  });

  it("queries for the right tenant + contact, descending by occurredAt, default limit 100", async () => {
    await listEngagementsForContact(mock.prisma, TENANT_A, CONTACT_A);

    expect(mock.findMany).toHaveBeenCalledTimes(1);
    const args = mock.findMany.mock.calls[0]![0] as Record<string, unknown>;
    expect(args.where).toEqual({ tenantId: TENANT_A, contactId: CONTACT_A });
    expect(args.orderBy).toEqual({ occurredAt: "desc" });
    expect(args.take).toBe(100);
  });

  it("respects since filter (cutoff applied to occurredAt)", async () => {
    const since = new Date("2026-05-01T00:00:00Z");
    await listEngagementsForContact(mock.prisma, TENANT_A, CONTACT_A, { since });

    const args = mock.findMany.mock.calls[0]![0] as Record<string, unknown>;
    expect(args.where).toEqual({
      tenantId: TENANT_A,
      contactId: CONTACT_A,
      occurredAt: { gte: since },
    });
  });

  it("respects opts.limit override", async () => {
    await listEngagementsForContact(mock.prisma, TENANT_A, CONTACT_A, { limit: 25 });

    const args = mock.findMany.mock.calls[0]![0] as Record<string, unknown>;
    expect(args.take).toBe(25);
  });
});

describe("listEngagementsSinceForLearning — query shape", () => {
  it("queries ascending by occurredAt for the cutoff, default limit 1000", async () => {
    const mock = makeMockPrisma();
    const after = new Date("2026-05-01T00:00:00Z");

    await listEngagementsSinceForLearning(mock.prisma, after);

    expect(mock.findMany).toHaveBeenCalledTimes(1);
    const args = mock.findMany.mock.calls[0]![0] as Record<string, unknown>;
    expect(args.where).toEqual({ occurredAt: { gte: after } });
    expect(args.orderBy).toEqual({ occurredAt: "asc" });
    expect(args.take).toBe(1000);
  });

  it("respects custom limit", async () => {
    const mock = makeMockPrisma();
    await listEngagementsSinceForLearning(mock.prisma, new Date(), 50);

    const args = mock.findMany.mock.calls[0]![0] as Record<string, unknown>;
    expect(args.take).toBe(50);
  });
});
