/**
 * KAN-1028 follow-up — exhaustive PROD-shape audit of the decision-engine
 * Zod parse surface. $0 cost (DB-read + parse only; no LLM, no writes).
 *
 * For every Zod schema the engine calls .parse() on with DB-derived data,
 * this script:
 *   1. Reads the corresponding PROD rows via Prisma (the live proxy on 5434)
 *   2. Replicates the engine's exact transform at the parse call-site
 *   3. Runs .safeParse() on every row
 *   4. Collects every contract mismatch (nullability, vocab, missing, type)
 *
 * Reports to stdout; meant to be redirected to a file for review.
 *
 * Usage (from repo root):
 *   DATABASE_URL="postgresql://postgres:$(gcloud secrets versions access latest \
 *     --secret=growth-db-url-production --project=growth-493400 \
 *     | sed -E 's#postgresql://postgres:([^@]+)@.*#\\1#')@127.0.0.1:5434/growth" \
 *     npx tsx scripts/prod-schema-audit-engine-parse.ts
 */
import { PrismaClient } from "@prisma/client";
import {
  ObjectiveSchema,
  ContactStateSchema,
} from "../packages/api/src/services/objective-gap-analyzer.js";
import { AssembledContextSchema } from "../packages/api/src/services/context-assembler.js";
import { ThresholdGateInputSchema } from "../packages/api/src/services/threshold-gate.js";

const prisma = new PrismaClient();

type Finding = {
  schema: string;
  rowId: string;
  rowLabel?: string;
  issues: Array<{
    code: string;
    path: (string | number)[];
    expected?: string;
    received?: string;
    message: string;
  }>;
  rawValuesAtFailedPaths?: Record<string, unknown>;
};

const findings: Finding[] = [];

function pluck(obj: any, path: (string | number)[]): unknown {
  let v: any = obj;
  for (const p of path) {
    if (v == null) return v;
    v = v[p];
  }
  return v;
}

function recordIssues(
  schema: string,
  rowId: string,
  rowLabel: string | undefined,
  candidate: unknown,
  result: { success: false; error: { issues: any[] } },
) {
  const issues = result.error.issues.map((i) => ({
    code: i.code,
    path: i.path,
    expected: (i as any).expected,
    received: (i as any).received,
    message: i.message,
  }));
  const rawValuesAtFailedPaths: Record<string, unknown> = {};
  for (const i of issues) {
    rawValuesAtFailedPaths[i.path.join(".") || "<root>"] = pluck(candidate, i.path);
  }
  findings.push({ schema, rowId, rowLabel, issues, rawValuesAtFailedPaths });
}

// ─────────────────────────────────────────────
// Probe 1: ObjectiveSchema (objective-gap-analyzer.ts:664)
// ─────────────────────────────────────────────
async function probeObjectives() {
  const rows = await prisma.objective.findMany();
  console.error(`[probe] ObjectiveSchema: ${rows.length} rows`);
  for (const o of rows) {
    const candidate = {
      id: o.id,
      tenantId: o.tenantId,
      type: o.type,
      name: (o as any).name ?? o.type,
      successCondition: o.successCondition,
      subObjectives: (o as any).subObjectives ?? [],
      blueprintId: o.blueprintId,
      createdAt: o.createdAt?.toISOString() ?? new Date().toISOString(),
    };
    const r = ObjectiveSchema.safeParse(candidate);
    if (!r.success) {
      recordIssues(
        "ObjectiveSchema",
        o.id,
        `${(o as any).name ?? o.type}`,
        candidate,
        r as any,
      );
    }
  }
}

// ─────────────────────────────────────────────
// Probe 2: ContactStateSchema (objective-gap-analyzer.ts:675)
// ─────────────────────────────────────────────
async function probeContactStates() {
  const rows = await prisma.contactObjectiveStack.findMany({ take: 2000 });
  console.error(`[probe] ContactStateSchema: ${rows.length} rows`);
  for (const cs of rows) {
    const candidate = {
      id: cs.id,
      contactId: cs.contactId,
      objectiveId: cs.objectiveId,
      subObjectives: (cs as any).subObjectives ?? {},
      strategyCurrent: cs.strategyCurrent,
      confidenceScore: (cs as any).confidenceScore ?? 0,
      updatedAt: cs.updatedAt?.toISOString() ?? new Date().toISOString(),
    };
    const r = ContactStateSchema.safeParse(candidate);
    if (!r.success) {
      recordIssues(
        "ContactStateSchema",
        cs.id,
        `contact=${cs.contactId}`,
        candidate,
        r as any,
      );
    }
  }
}

