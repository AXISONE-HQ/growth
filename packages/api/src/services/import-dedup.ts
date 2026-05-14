/**
 * KAN-911 — Ingestion Cohort 2.6. Duplicate detection (rule-based +
 * Levenshtein, no LLM).
 *
 * For each staging row from PR 6, find candidate duplicates in the
 * canonical entity tables and record a MatchDecision JSON on the
 * staging row. PR 8 (commit) reads these decisions at write time.
 *
 * Bright lines:
 *   - NO LLM. Pure rule-based + Levenshtein.
 *   - NO auto-merge. Every suggestion requires user confirmation.
 *   - Sync only. Background workers are a future cohort.
 *
 * Cost model: $0. No external API calls.
 *
 * Performance: O(staging × bucket-avg) with first-letter (36+ bucket)
 * pre-filter. 10K staging × 10K existing ≈ 26 buckets × ~385 each
 * ≈ 4M comparisons. ~2-5s on typical hardware. Trigram refinement is
 * deferred to KAN-912 (filed in this PR).
 *
 * Confidence convention (decision B):
 *   - Exact signals (email/domain/providerOrderId) → 100
 *   - phone_exact / order_number_exact → 95
 *   - Fuzzy match → min(round(similarity × 100), 94)
 *   - ≥95 → suggested 'update'
 *   - 75-94 → suggested 'needs_review'
 *   - no candidates → suggested 'insert'
 */
import { TRPCError } from "@trpc/server";
import type { ImportJob, PrismaClient } from "@prisma/client";
import {
  bucketKey,
  fuzzyEqual,
  fuzzyScore,
  normalize,
  phonesMatch,
} from "./lib/string-matching.js";
import {
  projectRow,
  projectedContactMirrorColumns,
  projectedCompanyMirrorColumns,
  projectedDealMirrorColumns,
  projectedOrderMirrorColumns,
  type FieldMappingEntryLike,
  type ProjectedContact,
  type ProjectedCompany,
  type ProjectedDeal,
  type ProjectedOrder,
} from "./lib/row-projection.js";

// ─────────────────────────────────────────────
// Public shapes
// ─────────────────────────────────────────────

export type EntityType = "contacts" | "companies" | "deals" | "orders";

export type SuggestedAction = "update" | "needs_review" | "insert" | "skip";

/**
 * Canonical signal names that appear in `matchedFields[]` on a
 * candidate (decision F). The UI renders these as chips.
 */
export type SignalName =
  | "email_exact"
  | "phone_exact"
  | "domain_exact"
  | "provider_order_id_exact"
  | "order_number_exact"
  | "name_fuzzy"
  | "legal_name_fuzzy"
  | "close_date_window"
  | "contact_email_exact"
  | "placed_at_window"
  // KAN-922 — exact match on externalIds[sourceTag].
  | "external_id_exact";

// KAN-922 — Per-entity match-key allow-lists. Strict union types so an
// invalid key bubbles up as a type error rather than a silent
// commit-time miss. The 'auto' literal (default cascade) is implicit —
// callers pass `undefined` for backwards-compat heuristic.
export type ContactMatchKey = "email" | "phone" | "external_id";
export type CompanyMatchKey = "domain" | "external_id";
export type DealMatchKey = "external_id";
export type OrderMatchKey = "orderNumber" | "providerOrderId" | "external_id";

/** KAN-922 — per-import match configuration threaded from ImportJob.
 *  `externalSourceTag` is REQUIRED when `matchKey === 'external_id'`
 *  (validated at saveFieldMappings; matcher returns no-candidates if
 *  config violates this invariant at runtime). */
export interface MatchConfig<K extends string> {
  matchKey?: K;
  externalSourceTag?: string | null;
}

export interface MatchCandidate {
  /** id of the matching canonical entity. */
  existingEntityId: string;
  /** 0-100 confidence. 100 = exact signal; ≤94 = fuzzy. */
  score: number;
  /** Canonical signal names that fired for this candidate. */
  matchedFields: SignalName[];
}

export interface MatchDecision {
  /** Top 3 candidates sorted by score desc; empty if no candidates. */
  candidates: MatchCandidate[];
  /** Service-recommended action. User can override. */
  suggestedAction: SuggestedAction;
  /** Top candidate's score, or 0 if no candidates. */
  confidence: number;
  /** 1-line explanation surfaced in the resolution UI. */
  suggestedReason: string;
  /**
   * KAN-911 — operator-overridden choice. NULL until the user clicks
   * a per-row dropdown on /imports/[id]/duplicates. When set,
   * confirmDuplicateResolution treats this row as resolved.
   */
  userChoice?: {
    action: SuggestedAction;
    /** When action='update', the id of the canonical entity to merge into. */
    chosenCandidateId?: string;
    overriddenAt: string; // ISO timestamp
  };
}

// ─────────────────────────────────────────────
// Canonical entity shapes (projected from Prisma)
// ─────────────────────────────────────────────

interface ExistingContact {
  id: string;
  email: string | null;
  phone: string | null;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
  /** KAN-922 — projected from Contact.externalIds JSON. */
  externalIds: Record<string, string>;
}

interface ExistingCompany {
  id: string;
  name: string;
  legalName: string | null;
  domain: string | null;
  externalIds: Record<string, string>;
}

interface ExistingDeal {
  id: string;
  name: string;
  expectedCloseDate: Date | null;
  contact: { email: string | null } | null;
  externalIds: Record<string, string>;
}

interface ExistingOrder {
  id: string;
  orderNumber: string;
  providerOrderId: string | null;
  placedAt: Date | null;
  contact: { email: string | null } | null;
  externalIds: Record<string, string>;
}

