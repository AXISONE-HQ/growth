/**
 * KAN-852 — Account Page Cohort 1 validator unit tests.
 *
 * Covers the §11 edge cases enumerated by the spec: empty values,
 * malformed phone (E.164), malformed email, weeklyHours `open >= close`,
 * additionalCurrencies includes defaultCurrency, supportedLanguages
 * missing defaultLanguage, invalid IANA time zone.
 */
import { describe, it, expect } from "vitest";
import {
  IdentityUpdateSchema,
  ContactUpdateSchema,
  HoursUpdateSchema,
  PaymentsUpdateSchema,
  LegalUpdateSchema,
  WeeklyHoursSchema,
  HolidayCreateSchema,
  SocialProfileCreateSchema,
  DisclosureCreateSchema,
  buildAccountFieldUpdatedEvent,
  ACCOUNT_FIELD_UPDATED_TOPIC,
} from "../index.js";

// ─────────────────────────────────────────────
// IdentityUpdateSchema
// ─────────────────────────────────────────────

describe("IdentityUpdateSchema", () => {
  it("accepts empty patch (every field optional)", () => {
    expect(IdentityUpdateSchema.safeParse({}).success).toBe(true);
  });

  it("rejects empty legalName when provided", () => {
    expect(IdentityUpdateSchema.safeParse({ legalName: "" }).success).toBe(false);
  });

  it("rejects legalName over 200 chars", () => {
    expect(IdentityUpdateSchema.safeParse({ legalName: "a".repeat(201) }).success).toBe(false);
  });

  it("rejects displayName over 100 chars", () => {
    expect(IdentityUpdateSchema.safeParse({ displayName: "a".repeat(101) }).success).toBe(false);
  });

  it("rejects http:// URL — must be https://", () => {
    expect(
      IdentityUpdateSchema.safeParse({ websiteUrl: "http://example.com" }).success,
    ).toBe(false);
  });

  it("rejects malformed URL", () => {
    expect(IdentityUpdateSchema.safeParse({ websiteUrl: "not a url" }).success).toBe(false);
  });

  it("accepts valid https URL", () => {
    expect(
      IdentityUpdateSchema.safeParse({ websiteUrl: "https://acme.example.com/about" }).success,
    ).toBe(true);
  });

  it("rejects oneLineDescription over 200 chars", () => {
    expect(
      IdentityUpdateSchema.safeParse({ oneLineDescription: "x".repeat(201) }).success,
    ).toBe(false);
  });
});

// ─────────────────────────────────────────────
// ContactUpdateSchema
// ─────────────────────────────────────────────

describe("ContactUpdateSchema", () => {
  it("accepts valid E.164 phone", () => {
    expect(ContactUpdateSchema.safeParse({ primaryPhone: "+15551234567" }).success).toBe(true);
  });

  it("rejects phone without country code", () => {
    expect(ContactUpdateSchema.safeParse({ primaryPhone: "5551234567" }).success).toBe(false);
  });

  it("rejects phone with non-digits after +", () => {
    expect(ContactUpdateSchema.safeParse({ primaryPhone: "+1 555 1234" }).success).toBe(false);
  });

  it("rejects phone over 15 digits (E.164 max)", () => {
    expect(ContactUpdateSchema.safeParse({ primaryPhone: "+" + "1".repeat(16) }).success).toBe(false);
  });

  it("rejects malformed email", () => {
    expect(ContactUpdateSchema.safeParse({ primaryEmail: "not-an-email" }).success).toBe(false);
  });

  it("accepts valid email", () => {
    expect(
      ContactUpdateSchema.safeParse({ primaryEmail: "support@acme.com" }).success,
    ).toBe(true);
  });

  it("rejects address country not in ISO 3166-1 alpha-2 shape", () => {
    expect(ContactUpdateSchema.safeParse({ addressCountry: "USA" }).success).toBe(false);
    expect(ContactUpdateSchema.safeParse({ addressCountry: "us" }).success).toBe(false);
    expect(ContactUpdateSchema.safeParse({ addressCountry: "US" }).success).toBe(true);
  });

  it("rejects invalid serviceAreaType", () => {
    expect(
      ContactUpdateSchema.safeParse({ serviceAreaType: "global" }).success,
    ).toBe(false);
  });
});

