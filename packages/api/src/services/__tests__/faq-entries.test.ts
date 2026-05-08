/**
 * KAN-XXX — faq-entries service tests.
 *
 * Mocks the embedder + Prisma delegates; asserts the status machine
 * (queued → embedding → ready / error) and the synchronous chunk-write
 * via $executeRaw.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";

// Mock the embedder before importing the service.
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
  listFaqEntries,
  getFaqEntry,
  createFaqEntry,
  updateFaqEntry,
  deleteFaqEntry,
  FaqValidationError,
} from "../faq-entries.js";

interface FaqRow {
  id: string;
  tenantId: string;
  question: string;
  answer: string;
  status: string;
  errorDetail: string | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function makePrismaMock(initialRows: FaqRow[] = []) {
  const rows: FaqRow[] = initialRows.map((r) => ({ ...r }));
  const executeRawCalls: unknown[][] = [];

  const findMany = vi.fn(async (args: { where: { tenantId: string; deletedAt: null } }) =>
    rows
      .filter((r) => r.tenantId === args.where.tenantId && r.deletedAt === null)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
  );
  const findFirst = vi.fn(
    async (args: { where: { id?: string; tenantId: string; deletedAt?: null } }) =>
      rows.find(
        (r) =>
          (args.where.id === undefined || r.id === args.where.id) &&
          r.tenantId === args.where.tenantId &&
          (args.where.deletedAt === undefined || r.deletedAt === null),
      ) ?? null,
  );
  const create = vi.fn(async (args: { data: Partial<FaqRow> }) => {
    const now = new Date();
    const newRow: FaqRow = {
      id: args.data.id ?? `id-${rows.length + 1}`,
      tenantId: args.data.tenantId!,
      question: args.data.question!,
      answer: args.data.answer!,
      status: args.data.status ?? "queued",
      errorDetail: null,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    rows.push(newRow);
    return newRow;
  });
  const update = vi.fn(async (args: { where: { id: string }; data: Partial<FaqRow> }) => {
    const row = rows.find((r) => r.id === args.where.id);
    if (!row) throw new Error("not found in mock");
    Object.assign(row, args.data, { updatedAt: new Date() });
    return row;
  });
  const count = vi.fn(async (args: { where: { tenantId: string; deletedAt: null } }) =>
    rows.filter((r) => r.tenantId === args.where.tenantId && r.deletedAt === null).length,
  );

  const chunkDeleteMany = vi.fn(async () => ({ count: 0 }));

  const prisma = {
    faqEntry: { findMany, findFirst, create, update, count },
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

describe("faq-entries service", () => {
  it("Test 1 — createFaqEntry happy path: queued → embedding → ready + chunk written", async () => {
    const mock = makePrismaMock();
    embedMock.mockResolvedValue([
      { position: 0, text: "irrelevant", tokenCount: 12, embedding: Array(1536).fill(0.1) },
    ]);

    const entry = await createFaqEntry(mock.prisma, "tenant-a", {
      question: "What's the warranty?",
      answer: "Five years parts and labor.",
    });

    expect(entry.status).toBe("ready");
    expect(entry.errorDetail).toBeNull();

    // Status updates: created with 'queued' (default), then 'embedding', then 'ready'.
    const statuses = mock.update.mock.calls.map((c) => (c[0] as { data: { status?: string } }).data.status);
    expect(statuses).toEqual(["embedding", "ready"]);

    // Exactly one chunk row written via $executeRaw with sourceId NULL + faq_entry_id set.
    expect(mock.executeRawCalls).toHaveLength(1);
    expect(embedMock).toHaveBeenCalledOnce();
    const embedCall = embedMock.mock.calls[0]!;
    expect((embedCall[0] as Array<{ text: string }>)[0].text).toBe(
      "Question: What's the warranty?\n\nAnswer: Five years parts and labor.",
    );
  });

  it("Test 2 — createFaqEntry embedding failure: status=error + errorDetail populated", async () => {
    const mock = makePrismaMock();
    embedMock.mockRejectedValue(new Error("OpenAI 503"));

    const entry = await createFaqEntry(mock.prisma, "tenant-a", {
      question: "Q?",
      answer: "A.",
    });

    expect(entry.status).toBe("error");
    expect(entry.errorDetail).toContain("OpenAI 503");
    // No chunk row written on the failed embed path.
    expect(mock.executeRawCalls).toHaveLength(0);
  });

  it("Test 3 — createFaqEntry validation: empty question rejected", async () => {
    const mock = makePrismaMock();
    await expect(
      createFaqEntry(mock.prisma, "tenant-a", { question: "  ", answer: "non-empty" }),
    ).rejects.toBeInstanceOf(FaqValidationError);
    // No row created on validation failure.
    expect(mock.create).not.toHaveBeenCalled();
  });

  it("Test 4 — listFaqEntries scopes by tenantId + excludes soft-deleted", async () => {
    const mock = makePrismaMock([
      makeRow({ id: "a", tenantId: "t1", createdAt: new Date(2026, 0, 1) }),
      makeRow({ id: "b", tenantId: "t1", createdAt: new Date(2026, 0, 2) }),
      makeRow({ id: "c", tenantId: "t2", createdAt: new Date(2026, 0, 3) }),
      makeRow({ id: "d", tenantId: "t1", createdAt: new Date(2026, 0, 4), deletedAt: new Date() }),
    ]);
    const result = await listFaqEntries(mock.prisma, "t1");
    expect(result.map((r) => r.id)).toEqual(["b", "a"]); // newest first, soft-deleted excluded, t2 excluded
  });

  it("Test 5 — getFaqEntry returns null on cross-tenant probe", async () => {
    const mock = makePrismaMock([makeRow({ id: "x1", tenantId: "t1" })]);
    const wrongTenant = await getFaqEntry(mock.prisma, "t2", "x1");
    expect(wrongTenant).toBeNull();
    const correctTenant = await getFaqEntry(mock.prisma, "t1", "x1");
    expect(correctTenant?.id).toBe("x1");
  });

  it("Test 6 — updateFaqEntry re-embeds + clears errorDetail on success", async () => {
    const mock = makePrismaMock([
      makeRow({ id: "f1", tenantId: "t1", question: "old Q", answer: "old A", status: "error", errorDetail: "stale" }),
    ]);
    embedMock.mockResolvedValue([
      { position: 0, text: "irrelevant", tokenCount: 5, embedding: Array(1536).fill(0.2) },
    ]);
    const updated = await updateFaqEntry(mock.prisma, "t1", "f1", { answer: "new A" });
    expect(updated?.status).toBe("ready");
    expect(updated?.errorDetail).toBeNull();
    expect(updated?.answer).toBe("new A");
    // Old chunks deleted before re-insert.
    expect(mock.chunkDeleteMany).toHaveBeenCalled();
    expect(mock.executeRawCalls).toHaveLength(1);
  });

  it("Test 7 — updateFaqEntry returns null on missing or cross-tenant", async () => {
    const mock = makePrismaMock([makeRow({ id: "f1", tenantId: "t1" })]);
    const result = await updateFaqEntry(mock.prisma, "t2", "f1", { answer: "X" });
    expect(result).toBeNull();
    // No state change attempted on the mismatched-tenant path.
    expect(embedMock).not.toHaveBeenCalled();
  });

  it("Test 8 — updateFaqEntry no-op on unchanged input (no embed call)", async () => {
    const mock = makePrismaMock([
      makeRow({ id: "f1", tenantId: "t1", question: "Q", answer: "A", status: "ready" }),
    ]);
    const result = await updateFaqEntry(mock.prisma, "t1", "f1", { question: "Q", answer: "A" });
    expect(result?.status).toBe("ready");
    expect(embedMock).not.toHaveBeenCalled();
  });

  it("Test 9 — deleteFaqEntry sets deletedAt + returns true; subsequent get returns null", async () => {
    const mock = makePrismaMock([makeRow({ id: "f1", tenantId: "t1" })]);
    const ok = await deleteFaqEntry(mock.prisma, "t1", "f1");
    expect(ok).toBe(true);
    const fetched = await getFaqEntry(mock.prisma, "t1", "f1");
    expect(fetched).toBeNull(); // soft-deleted: filtered by deletedAt: null
  });

  it("Test 10 — deleteFaqEntry returns false on cross-tenant probe", async () => {
    const mock = makePrismaMock([makeRow({ id: "f1", tenantId: "t1" })]);
    const ok = await deleteFaqEntry(mock.prisma, "t2", "f1");
    expect(ok).toBe(false);
    // Original row untouched.
    expect(mock.rows[0]!.deletedAt).toBeNull();
  });
});

// ─────────────────────────────────────────────
// Test fixture helper
// ─────────────────────────────────────────────

function makeRow(overrides: Partial<FaqRow>): FaqRow {
  const now = new Date();
  return {
    id: "id",
    tenantId: "t1",
    question: "Q",
    answer: "A",
    status: "ready",
    errorDetail: null,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