// ─────────────────────────────────────────────
// Bucket pre-filter
//
// Group canonical entities by first character of normalize(name) for
// O(staging × bucket-avg) fuzzy matching. Decision E.
// ─────────────────────────────────────────────

function buildBuckets<T extends { id: string }>(
  items: T[],
  nameOf: (t: T) => string | null | undefined,
): Map<string, T[]> {
  const buckets = new Map<string, T[]>();
  for (const item of items) {
    const key = bucketKey(nameOf(item));
    const arr = buckets.get(key) ?? [];
    arr.push(item);
    buckets.set(key, arr);
  }
  return buckets;
}

function getBucketCandidates<T>(
  buckets: Map<string, T[]>,
  name: string | null | undefined,
): T[] {
  const key = bucketKey(name);
  return buckets.get(key) ?? [];
}

// ─────────────────────────────────────────────
// Action / confidence mapping helpers
// ─────────────────────────────────────────────

function actionForConfidence(c: number): SuggestedAction {
  if (c >= 95) return "update";
  if (c >= 75) return "needs_review";
  return "insert";
}

function reasonForCandidates(candidates: MatchCandidate[]): string {
  if (candidates.length === 0) return "No existing entity matched.";
  const top = candidates[0]!;
  const fields = top.matchedFields.join(", ");
  return `Top match @ ${top.score}% via ${fields}.`;
}

function sortAndTop3(candidates: MatchCandidate[]): MatchCandidate[] {
  return candidates.sort((a, b) => b.score - a.score).slice(0, 3);
}

function decisionFromCandidates(candidates: MatchCandidate[]): MatchDecision {
  const top3 = sortAndTop3(candidates);
  const confidence = top3.length > 0 ? top3[0]!.score : 0;
  return {
    candidates: top3,
    suggestedAction: actionForConfidence(confidence),
    confidence,
    suggestedReason: reasonForCandidates(top3),
  };
}

// ─────────────────────────────────────────────
// Per-entity matchers
// ─────────────────────────────────────────────

/**
 * Contact matcher:
 *   1. email exact   → score 100 (signal: email_exact)
 *   2. phone exact   → score 95  (signal: phone_exact)
 *   3. name fuzzy + same company → max(fuzzyScore, 85), capped 94
 *   4. name fuzzy only           → min(fuzzyScore, 94)
 */
// KAN-922 — Helper: strict-match short-circuit when user explicitly picked
// a non-auto match key. Returns a MatchDecision built from the strict
// match, or null when matchKey is undefined (caller falls through to its
// current heuristic cascade).
function strictMatch<E extends { id: string }>(
  config: MatchConfig<string> | undefined,
  signalForScalar: SignalName,
  externalIdFieldOnStaging: Record<string, string> | undefined,
  candidates: { id: string; matched: boolean; signal: SignalName }[],
): MatchDecision | null {
  if (!config?.matchKey) return null;
  const out: MatchCandidate[] = candidates
    .filter((c) => c.matched)
    .map((c) => ({ existingEntityId: c.id, score: 100, matchedFields: [c.signal] }));
  // Suppress lint on unused params from the staging-shape match — the
  // caller built the candidates list with the appropriate predicate.
  void signalForScalar;
  void externalIdFieldOnStaging;
  return decisionFromCandidates(out);
}

export function matchContact(
  staging: {
    email?: string | null;
    phone?: string | null;
    firstName?: string | null;
    lastName?: string | null;
    companyName?: string | null;
    externalIds?: Record<string, string>;
  },
  existing: ExistingContact[],
  nameBuckets: Map<string, ExistingContact[]>,
  config?: MatchConfig<ContactMatchKey>,
): MatchDecision {
  // KAN-922 — Strict-match short-circuit. Backwards-compatible: when
  // config is omitted or matchKey is undefined, fall through to the
  // existing heuristic cascade below.
  if (config?.matchKey) {
    const built: MatchCandidate[] = [];
    if (config.matchKey === "external_id" && config.externalSourceTag) {
      const tag = config.externalSourceTag;
      const stagingExtId = staging.externalIds?.[tag];
      if (stagingExtId) {
        for (const e of existing) {
          if (e.externalIds[tag] === stagingExtId) {
            built.push({ existingEntityId: e.id, score: 100, matchedFields: ["external_id_exact"] });
          }
        }
      }
    } else if (config.matchKey === "email") {
      const stagingEmail = normalize(staging.email);
      if (stagingEmail) {
        for (const e of existing) {
          if (normalize(e.email) === stagingEmail) {
            built.push({ existingEntityId: e.id, score: 100, matchedFields: ["email_exact"] });
          }
        }
      }
    } else if (config.matchKey === "phone") {
      if (staging.phone) {
        for (const e of existing) {
          if (phonesMatch(staging.phone, e.phone)) {
            built.push({ existingEntityId: e.id, score: 100, matchedFields: ["phone_exact"] });
          }
        }
      }
    }
    return decisionFromCandidates(built);
  }
  // Suppress unused warning while keeping the imported helper visible —
  // not all branches reference it.
  void strictMatch;
  const candidates: MatchCandidate[] = [];
  const matchedByCandidate = new Map<string, MatchCandidate>();

  function add(id: string, score: number, signal: SignalName): void {
    const cur = matchedByCandidate.get(id);
    if (cur) {
      if (score > cur.score) cur.score = score;
      if (!cur.matchedFields.includes(signal)) cur.matchedFields.push(signal);
    } else {
      const c: MatchCandidate = { existingEntityId: id, score, matchedFields: [signal] };
      matchedByCandidate.set(id, c);
      candidates.push(c);
    }
  }

  // Rule 1 — email exact (highest signal).
  const stagingEmail = normalize(staging.email);
  if (stagingEmail) {
    for (const e of existing) {
      if (normalize(e.email) === stagingEmail) {
        add(e.id, 100, "email_exact");
      }
    }
  }

  // Rule 2 — phone exact (NANP-aware).
  if (staging.phone) {
    for (const e of existing) {
      if (phonesMatch(staging.phone, e.phone)) {
        add(e.id, 95, "phone_exact");
      }
    }
  }

  // Rule 3 + 4 — name fuzzy (with company boost). Bucket-filtered.
  const fullStagingName = [staging.firstName, staging.lastName]
    .filter((p): p is string => !!p)
    .join(" ");
  if (fullStagingName) {
    const bucketCandidates = getBucketCandidates(
      nameBuckets,
      fullStagingName,
    );
    for (const e of bucketCandidates) {
      const fullExistingName = [e.firstName, e.lastName]
        .filter((p): p is string => !!p)
        .join(" ");
      if (!fullExistingName) continue;
      if (!fuzzyEqual(fullStagingName, fullExistingName, 0.15)) continue;
      let score = Math.min(fuzzyScore(fullStagingName, fullExistingName), 94);
      // Company boost — fuzzy name + same company → bump to ≥85.
      if (
        staging.companyName &&
        e.companyName &&
        fuzzyEqual(staging.companyName, e.companyName, 0.15)
      ) {
        score = Math.max(score, 85);
      }
      add(e.id, score, "name_fuzzy");
    }
  }

  return decisionFromCandidates(candidates);
}