// ─────────────────────────────────────────────
// WeeklyHoursSchema (separate + via HoursUpdateSchema)
// ─────────────────────────────────────────────

const ALL_OPEN_9_TO_5 = {
  monday: { closed: false, open: "09:00", close: "17:00" } as const,
  tuesday: { closed: false, open: "09:00", close: "17:00" } as const,
  wednesday: { closed: false, open: "09:00", close: "17:00" } as const,
  thursday: { closed: false, open: "09:00", close: "17:00" } as const,
  friday: { closed: false, open: "09:00", close: "17:00" } as const,
  saturday: { closed: true } as const,
  sunday: { closed: true } as const,
};

describe("WeeklyHoursSchema", () => {
  it("accepts a normal Mon–Fri 9–5 set", () => {
    expect(WeeklyHoursSchema.safeParse(ALL_OPEN_9_TO_5).success).toBe(true);
  });

  it("rejects open === close (must be strictly less)", () => {
    const bad = {
      ...ALL_OPEN_9_TO_5,
      monday: { closed: false, open: "09:00", close: "09:00" },
    };
    expect(WeeklyHoursSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects open > close", () => {
    const bad = {
      ...ALL_OPEN_9_TO_5,
      monday: { closed: false, open: "18:00", close: "09:00" },
    };
    expect(WeeklyHoursSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects HH:mm format violations", () => {
    const bad = {
      ...ALL_OPEN_9_TO_5,
      monday: { closed: false, open: "9:00", close: "17:00" }, // missing leading 0
    };
    expect(WeeklyHoursSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects out-of-range times (24:00 / 25:00)", () => {
    expect(
      WeeklyHoursSchema.safeParse({
        ...ALL_OPEN_9_TO_5,
        monday: { closed: false, open: "24:00", close: "25:00" },
      }).success,
    ).toBe(false);
  });

  it("requires all 7 days", () => {
    const partial = { monday: { closed: true } };
    expect(WeeklyHoursSchema.safeParse(partial).success).toBe(false);
  });

  it("accepts all-closed week", () => {
    const closed = {
      monday: { closed: true } as const,
      tuesday: { closed: true } as const,
      wednesday: { closed: true } as const,
      thursday: { closed: true } as const,
      friday: { closed: true } as const,
      saturday: { closed: true } as const,
      sunday: { closed: true } as const,
    };
    expect(WeeklyHoursSchema.safeParse(closed).success).toBe(true);
  });
});

// ─────────────────────────────────────────────
// HoursUpdateSchema (timezone)
// ─────────────────────────────────────────────

describe("HoursUpdateSchema — IANA time zone", () => {
  it("accepts known IANA zones", () => {
    // Spec §5 mandates supportedValuesOf strict-list validation — that's
    // canonical city-format zones only. Etc/UTC, deprecated POSIX aliases
    // (EST, MST), and bare "UTC" are all excluded from that list.
    expect(HoursUpdateSchema.safeParse({ timeZone: "America/Toronto" }).success).toBe(true);
    expect(HoursUpdateSchema.safeParse({ timeZone: "Europe/Paris" }).success).toBe(true);
    expect(HoursUpdateSchema.safeParse({ timeZone: "Asia/Tokyo" }).success).toBe(true);
  });

  it("rejects bogus zones", () => {
    expect(HoursUpdateSchema.safeParse({ timeZone: "Mars/Olympus_Mons" }).success).toBe(false);
    expect(HoursUpdateSchema.safeParse({ timeZone: "EST" }).success).toBe(false);
  });

  it("rejects empty string", () => {
    expect(HoursUpdateSchema.safeParse({ timeZone: "" }).success).toBe(false);
  });

  it("validates afterHoursBehavior enum", () => {
    expect(
      HoursUpdateSchema.safeParse({ afterHoursBehavior: "pause" }).success,
    ).toBe(true);
    expect(
      HoursUpdateSchema.safeParse({ afterHoursBehavior: "send_anyway" }).success,
    ).toBe(true);
    expect(
      HoursUpdateSchema.safeParse({ afterHoursBehavior: "high_confidence_only" }).success,
    ).toBe(true);
    expect(
      HoursUpdateSchema.safeParse({ afterHoursBehavior: "block_all" }).success,
    ).toBe(false);
  });
});

// ─────────────────────────────────────────────
// PaymentsUpdateSchema (cross-field invariants)
// ─────────────────────────────────────────────

describe("PaymentsUpdateSchema", () => {
  it("rejects additionalCurrencies that include defaultCurrency", () => {
    const bad = PaymentsUpdateSchema.safeParse({
      defaultCurrency: "USD",
      additionalCurrencies: ["USD", "EUR"],
    });
    expect(bad.success).toBe(false);
  });

  it("accepts disjoint default / additional currency sets", () => {
    expect(
      PaymentsUpdateSchema.safeParse({
        defaultCurrency: "USD",
        additionalCurrencies: ["EUR", "GBP"],
      }).success,
    ).toBe(true);
  });

  it("accepts patch with only one of the two currency fields (no cross-check)", () => {
    expect(
      PaymentsUpdateSchema.safeParse({ defaultCurrency: "USD" }).success,
    ).toBe(true);
    expect(
      PaymentsUpdateSchema.safeParse({ additionalCurrencies: ["USD", "EUR"] }).success,
    ).toBe(true);
  });

  it("rejects bad ISO 4217 codes", () => {
    expect(PaymentsUpdateSchema.safeParse({ defaultCurrency: "usd" }).success).toBe(false);
    expect(PaymentsUpdateSchema.safeParse({ defaultCurrency: "DOLLAR" }).success).toBe(false);
  });

  it("rejects unknown payment methods", () => {
    expect(
      PaymentsUpdateSchema.safeParse({ acceptedPaymentMethods: ["bitcoin"] }).success,
    ).toBe(false);
  });

  it("accepts valid payment methods enum", () => {
    expect(
      PaymentsUpdateSchema.safeParse({
        acceptedPaymentMethods: ["card", "ach", "stripe"],
      }).success,
    ).toBe(true);
  });

  it("rejects negative depositValue", () => {
    expect(PaymentsUpdateSchema.safeParse({ depositValue: -1 }).success).toBe(false);
  });
});

// ─────────────────────────────────────────────
// LegalUpdateSchema (cross-field language invariant)
// ─────────────────────────────────────────────

describe("LegalUpdateSchema", () => {
  it("rejects supportedLanguages missing defaultLanguage", () => {
    expect(
      LegalUpdateSchema.safeParse({
        defaultLanguage: "en",
        supportedLanguages: ["fr"],
      }).success,
    ).toBe(false);
  });

  it("accepts when supportedLanguages contains defaultLanguage", () => {
    expect(
      LegalUpdateSchema.safeParse({
        defaultLanguage: "en",
        supportedLanguages: ["en", "fr"],
      }).success,
    ).toBe(true);
  });

  it("locks language enum to {en, fr}", () => {
    expect(LegalUpdateSchema.safeParse({ defaultLanguage: "es" }).success).toBe(false);
    expect(
      LegalUpdateSchema.safeParse({ supportedLanguages: ["en", "de"] }).success,
    ).toBe(false);
  });

  it("rejects jurisdiction not in ISO 3166-1 alpha-2 shape", () => {
    expect(LegalUpdateSchema.safeParse({ jurisdiction: "USA" }).success).toBe(false);
    expect(LegalUpdateSchema.safeParse({ jurisdiction: "US" }).success).toBe(true);
  });
});

// ─────────────────────────────────────────────
// Child entity schemas
// ─────────────────────────────────────────────

describe("HolidayCreateSchema", () => {
  it("requires name + ISO date", () => {
    expect(HolidayCreateSchema.safeParse({ name: "", date: "2026-12-25" }).success).toBe(false);
    expect(
      HolidayCreateSchema.safeParse({ name: "Christmas", date: "12/25/2026" }).success,
    ).toBe(false);
    expect(
      HolidayCreateSchema.safeParse({ name: "Christmas", date: "2026-12-25" }).success,
    ).toBe(true);
  });

  it("defaults recurring to false", () => {
    const parsed = HolidayCreateSchema.parse({ name: "Christmas", date: "2026-12-25" });
    expect(parsed.recurring).toBe(false);
  });
});

describe("SocialProfileCreateSchema", () => {
  it("rejects unknown platform", () => {
    expect(
      SocialProfileCreateSchema.safeParse({
        platform: "myspace",
        url: "https://myspace.com/acme",
      }).success,
    ).toBe(false);
  });

  it("requires https URL", () => {
    expect(
      SocialProfileCreateSchema.safeParse({
        platform: "linkedin",
        url: "http://linkedin.com/in/acme",
      }).success,
    ).toBe(false);
  });

  it("accepts well-formed entry", () => {
    expect(
      SocialProfileCreateSchema.safeParse({
        platform: "linkedin",
        url: "https://linkedin.com/in/acme",
        handle: "@acme",
      }).success,
    ).toBe(true);
  });
});

describe("DisclosureCreateSchema", () => {
  it("rejects empty label or body", () => {
    expect(
      DisclosureCreateSchema.safeParse({ label: "", body: "x", appliesToChannels: [] }).success,
    ).toBe(false);
    expect(
      DisclosureCreateSchema.safeParse({ label: "FINRA", body: "", appliesToChannels: [] }).success,
    ).toBe(false);
  });

  it("rejects unknown channel", () => {
    expect(
      DisclosureCreateSchema.safeParse({
        label: "FINRA",
        body: "Required disclosure text",
        appliesToChannels: ["fax"],
      }).success,
    ).toBe(false);
  });

  it("defaults appliesToChannels to []", () => {
    const parsed = DisclosureCreateSchema.parse({ label: "FINRA", body: "text" });
    expect(parsed.appliesToChannels).toEqual([]);
  });
});

// ─────────────────────────────────────────────
// Event payload builder
// ─────────────────────────────────────────────

describe("buildAccountFieldUpdatedEvent", () => {
  const TENANT = "11111111-1111-4111-8111-111111111111";

  it("emits canonical eventType + version + topic match", () => {
    const e = buildAccountFieldUpdatedEvent({
      eventId: "evt-1",
      tenantId: TENANT,
      fieldPath: "legalName",
      oldValue: "Old Name",
      newValue: "New Name",
      source: "human",
      userId: "user-abc",
    });
    expect(e.eventType).toBe("account.field_updated");
    expect(e.eventType).toBe(ACCOUNT_FIELD_UPDATED_TOPIC);
    expect(e.version).toBe("1.0");
  });

  it("stringifies object oldValue / newValue", () => {
    const e = buildAccountFieldUpdatedEvent({
      eventId: "evt-2",
      tenantId: TENANT,
      fieldPath: "weeklyHours",
      oldValue: { monday: { closed: true } },
      newValue: { monday: { closed: false, open: "09:00", close: "17:00" } },
      source: "human",
    });
    expect(typeof e.oldValue).toBe("string");
    expect(typeof e.newValue).toBe("string");
    expect(JSON.parse(e.oldValue!).monday.closed).toBe(true);
  });

  it("preserves null oldValue / newValue", () => {
    const e = buildAccountFieldUpdatedEvent({
      eventId: "evt-3",
      tenantId: TENANT,
      fieldPath: "supportPhone",
      oldValue: null,
      newValue: "+15551112222",
      source: "human",
    });
    expect(e.oldValue).toBeNull();
    expect(e.newValue).toBe("+15551112222");
  });

  it("rejects bad tenantId at the schema boundary", () => {
    expect(() =>
      buildAccountFieldUpdatedEvent({
        eventId: "evt-4",
        tenantId: "not-a-uuid",
        fieldPath: "legalName",
        oldValue: null,
        newValue: "X",
        source: "human",
      }),
    ).toThrow();
  });
});
