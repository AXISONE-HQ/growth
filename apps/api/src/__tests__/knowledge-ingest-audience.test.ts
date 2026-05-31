/**
 * KAN-732 — structural regression guard for OIDC audience handling across
 * all push subscribers.
 *
 * Originally KAN-731's typo-safety test for `KNOWLEDGE_INGEST_AUDIENCE`.
 * Repurposed by KAN-732: now asserts the canonical request-URL-derived
 * pattern across all subscribers + that the retired env-var reads can't
 * reintroduce.
 *
 * The audience-mismatch class (KAN-731 + KAN-741 + KAN-745 PR B fix-forward
 * — three incidents in two sprints) is now structurally impossible: every
 * subscriber goes through `verifyPubsubOidc(c)` from the shared helper.
 * This test catches any regression that copy-pastes the old per-subscriber
 * env-var pattern back into the codebase.
 *
 * **SCOPE NOTE (KAN-774):** Filename `knowledge-ingest-audience.test.ts` is
 * historical — this suite now covers ALL push subscribers (KAN-732's 4 +
 * KAN-774's lead-received-push = 5 total). KAN-776 tracks the rename to
 * `pubsub-subscriber-audience.test.ts` (Sprint 6+, Low; single-file rename
 * PR with zero cohort impact). Filename retained until the rename ticket
 * lands so this file's git history stays continuous.
 *
 * **ADDING A NEW PUSH SUBSCRIBER:** add the filename to `SUBSCRIBERS` below.
 * Drift-prevention guarantees apply automatically: import-shape, no-local-
 * helper, no-local-OAuth2Client, no-retired-env-var. KAN-732's audience-
 * mismatch class stays structurally impossible for the new subscriber.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SUBSCRIBERS = [
  "action-decided-push.ts",
  "action-executed-push.ts",
  "knowledge-ingest-push.ts",
  "llm-call-push.ts",
  "lead-received-push.ts", // KAN-774 — Lead Inbox consumer subscriber
  "contact-replied-push.ts", // KAN-1037-PR3 — M3-2.5c engine re-evaluation trigger
];

function loadSrc(name: string): string {
  const p = resolve(__dirname, "../subscribers", name);
  return readFileSync(p, "utf8");
}

describe("KAN-732 — push subscribers use shared OIDC helper", () => {
  for (const name of SUBSCRIBERS) {
    it(`${name} imports verifyPubsubOidc from the shared helper`, () => {
      const src = loadSrc(name);
      expect(src).toContain("verifyPubsubOidc");
      expect(src).toMatch(/from ["']\.\.\/lib\/oidc-pubsub-verify\.js["']/);
    });

    it(`${name} does NOT define a local verifyOidc helper`, () => {
      const src = loadSrc(name);
      // Local helpers retired — every subscriber delegates to the shared one.
      expect(src).not.toMatch(/async function verifyOidc\s*\(/);
    });

    it(`${name} does NOT instantiate a local OAuth2Client`, () => {
      const src = loadSrc(name);
      // OAuth2Client is now scoped inside the shared helper.
      expect(src).not.toContain("new OAuth2Client()");
    });
  }
});

describe("KAN-732 — retired audience env-var reads stay retired", () => {
  // Three incidents motivated KAN-732 (KAN-731 / KAN-741 / KAN-745 PR B).
  // The fix-forward env vars are no longer read by ANY subscriber. Catches
  // any regression that pastes the old pattern back.
  const RETIRED_ENV_VARS = [
    "process.env.APP_API_URL",
    "process.env.KNOWLEDGE_INGEST_AUDIENCE",
    "process.env.LLM_CALL_AUDIENCE",
    "process.env.LEAD_RECEIVED_AUDIENCE", // KAN-774 — never adopted; structurally
                                          // unneeded post-KAN-732 (verifyPubsubOidc
                                          // derives audience from request URL).
    "process.env.CONTACT_REPLIED_AUDIENCE", // KAN-1037-PR3 — same posture as
                                            // LEAD_RECEIVED_AUDIENCE; never adopted
                                            // (URL-derived audience under KAN-732).
  ];

  for (const name of SUBSCRIBERS) {
    for (const envVar of RETIRED_ENV_VARS) {
      it(`${name} does NOT reference ${envVar}`, () => {
        const src = loadSrc(name);
        expect(src).not.toContain(envVar);
      });
    }
  }
});