/**
 * Company matcher (3 rules per decision A):
 *   1. domain exact          → score 100 (signal: domain_exact)
 *   2. name fuzzy OR legalName fuzzy → min(fuzzyScore, 94)
 *      (signals: name_fuzzy / legal_name_fuzzy)
 *   3. No matches → 'insert'
 */
export function matchCompany(
  staging: {
    name?: string | null;
    domain?: string | null;
    externalIds?: Record<string, string>;
  },
  existing: ExistingCompany[],
  nameBuckets: Map<string, ExistingCompany[]>,
  config?: MatchConfig<CompanyMatchKey>,
): MatchDecision {
  // KAN-922 — Strict-match short-circuit.
  if (config?.matchKey) {
    const built: MatchCandidate[] = [];
    if (config.matchKey === "external_id" && config.externalSourceTag) {
      const tag = config.externalSourceTag;
      const stagingExtId = staging.externalIds?.[tag];
      if (stagingExtId) {
        for (const e of existing) {
          if (e.externalIds[tag] === stagingExtId) {
            built.push({ existingEntityId: e.id, score: 100, matchedFields: ["external_id_exact"] });
          }
        }
      }
    } else if (config.matchKey === "domain") {
      const stagingDomain = normalize(staging.domain);
      if (stagingDomain) {
        for (const e of existing) {
          if (normalize(e.domain) === stagingDomain) {
            built.push({ existingEntityId: e.id, score: 100, matchedFields: ["domain_exact"] });
          }
        }
      }
    }
    return decisionFromCandidates(built);
  }
  const candidates: MatchCandidate[] = [];
  const matchedByCandidate = new Map<string, MatchCandidate>();

  function add(id: string, score: number, signal: SignalName): void {
    const cur = matchedByCandidate.get(id);
    if (cur) {
      if (score > cur.score) cur.score = score;
      if (!cur.matchedFields.includes(signal)) cur.matchedFields.push(signal);
    } else {
      const c: MatchCandidate = { existingEntityId: id, score, matchedFields: [signal] };
      matchedByCandidate.set(id, c);
      candidates.push(c);
    }
  }

  // Rule 1 — domain exact.
  const stagingDomain = normalize(staging.domain);
  if (stagingDomain) {
    for (const e of existing) {
      if (normalize(e.domain) === stagingDomain) {
        add(e.id, 100, "domain_exact");
      }
    }
  }

  // Rule 2 — name fuzzy + legalName fuzzy. Bucket-filtered on name
  // (most companies don't carry a legalName, so the legalName check
  // runs as a secondary signal within the name-bucket candidates).
  if (staging.name) {
    const bucketCandidates = getBucketCandidates(nameBuckets, staging.name);
    for (const e of bucketCandidates) {
      let scored = false;
      if (e.name && fuzzyEqual(staging.name, e.name, 0.15)) {
        add(e.id, Math.min(fuzzyScore(staging.name, e.name), 94), "name_fuzzy");
        scored = true;
      }
      if (e.legalName && fuzzyEqual(staging.name, e.legalName, 0.15)) {
        add(e.id, Math.min(fuzzyScore(staging.name, e.legalName), 94), "legal_name_fuzzy");
        scored = true;
      }
      // Edge: legal-name-only match without name match — already handled
      // by the second check; no separate branch needed.
      void scored;
    }
  }

  return decisionFromCandidates(candidates);
}

/**
 * Deal matcher (conservative — deals dedup rarely):
 *   1. name fuzzy + same contactEmail + closeDate within 30 days → 90
 *      (signals: name_fuzzy, contact_email_exact, close_date_window)
 *   2. name fuzzy + same contactEmail → min(fuzzyScore, 85)
 *      (signals: name_fuzzy, contact_email_exact)
 *   3. No matches → 'insert'
 *
 * Note: `contactEmail` on the existing Deal is pulled via
 * `contact: { select: { email } }` eager-join — see runDuplicateDetection's
 * Prisma query.
 */
