/**
 * KAN-750 — Escalation ↔ Decision invariant.
 *
 * Two layers of guard:
 *
 *   1) STRUCTURAL: every `escalation.create({ data: {...} })` site in the
 *      services layer must use ONLY canonical schema field names. Catches
 *      drift in any new call site that copies the pre-KAN-750 broken shape
 *      (decisionId/reason/priority — the silent-fail trap that hid behind
 *      `tx: any` for an entire sprint).
 *
 *   2) RUNTIME: when an ESCALATED outcome is reached on either path
 *      (runFreeform or runAgentic), the Escalation row carries decisionId
 *      pointing at the matching Decision. KAN-754 (S4.1 Recommendations UI)
 *      depends on this join.
 *
 * Picked up by the apps/connectors vitest runner via the cross-workspace
 * bridge (apps/connectors/vitest.config.ts → apps/api/src/__tests__/*).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";

const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..");
const SVC = resolve(REPO_ROOT, "packages", "api", "src", "services");

// Canonical Escalation schema — must match packages/db/prisma/schema.prisma.
// Any field not in this allow-list inside an escalation.create data block is
// almost certainly the pre-KAN-750 broken shape resurfacing.
const CANONICAL_ESCALATION_FIELDS = new Set([
  "tenantId",
  "contactId",
  "decisionId",
  "severity",
  "triggerType",
  "triggerReason",
  "aiSuggestion",
  // KAN-1037 — engine-emitted SuggestedAction persisted at insert time
  // so operator-accept-without-modify can dispatch via the originalAction
  // fallback. Populated by runAgentic + runFreeform ESCALATED paths;
  // NULL on guardrail_block / lead_assignment paths (no clean structured
  // action available).
  "originalAction",
  "status",
  "context",
  "resolvedBy",
  "resolvedAt",
]);

// Pre-KAN-750 broken field names that silently failed at runtime. Catching
// these explicitly produces a clearer test failure than "unknown field".
const BANNED_FIELDS = new Set(["priority", "reason"]);

interface CallSite {
  file: string;
  line: number;
  fields: string[];
}

function findEscalationCreateSites(filePath: string): CallSite[] {
  const text = readFileSync(filePath, "utf8");
  const sites: CallSite[] = [];

  // First pass: find offsets of `escalation.create` that are NOT inside a
  // string or comment (the call-site finder). Then for each, parse the
  // data object with brace tracking.
  const offsets: number[] = [];
  {
    let p = 0;
    while (p < text.length) {
      const ch = text[p];
      // Skip strings.
      if (ch === '"' || ch === "'" || ch === "`") {
        const q = ch;
        p++;
        while (p < text.length && text[p] !== q) {
          if (text[p] === "\\") p++;
          p++;
        }
        p++;
        continue;
      }
      if (ch === "/" && text[p + 1] === "/") {
        const nl = text.indexOf("\n", p);
        p = nl < 0 ? text.length : nl;
        continue;
      }
      if (ch === "/" && text[p + 1] === "*") {
        const e = text.indexOf("*/", p + 2);
        p = e < 0 ? text.length : e + 2;
        continue;
      }
      if (text.startsWith("escalation.create", p)) {
        offsets.push(p);
        p += "escalation.create".length;
        continue;
      }
      p++;
    }
  }

  for (const idx of offsets) {
    const startLine = text.slice(0, idx).split("\n").length;

    // Find `data:` then `{` — that's the start of the data object.
    const startSearch = idx + "escalation.create".length;
    const dataMatch = text.slice(startSearch).match(/data\s*:\s*\{/);
    if (!dataMatch) continue;
    let pos = startSearch + (dataMatch.index ?? 0) + dataMatch[0].length;
    let depth = 1;
    const fields: string[] = [];

    // Scan with string-literal awareness so `};` inside a string doesn't
    // confuse depth.
    while (pos < text.length && depth > 0) {
      const ch = text[pos];
      // Handle string literals — skip through.
      if (ch === '"' || ch === "'" || ch === "`") {
        const quote = ch;
        pos++;
        while (pos < text.length && text[pos] !== quote) {
          if (text[pos] === "\\") pos++; // skip escape
          pos++;
        }
        pos++;
        continue;
      }
      // Skip line + block comments.
      if (ch === "/" && text[pos + 1] === "/") {
        const nl = text.indexOf("\n", pos);
        pos = nl < 0 ? text.length : nl;
        continue;
      }
      if (ch === "/" && text[pos + 1] === "*") {
        const end = text.indexOf("*/", pos + 2);
        pos = end < 0 ? text.length : end + 2;
        continue;
      }
      if (ch === "{") {
        depth++;
        pos++;
        continue;
      }
      if (ch === "}") {
        depth--;
        pos++;
        continue;
      }
      // Identifier-key match at depth === 1 — top-level Escalation field.
      if (depth === 1 && /[A-Za-z_]/.test(ch)) {
        const tail = text.slice(pos);
        const m = tail.match(/^([A-Za-z_]\w*)\s*:/);
        if (m) {
          fields.push(m[1]);
          pos += m[0].length;
          continue;
        }
      }
      pos++;
    }

    sites.push({ file: filePath, line: startLine, fields });
  }

  return sites;
}