// ─────────────────────────────────────────────
// Probe 3: AssembledContextSchema — run live assembleContext()
//
// Sample N (tenantId, contactId, objectiveId) tuples from
// contactObjectiveStack and call the real context-assembler.
// If assembleContext throws OR if its output fails the schema, capture.
// (Threshold-gate inputs are downstream of context, so this also exercises
// most of the data the gate would see.)
// ─────────────────────────────────────────────
async function probeAssembledContext() {
  const { assembleContext } = await import(
    "../packages/api/src/services/context-assembler.js"
  );
  // Stub cache that always misses (forces DB path — what we want to audit).
  const cache = {
    get: async () => null,
    set: async () => {},
  };
  // Replicate buildContextDatabase() from run-decision-for-contact.ts:171.
  const db = {
    async getContact(contactId: string, tenantId: string) {
      const c = await prisma.contact.findFirst({ where: { id: contactId, tenantId } });
      return c as any;
    },
    async getCurrentDeal(contactId: string, tenantId: string) {
      const d = await prisma.deal.findFirst({
        where: { contactId, tenantId, status: "open" } as any,
        orderBy: { createdAt: "desc" },
        select: { id: true, pipelineId: true, currentStageId: true, microObjectiveProgress: true },
      });
      if (!d) return null;
      return {
        id: d.id,
        pipelineId: d.pipelineId,
        currentStageId: d.currentStageId,
        microObjectiveProgress: ((d as any).microObjectiveProgress ?? {}) as any,
      };
    },
    async getContactState(contactId: string, objectiveId: string) {
      const s = await prisma.contactObjectiveStack.findFirst({ where: { contactId, objectiveId } });
      return (s ?? null) as any;
    },
    async getBrainSnapshot(tenantId: string) {
      return { tenantId, snapshotAt: new Date().toISOString() };
    },
    async getTenantConfig(tenantId: string) {
      const t = await prisma.tenant.findUnique({ where: { id: tenantId } });
      return t as any;
    },
    async getRecentActions(contactId: string, limit: number) {
      const rows = await prisma.action.findMany({
        where: { contactId },
        orderBy: { createdAt: "desc" },
        take: limit,
      });
      return (rows ?? []) as any;
    },
    async getPipelineState(pipelineId: string, stageId: string | null) {
      const p = await prisma.pipeline.findUnique({
        where: { id: pipelineId },
        include: { targets: true } as any,
      });
      if (!p) return null;
      const s = stageId
        ? await prisma.stage.findUnique({ where: { id: stageId } })
        : null;
      return { pipeline: p, stage: s, microObjectives: [], knowledgeFilters: [] } as any;
    },
  };

  const sample = await prisma.contactObjectiveStack.findMany({
    take: 30,
    select: {
      contactId: true,
      objectiveId: true,
      contact: { select: { tenantId: true } },
    },
  });
  console.error(`[probe] AssembledContextSchema: ${sample.length} live assemblies`);
  for (const s of sample) {
    const tenantId = (s as any).contact?.tenantId;
    if (!tenantId) continue;
    try {
      const out = await assembleContext(
        {
          tenantId,
          contactId: s.contactId,
          objectiveId: s.objectiveId,
          freshContext: true,
        } as any,
        cache as any,
        db as any,
      );
      // Re-parse to confirm the output passes the schema (it would have
      // thrown inside if it didn't; this is belt-and-suspenders for
      // any downstream call that re-parses cached/external context).
      const r = AssembledContextSchema.safeParse(out);
      if (!r.success) {
        recordIssues(
          "AssembledContextSchema",
          `${tenantId}/${s.contactId}/${s.objectiveId}`,
          undefined,
          out,
          r as any,
        );
      }
    } catch (err: any) {
      const issues =
        err?.issues && Array.isArray(err.issues)
          ? err.issues.map((i: any) => ({
              code: i.code,
              path: i.path,
              expected: i.expected,
              received: i.received,
              message: i.message,
            }))
          : [{ code: "throw", path: [], message: String(err?.message ?? err) }];
      findings.push({
        schema: "AssembledContextSchema (live assembly)",
        rowId: `${tenantId}/${s.contactId}/${s.objectiveId}`,
        issues,
        rawValuesAtFailedPaths: {
          stack: String(err?.stack ?? "").split("\n").slice(0, 6).join(" | "),
        },
      });
    }
  }
}