export function matchDeal(
  staging: {
    name?: string | null;
    contactEmail?: string | null;
    expectedCloseDate?: Date | null;
    externalIds?: Record<string, string>;
  },
  existing: ExistingDeal[],
  nameBuckets: Map<string, ExistingDeal[]>,
  config?: MatchConfig<DealMatchKey>,
): MatchDecision {
  // KAN-922 — Strict-match short-circuit. Deal only supports external_id
  // as a non-heuristic key (locked decision G3).
  if (config?.matchKey === "external_id" && config.externalSourceTag) {
    const tag = config.externalSourceTag;
    const stagingExtId = staging.externalIds?.[tag];
    const built: MatchCandidate[] = [];
    if (stagingExtId) {
      for (const e of existing) {
        if (e.externalIds[tag] === stagingExtId) {
          built.push({ existingEntityId: e.id, score: 100, matchedFields: ["external_id_exact"] });
        }
      }
    }
    return decisionFromCandidates(built);
  }
  const candidates: MatchCandidate[] = [];
  const matchedByCandidate = new Map<string, MatchCandidate>();

  function add(id: string, score: number, signals: SignalName[]): void {
    const cur = matchedByCandidate.get(id);
    if (cur) {
      if (score > cur.score) cur.score = score;
      for (const s of signals) {
        if (!cur.matchedFields.includes(s)) cur.matchedFields.push(s);
      }
    } else {
      candidates.push({
        existingEntityId: id,
        score,
        matchedFields: [...signals],
      });
      matchedByCandidate.set(id, candidates[candidates.length - 1]!);
    }
  }

  const stagingEmailNorm = normalize(staging.contactEmail);
  if (!staging.name || !stagingEmailNorm) {
    // Conservative: deals require both name + contactEmail for any match.
    return decisionFromCandidates(candidates);
  }

  const bucketCandidates = getBucketCandidates(nameBuckets, staging.name);
  for (const e of bucketCandidates) {
    if (!e.name) continue;
    if (!fuzzyEqual(staging.name, e.name, 0.15)) continue;
    const sameEmail = normalize(e.contact?.email) === stagingEmailNorm;
    if (!sameEmail) continue;

    const nameSim = Math.min(fuzzyScore(staging.name, e.name), 94);

    // Close-date window check — within 30 days = bump to 90 floor.
    const stagingDate = staging.expectedCloseDate;
    const existingDate = e.expectedCloseDate;
    const inWindow =
      stagingDate != null &&
      existingDate != null &&
      Math.abs(stagingDate.getTime() - existingDate.getTime()) <=
        30 * 24 * 60 * 60 * 1000;

    if (inWindow) {
      add(e.id, Math.max(nameSim, 90), [
        "name_fuzzy",
        "contact_email_exact",
        "close_date_window",
      ]);
    } else {
      add(e.id, Math.min(nameSim, 85), [
        "name_fuzzy",
        "contact_email_exact",
      ]);
    }
  }

  return decisionFromCandidates(candidates);
}

/**
 * Order matcher:
 *   1. providerOrderId exact → 100 (signal: provider_order_id_exact)
 *   2. orderNumber exact within tenant → 95 (signal: order_number_exact)
 *   3. orderNumber + contactEmail + placedAt within 24h → 90
 *      (signals: order_number_exact, contact_email_exact, placed_at_window)
 *   4. No matches → 'insert'
 *
 * Order dedup is high-stakes — wrong matches cause double-billing.
 * No fuzzy fallbacks on order number / provider id.
 */
export function matchOrder(
  staging: {
    orderNumber?: string | null;
    providerOrderId?: string | null;
    contactEmail?: string | null;
    placedAt?: Date | null;
    externalIds?: Record<string, string>;
  },
  existing: ExistingOrder[],
  orderNumberMap: Map<string, ExistingOrder[]>,
  providerIdMap: Map<string, ExistingOrder[]>,
  config?: MatchConfig<OrderMatchKey>,
): MatchDecision {
  // KAN-922 — Strict-match short-circuit.
  if (config?.matchKey) {
    const built: MatchCandidate[] = [];
    if (config.matchKey === "external_id" && config.externalSourceTag) {
      const tag = config.externalSourceTag;
      const stagingExtId = staging.externalIds?.[tag];
      if (stagingExtId) {
        for (const e of existing) {
          if (e.externalIds[tag] === stagingExtId) {
            built.push({ existingEntityId: e.id, score: 100, matchedFields: ["external_id_exact"] });
          }
        }
      }
    } else if (config.matchKey === "orderNumber") {
      if (staging.orderNumber) {
        const matches = orderNumberMap.get(staging.orderNumber) ?? [];
        for (const e of matches) {
          built.push({ existingEntityId: e.id, score: 100, matchedFields: ["order_number_exact"] });
        }
      }
    } else if (config.matchKey === "providerOrderId") {
      if (staging.providerOrderId) {
        const matches = providerIdMap.get(staging.providerOrderId) ?? [];
        for (const e of matches) {
          built.push({ existingEntityId: e.id, score: 100, matchedFields: ["provider_order_id_exact"] });
        }
      }
    }
    return decisionFromCandidates(built);
  }
  const candidates: MatchCandidate[] = [];
  const matchedByCandidate = new Map<string, MatchCandidate>();

  function add(id: string, score: number, signals: SignalName[]): void {
    const cur = matchedByCandidate.get(id);
    if (cur) {
      if (score > cur.score) cur.score = score;
      for (const s of signals) {
        if (!cur.matchedFields.includes(s)) cur.matchedFields.push(s);
      }
    } else {
      candidates.push({
        existingEntityId: id,
        score,
        matchedFields: [...signals],
      });
      matchedByCandidate.set(id, candidates[candidates.length - 1]!);
    }
  }

  // Rule 1 — providerOrderId exact (gold standard).
  if (staging.providerOrderId) {
    const matches = providerIdMap.get(staging.providerOrderId) ?? [];
    for (const e of matches) {
      add(e.id, 100, ["provider_order_id_exact"]);
    }
  }

  // Rule 2/3 — orderNumber exact, with optional contactEmail+placedAt window boost.
  if (staging.orderNumber) {
    const matches = orderNumberMap.get(staging.orderNumber) ?? [];
    for (const e of matches) {
      const stagingEmailNorm = normalize(staging.contactEmail);
      const existingEmailNorm = normalize(e.contact?.email);
      const sameEmail =
        stagingEmailNorm !== "" && stagingEmailNorm === existingEmailNorm;

      const stagingDate = staging.placedAt;
      const existingDate = e.placedAt;
      const inWindow =
        stagingDate != null &&
        existingDate != null &&
        Math.abs(stagingDate.getTime() - existingDate.getTime()) <=
          24 * 60 * 60 * 1000;

      if (sameEmail && inWindow) {
        // Rule 3 — bump to 90 floor with both signals.
        add(e.id, 90, [
          "order_number_exact",
          "contact_email_exact",
          "placed_at_window",
        ]);
      } else {
        // Rule 2 — orderNumber alone @ 95.
        add(e.id, 95, ["order_number_exact"]);
      }
    }
  }

  return decisionFromCandidates(candidates);
}

