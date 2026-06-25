/**
 * KAN-1234 Phase A — Decision Scoreboard projection (pure math).
 *
 * Given pre-counted inputs (reachable contacts/inventory, measured outcomes,
 * tenant vertical) + the campaign's goal/window, produce the scoreboard the
 * operator sees BEFORE clicking Generate Action Plan (Doctrine #5 — the system
 * always knows what's missing). Pure + dependency-free: the tRPC procedure does
 * the Prisma counting and passes the numbers in, so this is unit-testable
 * without a DB.
 *
 * Phase A linear model (refined in Phase C):
 *   projected = reachable × closingRate × (daysInWindow / 30)
 * where closingRate is the tenant's measured rate once it has ≥3 outcomes,
 * else the industry-default baseline (honestly labelled in the UI).
 */
import {
  industryDefaultClosingRate,
  TENANT_RATE_MIN_OUTCOMES,
} from "../lib/industry-defaults.js";

export type ProjectionVerdict = "on_track" | "stretch" | "unrealistic";
export type ClosingRateSource = "tenant" | "industry";

export interface ProjectionResult {
  /** matched audience (product) or target inventory (vehicle); null pre-target */
  reachableContacts: number | null;
  closingRate: number | null;
  closingRateSource: ClosingRateSource | null;
  projected: number | null;
  goal: number | null;
  gap: number | null;
  verdict: ProjectionVerdict | null;
  daysInWindow: number | null;
}

export interface ComputeProjectionInputs {
  /** reachable audience/inventory, pre-counted by the caller. null → not targetable yet */
  reachableContacts: number | null;
  /** Campaign.goalTarget; null until objectives confirmed */
  goalTarget: number | null;
  windowStart: Date | null;
  windowEnd: Date | null;
  /** Tenant.industry vertical key */
  industry: string | null;
  /** tenant's measured campaign outcomes (actualOutcome IS NOT NULL) */
  measuredOutcomes: { total: number; hits: number };
}

/** listVehicles filter subset the projection uses to count target inventory. */
export interface VehicleListFilters {
  conditionIn?: string[];
  makeIn?: string[];
  bodyStyleIn?: string[];
  yearMin?: number;
  yearMax?: number;
  priceMin?: number;
  priceMax?: number;
  searchText?: string;
}

/**
 * KAN-1234 — map a vehicleTargetDescriptor to listVehicles filters so the
 * scoreboard counts the TARGET INVENTORY (e.g. 137 used cars), per R2 — the
 * vehicle count, distinct from the Action Plan's audience-contact count.
 *
 * NOTE: mirrors the filter half of the frontend `descriptorToVehicleSearch`
 * (apps/web/.../vehicleTargetDescriptor.ts). Two consumers today; if a third
 * appears, hoist to packages/shared per memo
 * cross_workspace_algorithm_hoist_to_shared_eliminates_drift.
 */
export function descriptorToVehicleFilters(descriptor: unknown): VehicleListFilters {
  const f: VehicleListFilters = {};
  if (!descriptor || typeof descriptor !== "object") return f;
  const d = descriptor as Record<string, unknown>;
  if (typeof d.condition === "string" && d.condition)
    f.conditionIn = [d.condition.toLowerCase()];
  if (typeof d.bodyStyle === "string" && d.bodyStyle)
    f.bodyStyleIn = [d.bodyStyle.toLowerCase()];
  if (typeof d.make === "string" && d.make.trim()) f.makeIn = [d.make.trim()];
  if (typeof d.year === "number" && Number.isFinite(d.year)) {
    f.yearMin = d.year;
    f.yearMax = d.year;
  }
  if (typeof d.priceMin === "number") f.priceMin = d.priceMin;
  if (typeof d.priceMax === "number") f.priceMax = d.priceMax;
  if (typeof d.model === "string" && d.model.trim()) f.searchText = d.model.trim();
  return f;
}

const DEFAULT_WINDOW_DAYS = 30;
const MS_PER_DAY = 86_400_000;

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

const EMPTY: ProjectionResult = {
  reachableContacts: null,
  closingRate: null,
  closingRateSource: null,
  projected: null,
  goal: null,
  gap: null,
  verdict: null,
  daysInWindow: null,
};

export function computeProjection(inp: ComputeProjectionInputs): ProjectionResult {
  // Progressive disclosure: nothing to show until a target is established.
  if (inp.reachableContacts == null) return { ...EMPTY };

  const reachable = inp.reachableContacts;

  // daysInWindow — null until the timeline dimension is set; projection then
  // uses the default 30-day assumption (closingRate is a 30-day rate).
  let daysInWindow: number | null = null;
  if (inp.windowStart && inp.windowEnd) {
    const ms = inp.windowEnd.getTime() - inp.windowStart.getTime();
    daysInWindow = ms > 0 ? round1(ms / MS_PER_DAY) : null;
  }

  // Stage 1 — target confirmed but no objective yet → reachable only.
  const hasGoal = inp.goalTarget != null && inp.goalTarget > 0;
  if (!hasGoal) {
    return { ...EMPTY, reachableContacts: reachable, daysInWindow };
  }
  const goal = inp.goalTarget as number;

  // Closing rate — tenant-measured once ≥3 outcomes, else industry default.
  let closingRate: number;
  let closingRateSource: ClosingRateSource;
  if (inp.measuredOutcomes.total >= TENANT_RATE_MIN_OUTCOMES) {
    closingRateSource = "tenant";
    closingRate = inp.measuredOutcomes.hits / inp.measuredOutcomes.total;
  } else {
    closingRateSource = "industry";
    closingRate = industryDefaultClosingRate(inp.industry);
  }

  const windowFactor = (daysInWindow ?? DEFAULT_WINDOW_DAYS) / 30;
  const projected = round1(reachable * closingRate * windowFactor);
  const gap = round1(goal - projected);
  const verdict: ProjectionVerdict =
    projected >= goal ? "on_track" : projected >= goal * 0.5 ? "stretch" : "unrealistic";

  return {
    reachableContacts: reachable,
    closingRate,
    closingRateSource,
    projected,
    goal,
    gap,
    verdict,
    daysInWindow,
  };
}
