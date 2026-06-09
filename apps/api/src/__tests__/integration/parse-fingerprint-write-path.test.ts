/**
 * KAN-1140 Phase 3 PR 7 — Real-Postgres integration test for the
 * parse-fingerprint write path (raw SQL UPSERT + 5-LRU sample prune).
 *
 * Required by `query_raw_sql_syntax_validation_must_execute_not_mock`
 * memo: $queryRaw / $executeRaw paths MUST execute against real
 * Postgres to validate SQL syntax + ON CONFLICT semantics + JSONB
 * cast. Mocked $queryRaw catches column-name typos but NOT SQL
 * syntax errors.
 *
 * Per KAN-1112 Phase 1 Q3 lock: every test wraps work in
 * `prisma.$transaction` and throws at the end to roll back. Fingerprint
 * + sample inserts in this file do NOT persist between tests.
 *
 * Run via:
 *   docker compose -f docker-compose.test.yml up -d
 *   DATABASE_URL=postgresql://test:test@localhost:5433/growth_test \
 *     npx prisma migrate deploy --schema packages/db/prisma/schema.prisma
 *   npx vitest run --config apps/connectors/vitest.config.integration.ts
 */
import { describe, expect, it } from "vitest";
import { createTenant, withRollback } from "./setup.js";

/**
 * Inlined writeParseFingerprint logic from
 * `apps/connectors/src/app.ts` setInboundHooks block, parameterized
 * by the transaction. Mirrors the production hook 1:1 so this test
 * covers the same SQL that runs in PROD.
 *
 * Kept inline (not extracted to a shared helper) so a future refactor
 * that drifts the production SQL away from this test surface is loud
 * via comparing the two strings — the discipline cousin of
 * `feedback_ad_hoc_debug_fixes_must_propagate_to_source`.
 */
async function writeFingerprint(
  tx: {
    $queryRaw: <T>(strings: TemplateStringsArray, ...values: unknown[]) => Promise<T>;
    $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<number>;
  },
  input: {
    tenantId: string;
    structureHash: string | null;
    senderDomainHash: string;
    labelTokenHash: string | null;
    format: string;
    language: string | null;
    vendor: string | null;
    formatConfidence: string;
    languageConfidence: string | null;
    resendEmailId: string | null;
    bodyForSample: string;
    senderDomain: string;
    customFields: Record<string, unknown>;
  },
): Promise<{ id: string }> {
  const upsertResult = await tx.$queryRaw<Array<{ id: string }>>`
    INSERT INTO parse_fingerprints (
      id, tenant_id, structure_hash, sender_domain_hash, label_token_hash,
      format, language, vendor, format_confidence, language_confidence,
      occurrence_count, escalation_count, reclassify_count,
      first_seen_at, last_seen_at, created_at, updated_at
    )
    VALUES (
      gen_random_uuid(), ${input.tenantId}, ${input.structureHash},
      ${input.senderDomainHash}, ${input.labelTokenHash},
      ${input.format}, ${input.language}, ${input.vendor},
      ${input.formatConfidence}, ${input.languageConfidence},
      1, 0, 0, NOW(), NOW(), NOW(), NOW()
    )
    ON CONFLICT (tenant_id, structure_hash, sender_domain_hash)
    DO UPDATE SET
      occurrence_count = parse_fingerprints.occurrence_count + 1,
      last_seen_at = NOW(),
      language = COALESCE(EXCLUDED.language, parse_fingerprints.language),
      vendor = COALESCE(EXCLUDED.vendor, parse_fingerprints.vendor),
      label_token_hash = COALESCE(EXCLUDED.label_token_hash, parse_fingerprints.label_token_hash),
      updated_at = NOW()
    RETURNING id
  `;
  const fingerprintId = upsertResult[0]!.id;
  const bodyCapped = input.bodyForSample.slice(0, 4096);
  const customFieldsJson = JSON.stringify(input.customFields ?? {});
  await tx.$executeRaw`
    INSERT INTO parse_fingerprint_samples (
      id, fingerprint_id, resend_email_id, body_preview,
      sender_domain, custom_fields, captured_at
    )
    VALUES (
      gen_random_uuid(), ${fingerprintId}, ${input.resendEmailId},
      ${bodyCapped}, ${input.senderDomain}, ${customFieldsJson}::jsonb, NOW()
    )
  `;
  await tx.$executeRaw`
    DELETE FROM parse_fingerprint_samples
    WHERE fingerprint_id = ${fingerprintId}
      AND id NOT IN (
        SELECT id FROM parse_fingerprint_samples
        WHERE fingerprint_id = ${fingerprintId}
        ORDER BY captured_at DESC
        LIMIT 5
      )
  `;
  return { id: fingerprintId };
}

