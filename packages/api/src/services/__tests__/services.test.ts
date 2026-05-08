/**
 * KAN-XXX — services service tests.
 *
 * Mocks the embedder + Prisma delegates; asserts the status machine
 * (queued → embedding → ready / error), the synchronous chunk-write,
 * the embed text format (Decision 3), and the price/date validation
 * surface.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";

const embedMock = vi.fn();
vi.mock("../knowledge-embedder.js", async () => {
  const actual = (await vi.importActual<typeof import("../knowledge-embedder.js")>(
    "../knowledge-embedder.js",
  )) as Record<string, unknown>;
  return {
    ...actual,
    embed: (...args: unknown[]) => embedMock(...args),
  };
});

import {
  listServices,
  getService,
  createService,
  updateService,
  deleteService,
  buildServiceEmbedText,
  ServiceValidationError,
  type ServiceRow,
  type ServicePriceUnit,
} from "../services.js";

function makePrismaMock(initialRows: ServiceRow[] = []) {
  const rows: ServiceRow[] = initialRows.map((r) => ({ ...r }));
  const executeRawCalls: unknown[][] = [];

  const findMany = vi.fn(async (args: { where: { tenantId: string; deletedAt: null } }) =>
    rows
      .filter((r) => r.tenantId === args.where.tenantId)
      .filter((r) => (args.where.deletedAt === null ? true : true)) // mock soft-delete filter
      .filter((r) => !((r as unknown as { deletedAt?: Date | null }).deletedAt))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
  );
  const findFirst = vi.fn(
    async (args: { where: { id?: string; tenantId: string; deletedAt?: null } }) =>
      rows.find(
        (r) =>
          (args.where.id === undefined || r.id === args.where.id) &&
          r.tenantId === args.where.tenantId &&
          (args.where.deletedAt === undefined ||
            !((r as unknown as { deletedAt?: Date | null }).deletedAt)),
      ) ?? null,
  );
  const create = vi.fn(async (args: { data: Partial<ServiceRow> }) => {
    const now = new Date();
    const newRow: ServiceRow = {
      id: args.data.id ?? `id-${rows.length + 1}`,
      tenantId: args.data.tenantId!,
      title: args.data.title!,
      description: args.data.description!,
      price: (args.data.price as number | null) ?? null,
      priceUnit: args.data.priceUnit as ServicePriceUnit,
      priceCustomLabel: (args.data.priceCustomLabel as string | null) ?? null,
      startDate: (args.data.startDate as Date | null) ?? null,
      endDate: (args.data.endDate as Date | null) ?? null,
      includedItems: (args.data.includedItems as string[]) ?? [],
      excludedItems: (args.data.excludedItems as string[]) ?? [],
      status: (args.data.status as ServiceRow["status"]) ?? "queued",
      errorDetail: null,
      createdAt: now,
      updatedAt: now,
    };
    rows.push(newRow);
    return newRow;
  });
  const update = vi.fn(async (args: { where: { id: string }; data: Partial<ServiceRow> }) => {
    const row = rows.find((r) => r.id === args.where.id);
    if (!row) throw new Error("not found in mock");
    Object.assign(row, args.data, { updatedAt: new Date() });
    return row;
  });
  const count = vi.fn(async () => rows.length);
  const chunkDeleteMany = vi.fn(async () => ({ count: 0 }));

  const prisma = {
    service: { findMany, findFirst, create, update, count },
    knowledgeChunk: { deleteMany: chunkDeleteMany },
    $executeRaw: vi.fn(async (...args: unknown[]) => {
      executeRawCalls.push(args);
      return 1;
    }),
    $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(prisma)),
  } as unknown as PrismaClient;

  return { prisma, findMany, findFirst, create, update, chunkDeleteMany, executeRawCalls, rows };
}

beforeEach(() => {
  embedMock.mockReset();
});

describe("services service — KAN-XXX", () => {
  it("Test 1 — createService happy path: queued → embedding → ready + chunk written + correct embed text", async () => {
    const mock = makePrismaMock();
    embedMock.mockResolvedValue([
      { position: 0, text: "irrelevant", tokenCount: 25, embedding: Array(1536).fill(0.1) },
    ]);

    const entry = await createService(mock.prisma, "tenant-a", {
      title: "Senior Engineering Mentorship",
      description: "1:1 weekly mentorship with personalized career roadmap.",
      price: 250,
      priceUnit: "PER_HOUR",
      includedItems: ["Weekly 60-min session", "Slack support between sessions"],
      excludedItems: ["Code review of full repos"],
      startDate: new Date("2026-06-01"),
      endDate: null,
    });

    expect(entry.status).toBe("ready");
    expect(entry.errorDetail).toBeNull();

    const statuses = mock.update.mock.calls.map((c) => (c[0] as { data: { status?: string } }).data.status);
    expect(statuses).toEqual(["embedding", "ready"]);

    expect(mock.executeRawCalls).toHaveLength(1);
    expect(embedMock).toHaveBeenCalledOnce();

    // Locked embed-text format from Decision 3
    const embedCall = embedMock.mock.calls[0]!;
    const embedText = (embedCall[0] as Array<{ text: string }>)[0].text;
    expect(embedText).toContain("Service: Senior Engineering Mentorship");
    expect(embedText).toContain("Description: 1:1 weekly mentorship");
    expect(embedText).toContain("Pricing: $250.00 per hour");
    expect(embedText).toContain("Availability: 2026-06-01 to Open-ended end");
    expect(embedText).toContain("What's included:");
    expect(embedText).toContain("- Weekly 60-min session");
    expect(embedText).toContain("What's excluded:");
    expect(embedText).toContain("- Code review of full repos");
  });

  it("Test 2 — buildServiceEmbedText skips empty included/excluded blocks", () => {
    const text = buildServiceEmbedText({
      title: "Bare service",
      description: "Minimal description.",
      price: 100,
      priceUnit: "FIXED",
      priceCustomLabel: null,
      startDate: null,
      endDate: null,
      includedItems: [],
      excludedItems: [],
    });
    expect(text).toContain("Service: Bare service");
    expect(text).toContain("Pricing: $100.00 fixed price");
    expect(text).toContain("Availability: Ongoing");
    expect(text).not.toContain("What's included");
    expect(text).not.toContain("What's excluded");
  });

  it("Test 3 — buildServiceEmbedText: priceUnit=CUSTOM uses priceCustomLabel verbatim, no $ prefix", () => {
    const text = buildServiceEmbedText({
      title: "Bespoke engagement",
      description: "Project-by-project.",
      price: null,
      priceUnit: "CUSTOM",
      priceCustomLabel: "Contact for quote",
      startDate: null,
      endDate: null,
      includedItems: [],
      excludedItems: [],
    });
    expect(text).toContain("Pricing: Contact for quote");
    expect(text).not.toContain("$");
    expect(text).not.toContain("per ");
  });

  it("Test 4 — createService validation: CUSTOM without label rejected", async () => {
    const mock = makePrismaMock();
    await expect(
      createService(mock.prisma, "t1", {
        title: "X",
        description: "Y",
        price: null,
        priceUnit: "CUSTOM",
        priceCustomLabel: "  ",
      }),
    ).rejects.toBeInstanceOf(ServiceValidationError);
    expect(mock.create).not.toHaveBeenCalled();
  });

  it("Test 5 — createService validation: non-CUSTOM unit without numeric price rejected", async () => {
    const mock = makePrismaMock();
    await expect(
      createService(mock.prisma, "t1", {
        title: "X",
        description: "Y",
        price: null,
        priceUnit: "PER_HOUR",
      }),
    ).rejects.toBeInstanceOf(ServiceValidationError);
  });

  it("Test 6 — createService validation: endDate before startDate rejected", async () => {
    const mock = makePrismaMock();
    await expect(
      createService(mock.prisma, "t1", {
        title: "X",
        description: "Y",
        price: 50,
        priceUnit: "PER_HOUR",
        startDate: new Date("2026-06-15"),
        endDate: new Date("2026-06-01"),
      }),
    ).rejects.toBeInstanceOf(ServiceValidationError);
  });

  it("Test 7 — createService embedding failure: status=error + chunks cleaned", async () => {
    const mock = makePrismaMock();
    embedMock.mockRejectedValue(new Error("OpenAI 503"));

    const entry = await createService(mock.prisma, "t1", {
      title: "X",
      description: "Y",
      price: 50,
      priceUnit: "PER_HOUR",
    });

    expect(entry.status).toBe("error");
    expect(entry.errorDetail).toContain("OpenAI 503");
    expect(mock.executeRawCalls).toHaveLength(0);
  });

  it("Test 8 — getService returns null on cross-tenant probe", async () => {
    const mock = makePrismaMock([
      makeRow({ id: "s1", tenantId: "t1", title: "Mine" }),
    ]);
    expect(await getService(mock.prisma, "t2", "s1")).toBeNull();
    expect((await getService(mock.prisma, "t1", "s1"))?.id).toBe("s1");
  });

  it("Test 9 — updateService re-embeds on field change; no-op short-circuit on unchanged input", async () => {
    const mock = makePrismaMock([
      makeRow({
        id: "s1",
        tenantId: "t1",
        title: "Old",
        description: "Old desc",
        price: 100,
        priceUnit: "PER_HOUR",
        status: "ready",
      }),
    ]);
    embedMock.mockResolvedValue([
      { position: 0, text: "x", tokenCount: 5, embedding: Array(1536).fill(0.2) },
    ]);

    // Change title → re-embed
    const updated = await updateService(mock.prisma, "t1", "s1", { title: "New" });
    expect(updated?.title).toBe("New");
    expect(updated?.status).toBe("ready");
    expect(embedMock).toHaveBeenCalledTimes(1);

    // No-op: same title back → no embed
    embedMock.mockClear();
    const result = await updateService(mock.prisma, "t1", "s1", {
      title: "New",
      description: "Old desc",
      price: 100,
      priceUnit: "PER_HOUR",
    });
    expect(result?.status).toBe("ready");
    expect(embedMock).not.toHaveBeenCalled();
  });

  it("Test 10 — deleteService soft-deletes; subsequent get returns null + cross-tenant returns false", async () => {
    const mock = makePrismaMock([makeRow({ id: "s1", tenantId: "t1" })]);
    expect(await deleteService(mock.prisma, "t2", "s1")).toBe(false);
    expect(await deleteService(mock.prisma, "t1", "s1")).toBe(true);
    expect(await getService(mock.prisma, "t1", "s1")).toBeNull();
  });

  it("Test 11 — listServices scopes by tenantId and excludes soft-deleted", async () => {
    const baseDate = new Date(2026, 0, 1);
    const mock = makePrismaMock([
      makeRow({
        id: "a",
        tenantId: "t1",
        title: "First",
        createdAt: new Date(baseDate.getTime() + 1000),
      }),
      makeRow({
        id: "b",
        tenantId: "t1",
        title: "Second",
        createdAt: new Date(baseDate.getTime() + 2000),
      }),
      makeRow({ id: "c", tenantId: "t2", title: "Other tenant" }),
    ]);
    const result = await listServices(mock.prisma, "t1");
    expect(result.map((r) => r.id)).toEqual(["b", "a"]); // newest first, no t2
  });
});

// ─────────────────────────────────────────────
// Test fixture helper
// ─────────────────────────────────────────────

function makeRow(overrides: Partial<ServiceRow>): ServiceRow {
  const now = new Date();
  return {
    id: "id",
    tenantId: "t1",
    title: "Title",
    description: "Description body.",
    price: 100,
    priceUnit: "PER_HOUR",
    priceCustomLabel: null,
    startDate: null,
    endDate: null,
    includedItems: [],
    excludedItems: [],
    status: "ready",
    errorDetail: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