// ─────────────────────────────────────────────
// Aggregate counts
// ─────────────────────────────────────────────

interface PerEntityCount {
  total: number;
  exactMatches: number;
  fuzzyMatches: number;
  needsReview: number;
  insertOnly: number;
}

export interface DedupCounts {
  byEntity: {
    contacts: PerEntityCount;
    companies: PerEntityCount;
    deals: PerEntityCount;
    orders: PerEntityCount;
  };
  candidatesScanned: {
    contacts: number;
    companies: number;
    deals: number;
    orders: number;
  };
}

function emptyPerEntity(): PerEntityCount {
  return { total: 0, exactMatches: 0, fuzzyMatches: 0, needsReview: 0, insertOnly: 0 };
}

function tallyDecision(target: PerEntityCount, decision: MatchDecision): void {
  target.total += 1;
  if (decision.suggestedAction === "update") {
    if (decision.confidence === 100 || decision.confidence === 95) {
      target.exactMatches += 1;
    } else {
      target.fuzzyMatches += 1;
    }
  } else if (decision.suggestedAction === "needs_review") {
    target.needsReview += 1;
  } else if (decision.suggestedAction === "insert") {
    target.insertOnly += 1;
  }
}

// ─────────────────────────────────────────────
// Main orchestrator
// ─────────────────────────────────────────────

