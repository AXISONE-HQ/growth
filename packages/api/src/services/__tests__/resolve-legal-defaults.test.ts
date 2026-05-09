/**
 * KAN-852 — resolveLegalDefaults() resolver coverage.
 *
 * No consumer in Cohort 1 (the helper exists for Cohort 4's Legal tab UI),
 * but pinning the resolution semantics now prevents drift when Cohort 4
 * imports it. Five-case matrix per Fred's brief:
 *
 *   1. defaultLanguage='fr', no override → French Blueprint default
 *   2. defaultLanguage='en', no override → English Blueprint default
 *   3. defaultLanguage='es' (unsupported), no override → English fallback
 *   4. tenant override set → wins over Blueprint regardless of language
 *   5. legalDefaults missing/malformed → throws with clear error message
 */
import { describe, it, expect } from "vitest";
import { resolveLegalDefaults } from "../blueprint-loader.js";

const KEYED_DEFAULTS = {
  en: {
    optOutLanguage: "Reply STOP to unsubscribe.",
    emailFooterDisclosure:
      "You received this email because you opted in or have an existing relationship with us. " +
      "To stop receiving these emails, click the unsubscribe link in this message. " +
      "[Business Name] · [Physical Mailing Address]",
  },
  fr: {
    optOutLanguage: "Répondez STOP pour vous désabonner.",
    emailFooterDisclosure:
      "Vous recevez ce courriel parce que vous vous êtes inscrit ou que vous avez une relation existante avec nous. " +
      "Pour cesser de recevoir ces courriels, cliquez sur le lien de désabonnement dans ce message. " +
      "[Business Name] · [Physical Mailing Address]",
  },
};

const BLUEPRINT_OK = { legalDefaults: KEYED_DEFAULTS };

function profile(opts: {
  optOut?: string | null;
  footer?: string | null;
  lang?: string;
}) {
  return {
    optOutLanguage: opts.optOut ?? null,
    emailFooterDisclosure: opts.footer ?? null,
    defaultLanguage: opts.lang ?? "en",
  };
}

describe("resolveLegalDefaults — KAN-852", () => {
  it("Case 1: French defaultLanguage with no override returns the fr Blueprint bundle", () => {
    const out = resolveLegalDefaults({
      accountProfile: profile({ lang: "fr" }),
      blueprint: BLUEPRINT_OK,
    });
    expect(out.optOutLanguage).toBe("Répondez STOP pour vous désabonner.");
    expect(out.emailFooterDisclosure).toContain("Vous recevez ce courriel");
    expect(out.source.optOutLanguage).toBe("language");
    expect(out.source.emailFooterDisclosure).toBe("language");
  });

  it("Case 2: English defaultLanguage with no override returns the en Blueprint bundle", () => {
    const out = resolveLegalDefaults({
      accountProfile: profile({ lang: "en" }),
      blueprint: BLUEPRINT_OK,
    });
    expect(out.optOutLanguage).toBe("Reply STOP to unsubscribe.");
    expect(out.emailFooterDisclosure).toContain("You received this email");
    expect(out.source.optOutLanguage).toBe("language");
    expect(out.source.emailFooterDisclosure).toBe("language");
  });

  it("Case 3: Unsupported language ('es') falls back to en Blueprint bundle", () => {
    const out = resolveLegalDefaults({
      accountProfile: profile({ lang: "es" }),
      blueprint: BLUEPRINT_OK,
    });
    expect(out.optOutLanguage).toBe("Reply STOP to unsubscribe.");
    expect(out.source.optOutLanguage).toBe("fallback_en");
    expect(out.source.emailFooterDisclosure).toBe("fallback_en");
  });

  it("Case 4a: tenant override wins over French Blueprint default", () => {
    const out = resolveLegalDefaults({
      accountProfile: profile({
        lang: "fr",
        optOut: "Custom French override",
        footer: "Custom French footer",
      }),
      blueprint: BLUEPRINT_OK,
    });
    expect(out.optOutLanguage).toBe("Custom French override");
    expect(out.emailFooterDisclosure).toBe("Custom French footer");
    expect(out.source.optOutLanguage).toBe("override");
    expect(out.source.emailFooterDisclosure).toBe("override");
  });

  it("Case 4b: per-field override mixes — one custom, one from Blueprint", () => {
    const out = resolveLegalDefaults({
      accountProfile: profile({
        lang: "en",
        optOut: "Custom opt-out only",
        footer: null,
      }),
      blueprint: BLUEPRINT_OK,
    });
    expect(out.optOutLanguage).toBe("Custom opt-out only");
    expect(out.source.optOutLanguage).toBe("override");
    expect(out.emailFooterDisclosure).toContain("You received this email");
    expect(out.source.emailFooterDisclosure).toBe("language");
  });

  it("Case 4c: empty-string override is treated as 'no override' — falls through to Blueprint", () => {
    // Crisp clear semantics: empty string == cleared == fall back to default.
    // The Cohort 4 UI's "Reset to Blueprint default" button writes empty/null.
    const out = resolveLegalDefaults({
      accountProfile: profile({ lang: "en", optOut: "", footer: "" }),
      blueprint: BLUEPRINT_OK,
    });
    expect(out.source.optOutLanguage).toBe("language");
    expect(out.source.emailFooterDisclosure).toBe("language");
  });

  it("Case 5a: legalDefaults=null — fail loud (Blueprint seed bug)", () => {
    expect(() =>
      resolveLegalDefaults({
        accountProfile: profile({}),
        blueprint: { legalDefaults: null },
      }),
    ).toThrow(/Blueprint\.legalDefaults is missing or malformed/);
  });

  it("Case 5b: legalDefaults missing the required `en` key — fail loud", () => {
    expect(() =>
      resolveLegalDefaults({
        accountProfile: profile({ lang: "fr" }),
        blueprint: { legalDefaults: { fr: KEYED_DEFAULTS.fr } },
      }),
    ).toThrow(/Blueprint\.legalDefaults is missing or malformed/);
  });

  it("Case 5c: legalDefaults shape mismatch (flat strings, pre-reshape) — fail loud", () => {
    // Guards against any Blueprint row that survived the migration with the
    // pre-reshape flat shape. Should never happen in PROD post-migration,
    // but the explicit error makes the bug obvious if a follow-up
    // migration accidentally rewrites legalDefaults to flat.
    expect(() =>
      resolveLegalDefaults({
        accountProfile: profile({}),
        blueprint: {
          legalDefaults: {
            optOutLanguage: "Flat string — wrong shape",
            emailFooterDisclosure: "Also flat",
          },
        },
      }),
    ).toThrow(/Blueprint\.legalDefaults is missing or malformed/);
  });

  it("Case 5d: error message includes a truncated body of the bad value for debugging", () => {
    try {
      resolveLegalDefaults({
        accountProfile: profile({}),
        blueprint: { legalDefaults: { unexpected: "shape" } },
      });
      throw new Error("expected resolver to throw");
    } catch (err) {
      expect((err as Error).message).toContain("unexpected");
    }
  });
});