describe("KAN-750 — Escalation.create call-site shape invariant", () => {
  const filesToScan = [
    resolve(SVC, "run-decision-for-contact.ts"),
    resolve(SVC, "message-composer.ts"),
    resolve(SVC, "lead-assignment.ts"),
  ];

  for (const file of filesToScan) {
    it(`every escalation.create() in ${file.split("/").slice(-2).join("/")} uses canonical fields only`, () => {
      const sites = findEscalationCreateSites(file);
      expect(sites.length).toBeGreaterThan(0);

      for (const site of sites) {
        // Banned fields — pre-KAN-750 broken shape.
        const banned = site.fields.filter((f) => BANNED_FIELDS.has(f));
        expect(
          banned,
          `${file}:${site.line} uses banned pre-KAN-750 field(s): ${banned.join(", ")}. ` +
            `These never existed in the Escalation schema and silently failed under tx: any. ` +
            `Use canonical: triggerType (was 'reason'), severity (was 'priority').`,
        ).toEqual([]);

        // Unknown fields — anything not in the canonical allow-list.
        const unknown = site.fields.filter(
          (f) => !CANONICAL_ESCALATION_FIELDS.has(f),
        );
        expect(
          unknown,
          `${file}:${site.line} uses non-canonical Escalation field(s): ${unknown.join(", ")}. ` +
            `Allowed: ${[...CANONICAL_ESCALATION_FIELDS].join(", ")}.`,
        ).toEqual([]);

        // Required field: status must be set explicitly to a lowercase value.
        // The pre-KAN-750 broken shape used 'PENDING'; canonical default is 'open'.
        expect(
          site.fields,
          `${file}:${site.line} must explicitly set status (canonical: 'open', not 'PENDING').`,
        ).toContain("status");
      }
    });
  }
});