export async function runDuplicateDetection(
  prisma: PrismaClient,
  importJobId: string,
  tenantId: string,
): Promise<ImportJob> {
  const job = await prisma.importJob.findFirst({
    where: { id: importJobId, tenantId },
  });
  if (!job) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `Import job not found: ${importJobId}`,
    });
  }
  if (!job.rowClassificationConfirmedAt) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Row classification must be confirmed before running duplicate detection",
    });
  }

  const startedAt = new Date();
  await prisma.importJob.update({
    where: { id: importJobId },
    data: {
      dedupStartedAt: startedAt,
      dedupCompletedAt: null,
      dedupError: null,
      dedupErrorAt: null,
      dedupCounts: null as never,
      dedupCandidatesCount: null,
    },
  });

  try {
    // 1. Pull staging rows + existing canonical entities (tenant-scoped).
    const [
      stagingContacts,
      stagingCompanies,
      stagingDeals,
      stagingOrders,
      existingContacts,
      existingCompanies,
      existingDeals,
      existingOrders,
    ] = await Promise.all([
      prisma.importStagingContact.findMany({ where: { importJobId } }),
      prisma.importStagingCompany.findMany({ where: { importJobId } }),
      prisma.importStagingDeal.findMany({ where: { importJobId } }),
      prisma.importStagingOrder.findMany({ where: { importJobId } }),
      prisma.contact.findMany({
        where: { tenantId },
        select: {
          id: true, email: true, phone: true, firstName: true,
          lastName: true, companyName: true,
          // KAN-922 — needed for matchKey='external_id' lookups.
          externalIds: true,
        },
      }),
      prisma.company.findMany({
        where: { tenantId },
        select: { id: true, name: true, legalName: true, domain: true, externalIds: true },
      }),
      prisma.deal.findMany({
        where: { tenantId },
        select: {
          id: true,
          name: true,
          expectedCloseDate: true,
          contact: { select: { email: true } },
          externalIds: true,
        },
      }),
      prisma.order.findMany({
        where: { tenantId },
        select: {
          id: true,
          orderNumber: true,
          providerOrderId: true,
          placedAt: true,
          contact: { select: { email: true } },
          externalIds: true,
        },
      }),
    ]);

    // KAN-922 — Project canonical entity externalIds JSON → typed
    // Record<string,string> so matchers can do strict equality lookups.
    // Prisma returns JsonValue; coerce defensively.
    const projectJsonRecord = (v: unknown): Record<string, string> => {
      if (!v || typeof v !== "object" || Array.isArray(v)) return {};
      const out: Record<string, string> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (typeof val === "string") out[k] = val;
      }
      return out;
    };
    const existingContactsTyped: ExistingContact[] = existingContacts.map((c) => ({
      id: c.id, email: c.email, phone: c.phone, firstName: c.firstName,
      lastName: c.lastName, companyName: c.companyName,
      externalIds: projectJsonRecord(c.externalIds),
    }));
    const existingCompaniesTyped: ExistingCompany[] = existingCompanies.map((c) => ({
      id: c.id, name: c.name, legalName: c.legalName, domain: c.domain,
      externalIds: projectJsonRecord(c.externalIds),
    }));
    const existingDealsTyped: ExistingDeal[] = existingDeals.map((d) => ({
      id: d.id, name: d.name, expectedCloseDate: d.expectedCloseDate,
      contact: d.contact, externalIds: projectJsonRecord(d.externalIds),
    }));
    const existingOrdersTyped: ExistingOrder[] = existingOrders.map((o) => ({
      id: o.id, orderNumber: o.orderNumber, providerOrderId: o.providerOrderId,
      placedAt: o.placedAt, contact: o.contact,
      externalIds: projectJsonRecord(o.externalIds),
    }));

    // 1.5 — KAN-915 mirror-column back-fill (LOAD-BEARING).
    //
    // Mirror columns on import_staging_* tables are a LAZY CACHE of the
    // (sourceRowData × fieldMappings) projection. KAN-907 row-class
    // intentionally leaves them NULL because mapping may happen after
    // classification in the UI flow (Card 4 → Card 5). Dedup matchers
    // read mirror columns directly — so we MUST project + persist them
    // here, before the matcher loop runs.
    //
    // Without this back-fill, every matcher's `if (!staging.email)`
    // short-circuit fires for every row → 100% false-negative dedup
    // results (caught by KAN-913 PROD smoke 2026-05-13).
    //
    // Idempotent: writes the same projected values on every dedup run.
    // Acceptable for V1 — Postgres no-op UPDATE cost is negligible at
    // staging-table row counts.
    const fieldMappings: FieldMappingEntryLike[] = Array.isArray(job.fieldMappings)
      ? (job.fieldMappings as unknown as FieldMappingEntryLike[])
      : [];

    // KAN-922 — load per-import match configuration. NULL columns fall
    // back to the heuristic cascade in the matcher (backwards compat).
    const externalSourceTag = job.externalSourceTag ?? null;
    const dedupMatchField = job.dedupMatchField ?? null;

    function projectionCtx(row: { sourceRowIndex: number }) {
      return {
        tenantId,
        importJobId,
        sourceRowIndex: row.sourceRowIndex,
      };
    }

    // In-memory patching: matchers receive the staging objects directly
    // from these arrays, so we MUST mutate them with the projected values
    // alongside the DB UPDATEs (otherwise the in-memory rows still hold
    // the NULL mirror cols and matchers continue to short-circuit).
    const stagingContactUpdates = stagingContacts.map((s) => {
      const projected = projectRow(
        (s.sourceRowData ?? {}) as Record<string, unknown>,
        fieldMappings,
        "contacts",
        projectionCtx(s),
        externalSourceTag,
      ) as ProjectedContact;
      const mirror = projectedContactMirrorColumns(projected);
      Object.assign(s, mirror);
      return prisma.importStagingContact.update({
        where: { id: s.id },
        data: mirror as never,
      });
    });
    const stagingCompanyUpdates = stagingCompanies.map((s) => {
      const projected = projectRow(
        (s.sourceRowData ?? {}) as Record<string, unknown>,
        fieldMappings,
        "companies",
        projectionCtx(s),
        externalSourceTag,
      ) as ProjectedCompany;
      const mirror = projectedCompanyMirrorColumns(projected);
      Object.assign(s, mirror);
      return prisma.importStagingCompany.update({
        where: { id: s.id },
        data: mirror as never,
      });
    });
    const stagingDealUpdates = stagingDeals.map((s) => {
      const projected = projectRow(
        (s.sourceRowData ?? {}) as Record<string, unknown>,
        fieldMappings,
        "deals",
        projectionCtx(s),
        externalSourceTag,
      ) as ProjectedDeal;
      const mirror = projectedDealMirrorColumns(projected);
      Object.assign(s, mirror);
      return prisma.importStagingDeal.update({
        where: { id: s.id },
        data: mirror as never,
      });
    });
    const stagingOrderUpdates = stagingOrders.map((s) => {
      const projected = projectRow(
        (s.sourceRowData ?? {}) as Record<string, unknown>,
        fieldMappings,
        "orders",
        projectionCtx(s),
        externalSourceTag,
      ) as ProjectedOrder;
      const mirror = projectedOrderMirrorColumns(projected);
      Object.assign(s, mirror);
      return prisma.importStagingOrder.update({
        where: { id: s.id },
        data: mirror as never,
      });
    });

    if (
      stagingContactUpdates.length > 0 ||
      stagingCompanyUpdates.length > 0 ||
      stagingDealUpdates.length > 0 ||
      stagingOrderUpdates.length > 0
    ) {
      await prisma.$transaction([
        ...stagingContactUpdates,
        ...stagingCompanyUpdates,
        ...stagingDealUpdates,
        ...stagingOrderUpdates,
      ]);
    }

    // 2. Build buckets + exact-lookup maps.
    const contactNameBuckets = buildBuckets(existingContactsTyped, (c) =>
      [c.firstName, c.lastName].filter((p): p is string => !!p).join(" "),
    );
    const companyNameBuckets = buildBuckets(existingCompaniesTyped, (c) => c.name);
    const dealNameBuckets = buildBuckets(existingDealsTyped, (d) => d.name);

    const orderNumberMap = new Map<string, ExistingOrder[]>();
    for (const o of existingOrdersTyped) {
      const arr = orderNumberMap.get(o.orderNumber) ?? [];
      arr.push(o);
      orderNumberMap.set(o.orderNumber, arr);
    }
    const providerIdMap = new Map<string, ExistingOrder[]>();
    for (const o of existingOrdersTyped) {
      if (o.providerOrderId) {
        const arr = providerIdMap.get(o.providerOrderId) ?? [];
        arr.push(o);
        providerIdMap.set(o.providerOrderId, arr);
      }
    }

    // 3. Run matchers row-by-row and write decisions back to staging.
    const counts: DedupCounts = {
      byEntity: {
        contacts: emptyPerEntity(),
        companies: emptyPerEntity(),
        deals: emptyPerEntity(),
        orders: emptyPerEntity(),
      },
      candidatesScanned: {
        contacts: existingContactsTyped.length,
        companies: existingCompaniesTyped.length,
        deals: existingDealsTyped.length,
        orders: existingOrdersTyped.length,
      },
    };

    // KAN-922 — per-entity MatchConfig threaded into each matcher. The
    // dedupMatchField loaded from ImportJob is a free-form string; cast
    // narrowly here (saveFieldMappings already validated it against the
    // per-entity allow-list). NULL → undefined → matcher falls through
    // to heuristic cascade.
    const contactConfig: MatchConfig<ContactMatchKey> = {
      matchKey: (dedupMatchField as ContactMatchKey | null) ?? undefined,
      externalSourceTag,
    };
    const companyConfig: MatchConfig<CompanyMatchKey> = {
      matchKey: (dedupMatchField as CompanyMatchKey | null) ?? undefined,
      externalSourceTag,
    };
    const dealConfig: MatchConfig<DealMatchKey> = {
      matchKey: (dedupMatchField as DealMatchKey | null) ?? undefined,
      externalSourceTag,
    };
    const orderConfig: MatchConfig<OrderMatchKey> = {
      matchKey: (dedupMatchField as OrderMatchKey | null) ?? undefined,
      externalSourceTag,
    };

    // Bulk-collect updates as small transactions per-entity-table.
    const contactUpdates = stagingContacts.map((s) => {
      const decision = matchContact(s as never, existingContactsTyped, contactNameBuckets, contactConfig);
      tallyDecision(counts.byEntity.contacts, decision);
      return prisma.importStagingContact.update({
        where: { id: s.id },
        data: { matchDecision: decision as never },
      });
    });
    const companyUpdates = stagingCompanies.map((s) => {
      const decision = matchCompany(s as never, existingCompaniesTyped, companyNameBuckets, companyConfig);
      tallyDecision(counts.byEntity.companies, decision);
      return prisma.importStagingCompany.update({
        where: { id: s.id },
        data: { matchDecision: decision as never },
      });
    });
    const dealUpdates = stagingDeals.map((s) => {
      const decision = matchDeal(s as never, existingDealsTyped, dealNameBuckets, dealConfig);
      tallyDecision(counts.byEntity.deals, decision);
      return prisma.importStagingDeal.update({
        where: { id: s.id },
        data: { matchDecision: decision as never },
      });
    });
    const orderUpdates = stagingOrders.map((s) => {
      const decision = matchOrder(s as never, existingOrdersTyped, orderNumberMap, providerIdMap, orderConfig);
      tallyDecision(counts.byEntity.orders, decision);
      return prisma.importStagingOrder.update({
        where: { id: s.id },
        data: { matchDecision: decision as never },
      });
    });

    await prisma.$transaction([
      ...contactUpdates,
      ...companyUpdates,
      ...dealUpdates,
      ...orderUpdates,
    ]);

    // 4. Persist ImportJob aggregate state.
    const totalCandidates =
      existingContactsTyped.length +
      existingCompaniesTyped.length +
      existingDealsTyped.length +
      existingOrdersTyped.length;

    return await prisma.importJob.update({
      where: { id: importJobId },
      data: {
        dedupCounts: counts as never,
        dedupCandidatesCount: totalCandidates,
        dedupCompletedAt: new Date(),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.importJob.update({
      where: { id: importJobId },
      data: {
        dedupError: message,
        dedupErrorAt: new Date(),
      },
    });
    throw err;
  }
}

// ─────────────────────────────────────────────
// overrideStagingDecision — operator per-row override
// ─────────────────────────────────────────────

export async function overrideStagingDecision(
  prisma: PrismaClient,
  tenantId: string,
  input: {
    stagingId: string;
    entityType: EntityType;
    newAction: SuggestedAction;
    chosenCandidateId?: string;
  },
): Promise<{ ok: true }> {
  const { stagingId, entityType, newAction, chosenCandidateId } = input;

  if (newAction === "update" && !chosenCandidateId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "chosenCandidateId is required when newAction is 'update'",
    });
  }

  // Find the staging row + verify tenant scope.
  const stagingRow = await loadStagingRow(prisma, entityType, stagingId, tenantId);
  if (!stagingRow) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `Staging row not found: ${entityType}/${stagingId}`,
    });
  }

  // Build the user-choice record + merge into existing matchDecision JSON.
  const existing = (stagingRow.matchDecision ?? {}) as Partial<MatchDecision>;
  const updated: MatchDecision = {
    candidates: existing.candidates ?? [],
    suggestedAction: existing.suggestedAction ?? "insert",
    confidence: existing.confidence ?? 0,
    suggestedReason: existing.suggestedReason ?? "",
    userChoice: {
      action: newAction,
      ...(chosenCandidateId ? { chosenCandidateId } : {}),
      overriddenAt: new Date().toISOString(),
    },
  };

  await updateStagingDecision(prisma, entityType, stagingId, updated);
  return { ok: true };
}