function makeInput(overrides: {
  tenantId: string;
  structureHash?: string | null;
  senderDomainHash?: string;
  bodyForSample?: string;
  customFields?: Record<string, unknown>;
  language?: string | null;
  vendor?: string | null;
}) {
  return {
    tenantId: overrides.tenantId,
    structureHash: overrides.structureHash ?? "default_struct_hash",
    senderDomainHash: overrides.senderDomainHash ?? "default_sender_hash",
    labelTokenHash: null as string | null,
    format: "plain-text",
    language: overrides.language ?? "en",
    vendor: overrides.vendor ?? "formspree",
    formatConfidence: "high",
    languageConfidence: "high" as string | null,
    resendEmailId: "re_test",
    bodyForSample: overrides.bodyForSample ?? "Name: Alice\nEmail: a@b.c",
    senderDomain: "alice@a.com",
    customFields: overrides.customFields ?? {},
  };
}

describe("parse-fingerprint write path — real Postgres", () => {
  it("first insert creates row with occurrence_count=1 + escalation_count=0", async () => {
    await withRollback(async (tx) => {
      const { id: tenantId } = await createTenant(tx);
      const { id } = await writeFingerprint(tx as never, makeInput({ tenantId }));
      const row = await (tx as unknown as {
        parseFingerprint: {
          findUnique: (args: unknown) => Promise<{
            occurrenceCount: number;
            escalationCount: number;
            reclassifyCount: number;
          } | null>;
        };
      }).parseFingerprint.findUnique({ where: { id } });
      expect(row).not.toBeNull();
      expect(row!.occurrenceCount).toBe(1);
      expect(row!.escalationCount).toBe(0);
      expect(row!.reclassifyCount).toBe(0);
    });
  });

  it("second insert on same (tenant_id, structure_hash, sender_domain_hash) UPSERTS — occurrence_count=2", async () => {
    await withRollback(async (tx) => {
      const { id: tenantId } = await createTenant(tx);
      const input = makeInput({ tenantId });
      const { id: id1 } = await writeFingerprint(tx as never, input);
      const { id: id2 } = await writeFingerprint(tx as never, input);
      expect(id1).toBe(id2);
      const row = await (tx as unknown as {
        parseFingerprint: {
          findUnique: (args: unknown) => Promise<{ occurrenceCount: number } | null>;
        };
      }).parseFingerprint.findUnique({ where: { id: id1 } });
      expect(row!.occurrenceCount).toBe(2);
    });
  });

  it("different sender_domain_hash on same structure_hash creates SEPARATE rows", async () => {
    await withRollback(async (tx) => {
      const { id: tenantId } = await createTenant(tx);
      const a = await writeFingerprint(
        tx as never,
        makeInput({ tenantId, senderDomainHash: "domain_a" }),
      );
      const b = await writeFingerprint(
        tx as never,
        makeInput({ tenantId, senderDomainHash: "domain_b" }),
      );
      expect(a.id).not.toBe(b.id);
    });
  });

  it("UPSERT preserves existing language/vendor when new value is null (COALESCE semantics)", async () => {
    await withRollback(async (tx) => {
      const { id: tenantId } = await createTenant(tx);
      const { id } = await writeFingerprint(
        tx as never,
        makeInput({ tenantId, language: "en", vendor: "formspree" }),
      );
      await writeFingerprint(
        tx as never,
        makeInput({ tenantId, language: null, vendor: null }),
      );
      const row = await (tx as unknown as {
        parseFingerprint: {
          findUnique: (args: unknown) => Promise<{ language: string | null; vendor: string | null } | null>;
        };
      }).parseFingerprint.findUnique({ where: { id } });
      expect(row!.language).toBe("en"); // preserved
      expect(row!.vendor).toBe("formspree"); // preserved
    });
  });

  it("5-LRU sample prune — 6th sample evicts oldest", async () => {
    await withRollback(async (tx) => {
      const { id: tenantId } = await createTenant(tx);
      const input = makeInput({ tenantId });
      // Insert 6 samples on the same fingerprint
      let fingerprintId = "";
      for (let i = 0; i < 6; i++) {
        const { id } = await writeFingerprint(tx as never, {
          ...input,
          bodyForSample: `Sample ${i}`,
        });
        fingerprintId = id;
      }
      const samples = await (tx as unknown as {
        parseFingerprintSample: {
          findMany: (args: unknown) => Promise<Array<{ bodyPreview: string }>>;
        };
      }).parseFingerprintSample.findMany({
        where: { fingerprintId },
        orderBy: { capturedAt: "desc" },
      });
      expect(samples).toHaveLength(5);
      // Oldest sample (Sample 0) should be pruned
      const bodies = samples.map((s) => s.bodyPreview);
      expect(bodies).not.toContain("Sample 0");
      expect(bodies).toContain("Sample 5"); // newest preserved
    });
  });

  it("4KB body cap applied at write — long body truncated to 4096 chars", async () => {
    await withRollback(async (tx) => {
      const { id: tenantId } = await createTenant(tx);
      const longBody = "x".repeat(10_000);
      const { id: fingerprintId } = await writeFingerprint(
        tx as never,
        makeInput({ tenantId, bodyForSample: longBody }),
      );
      const samples = await (tx as unknown as {
        parseFingerprintSample: {
          findMany: (args: unknown) => Promise<Array<{ bodyPreview: string }>>;
        };
      }).parseFingerprintSample.findMany({ where: { fingerprintId } });
      expect(samples[0]!.bodyPreview.length).toBe(4096);
    });
  });

  it("custom_fields jsonb round-trip — operator can read back what producer wrote", async () => {
    await withRollback(async (tx) => {
      const { id: tenantId } = await createTenant(tx);
      const customFields = {
        _kan_1140_format: "plain-text",
        _kan_1140_language: "fr",
        someVendorField: "value-with-special-chars-éàü",
      };
      const { id: fingerprintId } = await writeFingerprint(
        tx as never,
        makeInput({ tenantId, customFields }),
      );
      const samples = await (tx as unknown as {
        parseFingerprintSample: {
          findMany: (args: unknown) => Promise<Array<{ customFields: unknown }>>;
        };
      }).parseFingerprintSample.findMany({ where: { fingerprintId } });
      expect(samples[0]!.customFields).toEqual(customFields);
    });
  });

  it("null structure_hash UPSERTs as separate row from non-null structure_hash with same sender_domain_hash", async () => {
    await withRollback(async (tx) => {
      const { id: tenantId } = await createTenant(tx);
      // Postgres treats NULL != NULL by default in UNIQUE constraints,
      // so this should create TWO rows. Verify our UNIQUE index handles
      // NULL the standard way (each NULL is distinct).
      const a = await writeFingerprint(
        tx as never,
        makeInput({ tenantId, structureHash: null, senderDomainHash: "same_sender" }),
      );
      const b = await writeFingerprint(
        tx as never,
        makeInput({ tenantId, structureHash: "non_null", senderDomainHash: "same_sender" }),
      );
      expect(a.id).not.toBe(b.id);
    });
  });

  it("cross-tenant isolation — UPSERT on tenant A doesn't touch tenant B's matching row", async () => {
    await withRollback(async (tx) => {
      const { id: tenantA } = await createTenant(tx);
      const { id: tenantB } = await createTenant(tx);
      const inputA = makeInput({ tenantId: tenantA });
      const inputB = makeInput({ tenantId: tenantB });
      const { id: idA } = await writeFingerprint(tx as never, inputA);
      const { id: idB } = await writeFingerprint(tx as never, inputB);
      expect(idA).not.toBe(idB);
      // Repeat insert on tenant A should ONLY increment tenant A's row
      await writeFingerprint(tx as never, inputA);
      await writeFingerprint(tx as never, inputA);
      const rowA = await (tx as unknown as {
        parseFingerprint: {
          findUnique: (args: unknown) => Promise<{ occurrenceCount: number } | null>;
        };
      }).parseFingerprint.findUnique({ where: { id: idA } });
      const rowB = await (tx as unknown as {
        parseFingerprint: {
          findUnique: (args: unknown) => Promise<{ occurrenceCount: number } | null>;
        };
      }).parseFingerprint.findUnique({ where: { id: idB } });
      expect(rowA!.occurrenceCount).toBe(3); // 1 + 2 increments
      expect(rowB!.occurrenceCount).toBe(1); // untouched
    });
  });
});
