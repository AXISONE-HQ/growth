/**
 * KAN-852 — Account Page Cohort 1 Zod input schemas.
 *
 * Validation rules per spec §5 "Validation rules" table. Schemas are
 * partial-update by tab section (Identity / Contact / Hours / Payments /
 * Legal) and the accountRouter inline in apps/api/src/router.ts consumes
 * them via `protectedProcedure.input(...)`. All cross-field invariants
 * (open<close, additionalCurrencies excludes defaultCurrency,
 * supportedLanguages contains defaultLanguage) are enforced via `.refine`
 * at the schema level so invalid combinations reject at the boundary.
 *
 * The IANA time-zone validator uses `Intl.supportedValuesOf('timeZone')`
 * (Node 18+). The list is materialized once at module load and cached;
 * tests can mock `Intl` if needed. Falls back to a try/`new Intl.
 * DateTimeFormat` probe on platforms missing `supportedValuesOf`.
 */
import { z } from "zod";

// ─────────────────────────────────────────────
// Primitive validators (reused across tabs)
// ─────────────────────────────────────────────

/** E.164 — leading + and 1–14 digits per ITU-T E.164 max 15. */
const E164 = z
  .string()
  .regex(/^\+\d{1,15}$/, "Phone number must be E.164 (e.g., +15551234567)");

const HTTPS_URL = z
  .string()
  .url()
  .refine((u) => u.startsWith("https://"), {
    message: "URL must use https://",
  });

const HHMM = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Time must be HH:mm 24-hour");

/** ISO 4217 — 3 uppercase letters. */
const ISO_4217 = z.string().regex(/^[A-Z]{3}$/, "Currency must be ISO 4217 (3 uppercase letters)");

/** ISO 3166-1 alpha-2 — 2 uppercase letters. */
const ISO_3166_1_A2 = z.string().regex(/^[A-Z]{2}$/, "Country must be ISO 3166-1 alpha-2");

/** ISO 639-1 — 2 lowercase letters. MVP locks the value set to {en, fr}. */
const ISO_639_1 = z.enum(["en", "fr"]);

// ─────────────────────────────────────────────
// IANA time zone — validated against Intl
// ─────────────────────────────────────────────

const _IANA_ZONES: Set<string> = (() => {
  // Node 18+ supports Intl.supportedValuesOf. Older runtimes fall through
  // to runtime probing below.
  type IntlWithSupported = typeof Intl & {
    supportedValuesOf?: (key: string) => string[];
  };
  const intl = Intl as IntlWithSupported;
  if (typeof intl.supportedValuesOf === "function") {
    try {
      return new Set(intl.supportedValuesOf("timeZone"));
    } catch {
      // fall through
    }
  }
  return new Set<string>();
})();

function isValidTimeZone(tz: string): boolean {
  // Strict-list path: spec §5 mandates "validate against
  // Intl.supportedValuesOf('timeZone')" — canonical city-format zones only.
  // Rejects deprecated POSIX aliases (EST, MST, etc.) that the runtime
  // probe would otherwise let through. Tenants should pick from a
  // proper IANA zone like America/Toronto, not 3-letter abbreviations.
  if (_IANA_ZONES.size > 0) return _IANA_ZONES.has(tz);
  // Fallback ONLY for runtimes without supportedValuesOf — Node <18, very
  // old browsers. There the runtime probe is the best we can do.
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const IANA_TIMEZONE = z.string().refine(isValidTimeZone, {
  message: "Time zone must be a valid IANA zone (e.g., America/Toronto)",
});

// ─────────────────────────────────────────────
// WeeklyHours — closed=true OR { open<close }
// ─────────────────────────────────────────────

// Discriminated union on `closed` with the open<close cross-field check
// hoisted to the parent (Zod refuses ZodEffects as a discriminated-union
// branch — `.refine` wraps the schema in ZodEffects).
const DayHoursSchema = z.discriminatedUnion("closed", [
  z.object({ closed: z.literal(true) }),
  z.object({
    closed: z.literal(false),
    open: HHMM,
    close: HHMM,
  }),
]);
export type DayHours = z.infer<typeof DayHoursSchema>;

const _WeeklyHoursBaseSchema = z.object({
  monday: DayHoursSchema,
  tuesday: DayHoursSchema,
  wednesday: DayHoursSchema,
  thursday: DayHoursSchema,
  friday: DayHoursSchema,
  saturday: DayHoursSchema,
  sunday: DayHoursSchema,
});

export const WeeklyHoursSchema = _WeeklyHoursBaseSchema.superRefine((hours, ctx) => {
  for (const [day, dh] of Object.entries(hours)) {
    if (dh.closed === false && dh.open >= dh.close) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [day, "open"],
        message: "Open time must be before close time",
      });
    }
  }
});
export type WeeklyHours = z.infer<typeof WeeklyHoursSchema>;

// ─────────────────────────────────────────────
// Tab update schemas — each is partial; only fields the user touched
// ─────────────────────────────────────────────