// ─────────────────────────────────────────────
// confirmDuplicateResolution — final gate before commit
// ─────────────────────────────────────────────

export async function confirmDuplicateResolution(
  prisma: PrismaClient,
  importJobId: string,
  tenantId: string,
): Promise<ImportJob> {
  const job = await prisma.importJob.findFirst({
    where: { id: importJobId, tenantId },
  });
  if (!job) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `Import job not found: ${importJobId}`,
    });
  }
  if (!job.dedupCompletedAt) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Run duplicate detection before confirming",
    });
  }

  // Validate every needs_review row has been overridden.
  const [contacts, companies, deals, orders] = await Promise.all([
    prisma.importStagingContact.findMany({
      where: { importJobId },
      select: { id: true, sourceRowIndex: true, matchDecision: true },
    }),
    prisma.importStagingCompany.findMany({
      where: { importJobId },
      select: { id: true, sourceRowIndex: true, matchDecision: true },
    }),
    prisma.importStagingDeal.findMany({
      where: { importJobId },
      select: { id: true, sourceRowIndex: true, matchDecision: true },
    }),
    prisma.importStagingOrder.findMany({
      where: { importJobId },
      select: { id: true, sourceRowIndex: true, matchDecision: true },
    }),
  ]);

  const unresolved: string[] = [];
  for (const row of [...contacts, ...companies, ...deals, ...orders]) {
    const md = row.matchDecision as Partial<MatchDecision> | null;
    if (!md) continue;
    if (md.suggestedAction === "needs_review" && !md.userChoice) {
      unresolved.push(`row index ${row.sourceRowIndex}`);
    }
  }
  if (unresolved.length > 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Cannot confirm — ${unresolved.length} row(s) still need review: ${unresolved.slice(0, 5).join(", ")}${unresolved.length > 5 ? "…" : ""}`,
    });
  }

  return prisma.importJob.update({
    where: { id: importJobId },
    data: { dedupConfirmedAt: new Date() },
  });
}

// ─────────────────────────────────────────────
// Helpers — staging row loader + decision writer
// ─────────────────────────────────────────────

async function loadStagingRow(
  prisma: PrismaClient,
  entityType: EntityType,
  stagingId: string,
  tenantId: string,
): Promise<{ id: string; matchDecision: unknown } | null> {
  if (entityType === "contacts") {
    return prisma.importStagingContact.findFirst({
      where: { id: stagingId, tenantId },
      select: { id: true, matchDecision: true },
    });
  }
  if (entityType === "companies") {
    return prisma.importStagingCompany.findFirst({
      where: { id: stagingId, tenantId },
      select: { id: true, matchDecision: true },
    });
  }
  if (entityType === "deals") {
    return prisma.importStagingDeal.findFirst({
      where: { id: stagingId, tenantId },
      select: { id: true, matchDecision: true },
    });
  }
  return prisma.importStagingOrder.findFirst({
    where: { id: stagingId, tenantId },
    select: { id: true, matchDecision: true },
  });
}

async function updateStagingDecision(
  prisma: PrismaClient,
  entityType: EntityType,
  stagingId: string,
  decision: MatchDecision,
): Promise<void> {
  if (entityType === "contacts") {
    await prisma.importStagingContact.update({
      where: { id: stagingId },
      data: { matchDecision: decision as never },
    });
    return;
  }
  if (entityType === "companies") {
    await prisma.importStagingCompany.update({
      where: { id: stagingId },
      data: { matchDecision: decision as never },
    });
    return;
  }
  if (entityType === "deals") {
    await prisma.importStagingDeal.update({
      where: { id: stagingId },
      data: { matchDecision: decision as never },
    });
    return;
  }
  await prisma.importStagingOrder.update({
    where: { id: stagingId },
    data: { matchDecision: decision as never },
  });
}

// ─────────────────────────────────────────────
// getStagingForReview — UI query
// ─────────────────────────────────────────────

export async function getStagingForReview(
  prisma: PrismaClient,
  tenantId: string,
  input: {
    importJobId: string;
    entityType: EntityType;
    filterAction?: SuggestedAction;
  },
): Promise<{
  rows: Array<{
    id: string;
    sourceRowIndex: number;
    sourceRowData: unknown;
    matchDecision: MatchDecision | null;
  }>;
  count: number;
}> {
  // Verify tenant + job scope first.
  const job = await prisma.importJob.findFirst({
    where: { id: input.importJobId, tenantId },
    select: { id: true },
  });
  if (!job) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `Import job not found: ${input.importJobId}`,
    });
  }

  const where: Record<string, unknown> = { importJobId: input.importJobId };

  const select = {
    id: true,
    sourceRowIndex: true,
    sourceRowData: true,
    matchDecision: true,
  } as const;

  let rows: Array<{
    id: string;
    sourceRowIndex: number;
    sourceRowData: unknown;
    matchDecision: unknown;
  }>;

  if (input.entityType === "contacts") {
    rows = await prisma.importStagingContact.findMany({
      where,
      select,
      orderBy: { sourceRowIndex: "asc" },
    });
  } else if (input.entityType === "companies") {
    rows = await prisma.importStagingCompany.findMany({
      where,
      select,
      orderBy: { sourceRowIndex: "asc" },
    });
  } else if (input.entityType === "deals") {
    rows = await prisma.importStagingDeal.findMany({
      where,
      select,
      orderBy: { sourceRowIndex: "asc" },
    });
  } else {
    rows = await prisma.importStagingOrder.findMany({
      where,
      select,
      orderBy: { sourceRowIndex: "asc" },
    });
  }

  // Filter by action (after fetch — match decision is JSON).
  const filtered = input.filterAction
    ? rows.filter((r) => {
        const md = r.matchDecision as Partial<MatchDecision> | null;
        const action = md?.userChoice?.action ?? md?.suggestedAction;
        return action === input.filterAction;
      })
    : rows;

  return {
    rows: filtered.map((r) => ({
      id: r.id,
      sourceRowIndex: r.sourceRowIndex,
      sourceRowData: r.sourceRowData,
      matchDecision: (r.matchDecision as MatchDecision | null) ?? null,
    })),
    count: filtered.length,
  };
}