// ─────────────────────────────────────────────
// Probe 4: ThresholdGateInputSchema — inspect DB sources
//
// Most of the input is in-memory engine-assembled, but tenantConfig +
// stageMatrix + pipelineMatrix come from DB. Sanity-check that every
// active Stage.autoApproveMatrix and Pipeline.defaultAutoApproveMatrix
// JSON value would deserialize into the inner shape the gate expects
// (z.record(z.object({ threshold, default, rationale }))).
// ─────────────────────────────────────────────
async function probeThresholdGateDbSources() {
  const { z } = await import("zod");
  const AutoApproveEntrySchema = z.object({
    threshold: z.number(),
    default: z.string(),
    rationale: z.string().optional(),
  });
  const MatrixSchema = z.record(AutoApproveEntrySchema).nullable().optional();

  const stages = await prisma.stage.findMany({
    where: { autoApproveMatrix: { not: undefined } as any },
  });
  console.error(`[probe] Stage.autoApproveMatrix: ${stages.length} rows`);
  for (const s of stages) {
    const m = (s as any).autoApproveMatrix;
    if (m == null) continue;
    const r = MatrixSchema.safeParse(m);
    if (!r.success) {
      recordIssues(
        "Stage.autoApproveMatrix (gate-input shape)",
        s.id,
        (s as any).name,
        m,
        r as any,
      );
    }
  }

  const pipelines = await prisma.pipeline.findMany();
  console.error(`[probe] Pipeline.defaultAutoApproveMatrix: ${pipelines.length} rows`);
  for (const p of pipelines) {
    const m = (p as any).defaultAutoApproveMatrix;
    if (m == null) continue;
    const r = MatrixSchema.safeParse(m);
    if (!r.success) {
      recordIssues(
        "Pipeline.defaultAutoApproveMatrix (gate-input shape)",
        p.id,
        (p as any).name,
        m,
        r as any,
      );
    }
  }

  const tenants = await prisma.tenant.findMany({
    select: { id: true, confidenceThreshold: true, autoApproveEnabled: true },
  });
  console.error(`[probe] Tenant fields: ${tenants.length} rows`);
  for (const t of tenants) {
    if (
      typeof t.confidenceThreshold !== "number" ||
      t.confidenceThreshold < 0 ||
      t.confidenceThreshold > 100
    ) {
      findings.push({
        schema: "Tenant.confidenceThreshold (gate-input shape)",
        rowId: t.id,
        issues: [
          {
            code: "out_of_range",
            path: ["confidenceThreshold"],
            message: `value=${t.confidenceThreshold}`,
          },
        ],
      });
    }
    if (typeof t.autoApproveEnabled !== "boolean") {
      findings.push({
        schema: "Tenant.autoApproveEnabled (gate-input shape)",
        rowId: t.id,
        issues: [
          {
            code: "wrong_type",
            path: ["autoApproveEnabled"],
            message: `value=${String(t.autoApproveEnabled)} typeof=${typeof t.autoApproveEnabled}`,
          },
        ],
      });
    }
  }
}

async function main() {
  console.error("=== PROD schema-audit probe (engine-parse surface) ===");
  console.error("Connected via DATABASE_URL — proxy must be running.");
  await probeObjectives();
  await probeContactStates();
  await probeAssembledContext();
  await probeThresholdGateDbSources();

  const bySchema: Record<string, number> = {};
  const byIssueCode: Record<string, number> = {};
  const byField: Record<string, number> = {};
  for (const f of findings) {
    bySchema[f.schema] = (bySchema[f.schema] ?? 0) + 1;
    for (const i of f.issues) {
      byIssueCode[i.code] = (byIssueCode[i.code] ?? 0) + 1;
      const key = `${f.schema}::${i.path.join(".") || "<root>"}`;
      byField[key] = (byField[key] ?? 0) + 1;
    }
  }

  console.log(
    JSON.stringify(
      {
        totalFindings: findings.length,
        bySchema,
        byIssueCode,
        byField,
        findings,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((e) => {
    console.error("FATAL", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