export const IdentityUpdateSchema = z.object({
  legalName: z.string().min(1).max(200).optional(),
  displayName: z.string().max(100).nullable().optional(),
  websiteUrl: HTTPS_URL.nullable().optional(),
  oneLineDescription: z.string().max(200).nullable().optional(),
  industry: z.string().nullable().optional(),
});
export type IdentityUpdate = z.infer<typeof IdentityUpdateSchema>;

export const ContactUpdateSchema = z.object({
  primaryPhone: E164.nullable().optional(),
  supportPhone: E164.nullable().optional(),
  primaryEmail: z.string().email().nullable().optional(),
  supportEmail: z.string().email().nullable().optional(),
  physicalAddress: z.string().nullable().optional(),
  mailingAddress: z.string().nullable().optional(),
  mailingSameAsPhysical: z.boolean().optional(),
  addressStreet: z.string().nullable().optional(),
  addressCity: z.string().nullable().optional(),
  addressRegion: z.string().nullable().optional(),
  addressPostal: z.string().nullable().optional(),
  addressCountry: ISO_3166_1_A2.nullable().optional(),
  serviceAreaType: z.enum(["local", "regional", "national", "international"]).optional(),
  serviceAreaRadiusKm: z.number().int().positive().nullable().optional(),
  serviceAreaRegions: z.array(z.string()).nullable().optional(),
});
export type ContactUpdate = z.infer<typeof ContactUpdateSchema>;

export const HoursUpdateSchema = z.object({
  timeZone: IANA_TIMEZONE.optional(),
  weeklyHours: WeeklyHoursSchema.optional(),
  afterHoursBehavior: z
    .enum(["pause", "send_anyway", "high_confidence_only"])
    .optional(),
});
export type HoursUpdate = z.infer<typeof HoursUpdateSchema>;

const PAYMENT_METHOD = z.enum(["card", "ach", "wire", "check", "stripe", "paypal"]);

export const PaymentsUpdateSchema = z
  .object({
    defaultCurrency: ISO_4217.optional(),
    additionalCurrencies: z.array(ISO_4217).optional(),
    acceptedPaymentMethods: z.array(PAYMENT_METHOD).optional(),
    depositRequired: z.boolean().optional(),
    depositType: z.enum(["percentage", "fixed"]).nullable().optional(),
    depositValue: z.number().nonnegative().nullable().optional(),
    refundWindowDays: z.number().int().nonnegative().nullable().optional(),
  })
  .refine(
    (v) => {
      // Cross-field: additionalCurrencies must not include defaultCurrency.
      // Skip when either side absent — only checks when caller sent both.
      if (!v.defaultCurrency || !v.additionalCurrencies) return true;
      return !v.additionalCurrencies.includes(v.defaultCurrency);
    },
    {
      message: "additionalCurrencies must not include defaultCurrency",
      path: ["additionalCurrencies"],
    },
  );
export type PaymentsUpdate = z.infer<typeof PaymentsUpdateSchema>;

export const LegalUpdateSchema = z
  .object({
    taxId: z.string().nullable().optional(),
    businessRegNumber: z.string().nullable().optional(),
    jurisdiction: ISO_3166_1_A2.nullable().optional(),
    optOutLanguage: z.string().nullable().optional(),
    emailFooterDisclosure: z.string().nullable().optional(),
    defaultLanguage: ISO_639_1.optional(),
    supportedLanguages: z.array(ISO_639_1).optional(),
  })
  .refine(
    (v) => {
      // Cross-field: supportedLanguages must include defaultLanguage when both present.
      if (!v.defaultLanguage || !v.supportedLanguages) return true;
      return v.supportedLanguages.includes(v.defaultLanguage);
    },
    {
      message: "supportedLanguages must include defaultLanguage",
      path: ["supportedLanguages"],
    },
  );
export type LegalUpdate = z.infer<typeof LegalUpdateSchema>;

// ─────────────────────────────────────────────
// Child entity schemas (holidays / social profiles / disclosures)
// ─────────────────────────────────────────────

export const HolidayCreateSchema = z.object({
  name: z.string().min(1).max(200),
  /** ISO date string ("YYYY-MM-DD") — server coerces to Date for `@db.Date`. */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD"),
  recurring: z.boolean().default(false),
});
export type HolidayCreate = z.infer<typeof HolidayCreateSchema>;

export const SocialProfileCreateSchema = z.object({
  platform: z.enum([
    "linkedin",
    "instagram",
    "facebook",
    "twitter",
    "youtube",
    "tiktok",
    "other",
  ]),
  url: HTTPS_URL,
  handle: z.string().max(200).nullable().optional(),
});
export type SocialProfileCreate = z.infer<typeof SocialProfileCreateSchema>;

export const DisclosureCreateSchema = z.object({
  label: z.string().min(1).max(200),
  body: z.string().min(1),
  appliesToChannels: z.array(z.enum(["email", "sms", "whatsapp"])).default([]),
});
export type DisclosureCreate = z.infer<typeof DisclosureCreateSchema>;
