/**
 * KAN-1183 — Campaigns list service.
 *
 * Pure service logic for `campaigns.list` tRPC. Mirrors the canonical
 * list-router pattern (see companies-router.listCompanies + contacts-
 * router.listContacts): cursor pagination via `_pagination.ts` helpers,
 * search OR groups composed via top-level AND alongside cursor + filter
 * predicates, totalCount excludes the cursor.
 *
 * Q-ADD F lock — Always-On Campaigns excluded by default; the operator-
 * facing list-view never surfaces the per-tenant catch-all unless the
 * caller passes `includeAlwaysOn: true` for debugging.
 *
 * Q-ADD A3 lock — list-item shape is server-derived compact (kind +
 * achievability projected from the full FeasibilityCounselResult JSON
 * stored on Campaign.feasibilityAnalysis). Keeps the wire bytes-cheap and
 * shares the discriminated union types via @growth/shared so the server
 * projection can't drift from client interpretation.
 */
import type { PrismaClient } from "@prisma/client";
import {
  buildCursorWhere,
  decodeCursor,
  encodeCursor,
} from "./_pagination.js";

export interface ListInput {
  search?: string;
  status?: string;
  limit: number;
  cursor?: string;
  includeAlwaysOn?: boolean;
}

export interface CampaignListItem {
  id: string;
  name: string;
  status:
    | "draft"
    | "committed"
    | "active"
    | "paused"
    | "completed"
    | "archived";
  goalType: string | null;
  goalTarget: number | null;
  goalDescription: string | null;
  /** Discriminator on Campaign.feasibilityAnalysis JSON; null when not yet
   *  analyzed. Server-projected to keep list-row payload compact. */
  feasibilityAnalysisKind:
    | "cold_start_counsel"
    | "feasibility_counsel"
    | "analyzer_unavailable"
    | null;
  /** Only populated when feasibilityAnalysisKind === 'feasibility_counsel'. */
  achievability: "feasible" | "stretch" | "unrealistic" | null;
  activatedAt: string | null;
  updatedAt: string;
}

const LIST_SELECT = {
  id: true,
  name: true,
  status: true,
  goalType: true,
  goalTarget: true,
  goalDescription: true,
  feasibilityAnalysis: true,
  activatedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

export async function listCampaigns(
  prisma: PrismaClient,
  tenantId: string,
  input: ListInput,
): Promise<{
  items: CampaignListItem[];
  nextCursor: string | null;
  totalCount: number;
}> {
  const cursor = decodeCursor(input.cursor);

  const where: Record<string, unknown> = { tenantId };
  if (input.status) where.status = input.status;
  if (!input.includeAlwaysOn) where.isAlwaysOn = false;

  const searchOr = input.search
    ? [
        { name: { contains: input.search, mode: "insensitive" as const } },
        {
          goalDescription: {
            contains: input.search,
            mode: "insensitive" as const,
          },
        },
      ]
    : null;

  const andClauses: Array<Record<string, unknown>> = [];
  if (cursor) andClauses.push(buildCursorWhere(cursor));
  if (searchOr) andClauses.push({ OR: searchOr });
  if (andClauses.length > 0) where.AND = andClauses;

  const totalCountWhere: Record<string, unknown> = { tenantId };
  if (input.status) totalCountWhere.status = input.status;
  if (!input.includeAlwaysOn) totalCountWhere.isAlwaysOn = false;
  if (searchOr) totalCountWhere.OR = searchOr;

  const [rowsPlusOne, totalCount] = await Promise.all([
    (prisma as any).campaign.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: input.limit + 1,
      select: LIST_SELECT,
    }),
    (prisma as any).campaign.count({ where: totalCountWhere }),
  ]);

  const hasNext = rowsPlusOne.length > input.limit;
  const sliced = hasNext ? rowsPlusOne.slice(0, input.limit) : rowsPlusOne;

  const items: CampaignListItem[] = sliced.map((row: any) =>
    projectListItem(row),
  );

  const last = sliced[sliced.length - 1];
  const nextCursor =
    hasNext && last
      ? encodeCursor({ id: last.id, createdAt: last.createdAt })
      : null;

  return { items, nextCursor, totalCount };
}

/**
 * Derive the compact shape from the raw Campaign row. Reads the
 * discriminated kind off `feasibilityAnalysis.kind` and, when the kind is
 * 'feasibility_counsel', projects `counsel.achievability` to the top
 * level. Defensive against malformed JSON — falls back to null + null.
 */
function projectListItem(row: {
  id: string;
  name: string;
  status: string;
  goalType: string | null;
  goalTarget: number | null;
  goalDescription: string | null;
  feasibilityAnalysis: unknown;
  activatedAt: Date | null;
  updatedAt: Date;
}): CampaignListItem {
  const { kind, achievability } = deriveFeasibilitySummary(
    row.feasibilityAnalysis,
  );
  return {
    id: row.id,
    name: row.name,
    status: row.status as CampaignListItem["status"],
    goalType: row.goalType,
    goalTarget: row.goalTarget,
    goalDescription: row.goalDescription,
    feasibilityAnalysisKind: kind,
    achievability,
    activatedAt: row.activatedAt ? row.activatedAt.toISOString() : null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function deriveFeasibilitySummary(raw: unknown): {
  kind: CampaignListItem["feasibilityAnalysisKind"];
  achievability: CampaignListItem["achievability"];
} {
  if (!raw || typeof raw !== "object") return { kind: null, achievability: null };
  const r = raw as { kind?: unknown; counsel?: unknown };
  if (typeof r.kind !== "string") return { kind: null, achievability: null };
  if (
    r.kind !== "cold_start_counsel" &&
    r.kind !== "feasibility_counsel" &&
    r.kind !== "analyzer_unavailable"
  ) {
    return { kind: null, achievability: null };
  }
  if (r.kind !== "feasibility_counsel") {
    return { kind: r.kind, achievability: null };
  }
  const counsel = r.counsel as { achievability?: unknown } | undefined;
  const a = counsel?.achievability;
  if (a === "feasible" || a === "stretch" || a === "unrealistic") {
    return { kind: "feasibility_counsel", achievability: a };
  }
  return { kind: "feasibility_counsel", achievability: null };
}