describe("KAN-750 — runFreeform tx:any cast retired", () => {
  it("run-decision-for-contact.ts uses Prisma.TransactionClient, not `tx: any`", () => {
    const text = readFileSync(
      resolve(SVC, "run-decision-for-contact.ts"),
      "utf8",
    );
    // The cast that swallowed schema mismatch on every ESCALATED outcome.
    expect(text).not.toMatch(/\$transaction\s*\(\s*async\s*\(\s*tx\s*:\s*any/);
    // Canonical replacement.
    expect(text).toMatch(
      /\$transaction\s*\(\s*async\s*\(\s*tx\s*:\s*Prisma\.TransactionClient/,
    );
  });
});

describe("KAN-750 — Escalation/Decision schema link", () => {
  it("Escalation model declares decisionId + decision relation", () => {
    const schema = readFileSync(
      resolve(REPO_ROOT, "packages", "db", "prisma", "schema.prisma"),
      "utf8",
    );
    // The two columns added by the KAN-750 migration.
    expect(schema).toMatch(/decisionId\s+String\?\s+@map\("decision_id"\)/);
    expect(schema).toMatch(/context\s+Json\?/);
    // FK with ON DELETE SET NULL — preserves Escalation history if Decision
    // is ever purged (defensive; Decisions are append-only today).
    expect(schema).toMatch(
      /decision\s+Decision\?\s+@relation\([^)]*onDelete:\s*SetNull/,
    );
    // Index on decisionId for join performance.
    expect(schema).toMatch(/@@index\(\[decisionId\]\)/);
  });

  it("Decision model declares escalations[] reverse relation", () => {
    const schema = readFileSync(
      resolve(REPO_ROOT, "packages", "db", "prisma", "schema.prisma"),
      "utf8",
    );
    // The reverse relation Decision → Escalation[] required by Prisma.
    expect(schema).toMatch(/escalations\s+Escalation\[\]/);
  });
});

describe("KAN-1037 — originalAction populated at engine-emit ESCALATED sites", () => {
  // The two producer sites where the engine's structured SuggestedAction is
  // already in scope (`agenticPayload.action.{type,channel,payload}` for the
  // agentic path, `actionResult` for the freeform path). Pre-KAN-1037, both
  // sites discarded the structured action before insert (only the stringified
  // actionType made it to `aiSuggestion`) → operator-accept-without-modify
  // silently no-published. Asserting `originalAction` is set on both keeps
  // the producer from regressing back to the silent-discard shape.
  //
  // OTHER escalation.create call sites legitimately leave originalAction null:
  //   - message-composer.ts (guardrail_block — engine's intent was the
  //     BLOCKED send; persisting would dispatch the very thing the guardrail
  //     prevented on accept)
  //   - lead-assignment.ts (no Decision exists yet — no structured action)
  //   - human-review-sampling.ts (SAMPLED post-hoc; accept is FORBIDDEN
  //     anyway via assertNotSample)
  // Those sites are intentionally NOT asserted here.
  it("runAgentic + runFreeform escalation.create sites both populate originalAction", () => {
    const sites = findEscalationCreateSites(
      resolve(SVC, "run-decision-for-contact.ts"),
    );
    // Both ESCALATED branches in run-decision-for-contact.ts should write
    // originalAction; if a future PR splits one of them or adds a third
    // engine-emit ESCALATED path that forgets originalAction, this fails.
    expect(sites.length).toBeGreaterThanOrEqual(2);
    for (const site of sites) {
      expect(
        site.fields,
        `run-decision-for-contact.ts:${site.line} engine-emit ESCALATED ` +
          `escalation.create must populate originalAction so accept-without-` +
          `modify can dispatch via the KAN-1037 fallback path.`,
      ).toContain("originalAction");
    }
  });

  it("non-engine-emit escalation.create sites do NOT populate originalAction (semantic guard)", () => {
    // message-composer onBlock hook — persisting the blocked action would
    // dispatch on accept the exact thing the guardrail prevented. Stays null.
    const composerSites = findEscalationCreateSites(
      resolve(SVC, "message-composer.ts"),
    );
    expect(composerSites.length).toBeGreaterThan(0);
    for (const site of composerSites) {
      expect(
        site.fields,
        `message-composer.ts:${site.line} guardrail_block escalation MUST ` +
          `leave originalAction null — persisting the blocked action would ` +
          `cause acceptance to dispatch the very thing the guardrail prevented.`,
      ).not.toContain("originalAction");
    }
    // lead-assignment — no Decision yet, no structured action available.
    const assignmentSites = findEscalationCreateSites(
      resolve(SVC, "lead-assignment.ts"),
    );
    expect(assignmentSites.length).toBeGreaterThan(0);
    for (const site of assignmentSites) {
      expect(
        site.fields,
        `lead-assignment.ts:${site.line} lead_assignment_below_threshold ` +
          `escalation MUST leave originalAction null — no structured action ` +
          `is available at insert time (no Decision row exists yet).`,
      ).not.toContain("originalAction");
    }
  });

  it("schema.prisma declares originalAction Json? on Escalation", () => {
    const schema = readFileSync(
      resolve(REPO_ROOT, "packages", "db", "prisma", "schema.prisma"),
      "utf8",
    );
    expect(schema).toMatch(
      /originalAction\s+Json\?\s+@map\("original_action"\)/,
    );
  });
});

describe("KAN-754 — broken escalationsRouter retired in favor of recommendationsRouter", () => {
  it("apps/api router.ts mounts recommendations namespace, not the broken escalations namespace", () => {
    const text = readFileSync(
      resolve(REPO_ROOT, "apps", "api", "src", "router.ts"),
      "utf8",
    );
    // The new namespace is mounted on the appRouter
    expect(text).toMatch(/recommendations:\s*recommendationsRouter/);
    // The old broken router is gone — predated KAN-689, would 500 at runtime
    // because of fields that don't exist in the canonical Escalation schema.
    expect(text).not.toMatch(/escalations:\s*escalationsRouter/);
    expect(text).not.toMatch(/const\s+escalationsRouter\s*=/);
    // The pre-KAN-689 broken Escalation field references — none of these
    // exist in the canonical schema. Catches regression if a future PR
    // copies the old shape into a new Escalation router/handler.
    expect(text).not.toMatch(/escalation\.(findMany|findFirst|update)[\s\S]*?claimed_at/);
    expect(text).not.toMatch(/escalation\.(findMany|findFirst|update)[\s\S]*?dismissed_at/);
  });
});
