/**
 * KAN-741 — Resend Inbound webhook handler tests.
 *
 * Mocks svix verification + Prisma hooks via __setInboundHooksForTest +
 * fake redis (via env override). Exercises:
 *   - Slug extraction + tenant resolution + cross-tenant isolation
 *   - SPF/DKIM enforcement (strict + lenient)
 *   - Anonymous-domain rejection
 *   - Contact upsert (existing match + new create)
 *   - lead.received publish payload shape
 *   - Audit row written for every code path
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";

// Mock ioredis at module level — same pattern as the outbound resend test.
// Returns "OK" by default (write succeeded, not a duplicate); tests can
// override per-call via redisSetMock.mockResolvedValueOnce.
const redisSetMock = vi.fn<(...args: unknown[]) => Promise<string | null>>(async () => "OK");
vi.mock("ioredis", () => {
  const Redis = vi.fn(() => ({
    set: redisSetMock,
    on: vi.fn(),
  }));
  return { default: Redis };
});

import {
  resendInboundWebhookApp,
  __setInboundHooksForTest,
  extractSlugFromTo,
  extractSlugAndToken,
  extractFromAddress,
  splitDisplayName,
  isAnonymousDomain,
  type LeadInboxEventRow,
} from "../resend-inbound.js";
import type { LeadReceivedEvent } from "@growth/shared";
// KAN-1140 Phase 1 PR 4 — registry bootstrap for tests
import { vendorRegistry } from "../../parsers/registry.js";
import { registerAllVendorHandlers } from "../../parsers/vendor-handlers/index.js";

// ─────────────────────────────────────────────
// svix verifier mock — bypass signature verification by injecting a verifier
// that returns the request body parsed as JSON.
// ─────────────────────────────────────────────
vi.mock("../../middleware/svix.js", async () => {
  const real = await vi.importActual<typeof import("../../middleware/svix.js")>("../../middleware/svix.js");
  return {
    ...real,
    buildSvixMiddleware: () => async (c: any, next: any) => {
      const rawBody = await c.req.text();
      const payload = JSON.parse(rawBody);
      c.set("svix", { payload, svixId: "msg_test", svixTimestamp: String(Math.floor(Date.now() / 1000)) });
      return next();
    },
    getSvixContext: (c: any) => c.get("svix"),
  };
});

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";

interface CapturedRow extends LeadInboxEventRow {}

function makeHooks(opts: {
  // KAN-1140 Phase 2 — `defaultLanguage` + `supportedLanguages` are
  // optional at the call-site; helper defaults to ("en", ["en"]) so legacy
  // call-sites (`{ id, inboxDkimStrict }`) keep working. Tests that need to
  // assert locale-specific routing pass the fields explicitly.
  resolvedTenant?: {
    id: string;
    inboxDkimStrict: boolean;
    defaultLanguage?: string;
    supportedLanguages?: string[];
  } | null;
  existingContactId?: string | null;
} = {}) {
  const auditRows: CapturedRow[] = [];
  const publishedEvents: LeadReceivedEvent[] = [];
  let createdContacts = 0;

  return {
    auditRows,
    publishedEvents,
    getCreatedContactCount: () => createdContacts,
    hooks: {
      resolveTenantBySlug: vi.fn(async () =>
        opts.resolvedTenant
          ? {
              id: opts.resolvedTenant.id,
              inboxDkimStrict: opts.resolvedTenant.inboxDkimStrict,
              defaultLanguage: opts.resolvedTenant.defaultLanguage ?? "en",
              supportedLanguages: opts.resolvedTenant.supportedLanguages ?? ["en"],
            }
          : null,
      ),
      upsertContactFromEmail: vi.fn(async () => {
        if (opts.existingContactId) return { id: opts.existingContactId };
        createdContacts++;
        return { id: "33333333-3333-3333-3333-333333333333" };
      }),
      writeLeadInboxEvent: vi.fn(async (row: CapturedRow) => {
        auditRows.push(row);
      }),
      publishLeadReceived: vi.fn(async (event: LeadReceivedEvent) => {
        publishedEvents.push(event);
        return "msg-id-mock";
      }),
    },
  };
}

function makeApp() {
  const app = new Hono();
  app.route("/webhooks/resend-inbound", resendInboundWebhookApp);
  return app;
}

const validInboundPayload = {
  type: "email.received",
  data: {
    email_id: "re_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    from: { email: "alice@customer.example", name: "Alice Customer" },
    to: ["abcd1234@leads.axisone.app"],
    subject: "Pricing inquiry",
    text: "Hi team, I'd like to learn about your enterprise tier.",
    attachments: [],
    spf: { pass: true },
    dkim: { pass: true },
  },
};

beforeEach(() => {
  __setInboundHooksForTest(null);
  redisSetMock.mockClear();
  redisSetMock.mockResolvedValue("OK");
  // KAN-1140 Phase 1 PR 4 — bootstrap the vendor registry for tests
  // (production app calls registerAllVendorHandlers() from buildApp;
  // tests use makeApp() which doesn't run that bootstrap, so we
  // re-register per-test for isolation).
  vendorRegistry.clear();
  registerAllVendorHandlers();
});

describe("extractSlugFromTo", () => {
  it("extracts slug from a plain address", () => {
    expect(extractSlugFromTo("abcd1234@leads.axisone.app")).toBe("abcd1234");
  });
  it("extracts slug when To has display-name format", () => {
    expect(extractSlugFromTo("AxisOne <abcd1234@leads.axisone.app>")).toBe("abcd1234");
  });
  it("extracts slug from first entry of array", () => {
    expect(extractSlugFromTo(["abcd1234@leads.axisone.app", "other@example.com"])).toBe("abcd1234");
  });
  it("returns null for malformed addresses", () => {
    expect(extractSlugFromTo("malformed")).toBe(null);
    expect(extractSlugFromTo("")).toBe(null);
    expect(extractSlugFromTo(undefined)).toBe(null);
  });
});

describe("extractFromAddress", () => {
  it("parses string with display name", () => {
    expect(extractFromAddress('"Alice" <alice@example.com>')).toEqual({ email: "alice@example.com", name: "Alice" });
  });
  it("parses bare string", () => {
    expect(extractFromAddress("alice@example.com")).toEqual({ email: "alice@example.com", name: null });
  });
  it("parses object form", () => {
    expect(extractFromAddress({ email: "alice@example.com", name: "Alice" })).toEqual({
      email: "alice@example.com",
      name: "Alice",
    });
  });
  it("returns null for undefined", () => {
    expect(extractFromAddress(undefined)).toBe(null);
  });
});

describe("splitDisplayName", () => {
  it("splits on whitespace", () => {
    expect(splitDisplayName("Alice Smith Jones")).toEqual({ firstName: "Alice", lastName: "Smith Jones" });
  });
  it("single name → firstName only", () => {
    expect(splitDisplayName("Alice")).toEqual({ firstName: "Alice", lastName: null });
  });
  it("null → null", () => {
    expect(splitDisplayName(null)).toEqual({ firstName: null, lastName: null });
  });
});

describe("isAnonymousDomain", () => {
  it("rejects single-label hosts", () => {
    expect(isAnonymousDomain("user@localhost")).toBe(true);
  });
  it("rejects known anonymous services", () => {
    expect(isAnonymousDomain("user@mailinator.com")).toBe(true);
    expect(isAnonymousDomain("user@guerrillamail.com")).toBe(true);
  });
  it("accepts normal domains", () => {
    expect(isAnonymousDomain("alice@customer.example")).toBe(false);
    expect(isAnonymousDomain("alice@gmail.com")).toBe(false);
  });
});

describe("inbound webhook — happy path", () => {
  it("accepts valid email, upserts contact, writes audit row, publishes lead.received", async () => {
    const ctx = makeHooks({
      resolvedTenant: { id: TENANT_A, inboxDkimStrict: true },
    });
    __setInboundHooksForTest(ctx.hooks);

    const app = makeApp();
    const res = await app.request("/webhooks/resend-inbound", {
      method: "POST",
      body: JSON.stringify(validInboundPayload),
    });

    expect(res.status).toBe(200);
    expect(ctx.auditRows).toHaveLength(1);
    expect(ctx.auditRows[0].status).toBe("accepted");
    expect(ctx.auditRows[0].tenantId).toBe(TENANT_A);
    expect(ctx.publishedEvents).toHaveLength(1);
    expect(ctx.publishedEvents[0].source).toBe("email_inbox");
    expect(ctx.publishedEvents[0].tenantId).toBe(TENANT_A);
    expect(ctx.publishedEvents[0].metadata.fromAddress).toBe("alice@customer.example");
  });
});

describe("inbound webhook — tenant resolution failures", () => {
  it("rejects unknown slug with rejected_unknown_slug audit row, no publish", async () => {
    const ctx = makeHooks({ resolvedTenant: null });
    __setInboundHooksForTest(ctx.hooks);

    const app = makeApp();
    const res = await app.request("/webhooks/resend-inbound", {
      method: "POST",
      body: JSON.stringify(validInboundPayload),
    });

    expect(res.status).toBe(200);
    expect(ctx.auditRows).toHaveLength(1);
    expect(ctx.auditRows[0].status).toBe("rejected_unknown_slug");
    expect(ctx.publishedEvents).toHaveLength(0);
  });

  it("does not leak which tenant the slug WOULD belong to in the audit row", async () => {
    const ctx = makeHooks({ resolvedTenant: null });
    __setInboundHooksForTest(ctx.hooks);

    const app = makeApp();
    await app.request("/webhooks/resend-inbound", {
      method: "POST",
      body: JSON.stringify(validInboundPayload),
    });

    // Cross-tenant safety: audit row uses sentinel tenantId for unknown-slug
    // case — never the real foreign tenant ID
    expect(ctx.auditRows[0].tenantId).not.toBe(TENANT_B);
    expect(ctx.auditRows[0].tenantId).toBe("00000000-0000-0000-0000-000000000000");
  });
});

describe("inbound webhook — SPF/DKIM enforcement", () => {
  it("rejects SPF=fail with rejected_spam audit row", async () => {
    const ctx = makeHooks({ resolvedTenant: { id: TENANT_A, inboxDkimStrict: true } });
    __setInboundHooksForTest(ctx.hooks);

    const app = makeApp();
    const payload = { ...validInboundPayload, data: { ...validInboundPayload.data, spf: { pass: false } } };
    const res = await app.request("/webhooks/resend-inbound", {
      method: "POST",
      body: JSON.stringify(payload),
    });

    expect(res.status).toBe(200);
    expect(ctx.auditRows[0].status).toBe("rejected_spam");
    expect(ctx.auditRows[0].rejectionReason).toContain("SPF");
    expect(ctx.publishedEvents).toHaveLength(0);
  });

  it("rejects DKIM=fail under strict mode", async () => {
    const ctx = makeHooks({ resolvedTenant: { id: TENANT_A, inboxDkimStrict: true } });
    __setInboundHooksForTest(ctx.hooks);

    const app = makeApp();
    const payload = { ...validInboundPayload, data: { ...validInboundPayload.data, dkim: { pass: false } } };
    const res = await app.request("/webhooks/resend-inbound", {
      method: "POST",
      body: JSON.stringify(payload),
    });

    expect(res.status).toBe(200);
    expect(ctx.auditRows[0].status).toBe("rejected_spam");
    expect(ctx.auditRows[0].rejectionReason).toContain("DKIM");
  });

  it("accepts DKIM=fail under lenient mode (inboxDkimStrict=false)", async () => {
    const ctx = makeHooks({ resolvedTenant: { id: TENANT_A, inboxDkimStrict: false } });
    __setInboundHooksForTest(ctx.hooks);

    const app = makeApp();
    const payload = { ...validInboundPayload, data: { ...validInboundPayload.data, dkim: { pass: false } } };
    const res = await app.request("/webhooks/resend-inbound", {
      method: "POST",
      body: JSON.stringify(payload),
    });

    expect(res.status).toBe(200);
    expect(ctx.auditRows[0].status).toBe("accepted");
    expect(ctx.publishedEvents).toHaveLength(1);
  });

  // KAN-741 fix-forward (2026-05-02): the gate decision uses EXPLICITLY-FAILED
  // signals. Resend's webhook payload often omits data.spf / data.dkim entirely
  // — empirically 100% of real-world smokes (Formspree, mkze.vc, hotmail.com)
  // arrived without these fields and were silently rejected as spam under the
  // pre-fix "if (!spfPass)" / "if (!dkimPass under strict)" logic. The tests
  // below pin the new behavior: absent fields => pass through, explicit false
  // => reject.

  it("accepts when data.spf is absent (Resend payload shape — trust SES upstream)", async () => {
    const ctx = makeHooks({ resolvedTenant: { id: TENANT_A, inboxDkimStrict: false } });
    __setInboundHooksForTest(ctx.hooks);

    const app = makeApp();
    const { spf, dkim, ...dataNoSpfDkim } = validInboundPayload.data;
    void spf; void dkim;
    const payload = { ...validInboundPayload, data: dataNoSpfDkim };
    const res = await app.request("/webhooks/resend-inbound", {
      method: "POST",
      body: JSON.stringify(payload),
    });

    expect(res.status).toBe(200);
    expect(ctx.auditRows[0].status).toBe("accepted");
    expect(ctx.publishedEvents).toHaveLength(1);
  });

  it("accepts when data.dkim is absent under strict mode (was rejected pre-fix)", async () => {
    const ctx = makeHooks({ resolvedTenant: { id: TENANT_A, inboxDkimStrict: true } });
    __setInboundHooksForTest(ctx.hooks);

    const app = makeApp();
    const { dkim, ...dataNoDkim } = validInboundPayload.data;
    void dkim;
    const payload = { ...validInboundPayload, data: { ...dataNoDkim, spf: { pass: true } } };
    const res = await app.request("/webhooks/resend-inbound", {
      method: "POST",
      body: JSON.stringify(payload),
    });

    expect(res.status).toBe(200);
    expect(ctx.auditRows[0].status).toBe("accepted");
    expect(ctx.publishedEvents).toHaveLength(1);
  });

  it("accepts when both data.spf and data.dkim are absent (real-world Resend shape)", async () => {
    const ctx = makeHooks({ resolvedTenant: { id: TENANT_A, inboxDkimStrict: true } });
    __setInboundHooksForTest(ctx.hooks);

    const app = makeApp();
    const { spf, dkim, ...dataNoSpfDkim } = validInboundPayload.data;
    void spf; void dkim;
    const payload = { ...validInboundPayload, data: dataNoSpfDkim };
    const res = await app.request("/webhooks/resend-inbound", {
      method: "POST",
      body: JSON.stringify(payload),
    });

    expect(res.status).toBe(200);
    expect(ctx.auditRows[0].status).toBe("accepted");
    expect(ctx.publishedEvents).toHaveLength(1);
    // Audit row still records spfPass=false / dkimPass=false (forensic signal:
    // Resend didn't tell us either passed). Behavior change is gate-side only.
    expect(ctx.auditRows[0].spfPass).toBe(false);
    expect(ctx.auditRows[0].dkimPass).toBe(false);
  });

  it("rejects anonymous domains regardless of SPF/DKIM", async () => {
    const ctx = makeHooks({ resolvedTenant: { id: TENANT_A, inboxDkimStrict: false } });
    __setInboundHooksForTest(ctx.hooks);

    const app = makeApp();
    const payload = {
      ...validInboundPayload,
      data: { ...validInboundPayload.data, from: { email: "user@mailinator.com", name: "Mister Anonymous" } },
    };
    const res = await app.request("/webhooks/resend-inbound", {
      method: "POST",
      body: JSON.stringify(payload),
    });

    expect(res.status).toBe(200);
    expect(ctx.auditRows[0].status).toBe("rejected_unverified");
    expect(ctx.publishedEvents).toHaveLength(0);
  });
});

describe("inbound webhook — non-receive event passthrough", () => {
  it("ignores email.delivered (or any non-receive type) with 200, no side effects", async () => {
    const ctx = makeHooks({ resolvedTenant: { id: TENANT_A, inboxDkimStrict: true } });
    __setInboundHooksForTest(ctx.hooks);

    const app = makeApp();
    const res = await app.request("/webhooks/resend-inbound", {
      method: "POST",
      body: JSON.stringify({ ...validInboundPayload, type: "email.delivered" }),
    });

    expect(res.status).toBe(200);
    expect(ctx.auditRows).toHaveLength(0);
    expect(ctx.publishedEvents).toHaveLength(0);
  });
});

describe("inbound webhook — published event payload shape", () => {
  it("publishes a LeadReceivedEventSchema-valid payload", async () => {
    const ctx = makeHooks({ resolvedTenant: { id: TENANT_A, inboxDkimStrict: true } });
    __setInboundHooksForTest(ctx.hooks);

    const app = makeApp();
    await app.request("/webhooks/resend-inbound", {
      method: "POST",
      body: JSON.stringify(validInboundPayload),
    });

    const event = ctx.publishedEvents[0];
    expect(event).toBeDefined();
    expect(event.eventType).toBe("lead.received");
    expect(event.version).toBe("1.0");
    expect(event.source).toBe("email_inbox");
    expect(event.metadata.subject).toBe("Pricing inquiry");
    expect(event.metadata.attachmentCount).toBe(0);
    expect(typeof event.eventId).toBe("string");
    expect(event.eventId).toMatch(/^evt_/);
  });
});

// ─────────────────────────────────────────────
// KAN-954 — Formspree parser integration
// ─────────────────────────────────────────────
import { FORMSPREE_SPECIMEN_2026_05_20 } from "../../parsers/__tests__/fixtures/formspree-2026-05-20.js";

const formspreeInboundPayload = {
  type: "email.received",
  data: {
    email_id: FORMSPREE_SPECIMEN_2026_05_20.emailId,
    from: { email: FORMSPREE_SPECIMEN_2026_05_20.from, name: "Formspree" },
    to: FORMSPREE_SPECIMEN_2026_05_20.to,
    subject: FORMSPREE_SPECIMEN_2026_05_20.subject,
    attachments: [],
    // Webhook payload deliberately omits text/html/reply_to — those come
    // from the Receiving API fetch (mocked via fetchEmailContent hook).
  },
};

describe("KAN-954 — Formspree parser integration (happy path)", () => {
  it("upserts Contact with the real submitter (NOT noreply@formspree.io) + sets dealName via event metadata", async () => {
    const ctx = makeHooks({ resolvedTenant: { id: TENANT_A, inboxDkimStrict: true } });
    // Mock the Receiving API fetch to return the verbatim D2 specimen.
    const hooks = {
      ...ctx.hooks,
      fetchEmailContent: vi.fn(async () => ({
        text: FORMSPREE_SPECIMEN_2026_05_20.text,
        html: null,
        replyTo: [...FORMSPREE_SPECIMEN_2026_05_20.replyTo],
        headers: { ...FORMSPREE_SPECIMEN_2026_05_20.headers },
        messageId: FORMSPREE_SPECIMEN_2026_05_20.messageId,
      })),
    };
    __setInboundHooksForTest(hooks);

    const app = makeApp();
    const res = await app.request("/webhooks/resend-inbound", {
      method: "POST",
      body: JSON.stringify(formspreeInboundPayload),
    });
    expect(res.status).toBe(200);

    // Contact upserted with the real submitter, NOT noreply@formspree.io
    // (firstName/lastName/companyName/source — but NOT customFields,
    // because Contact has no custom_fields column; that bag flows
    // through event.metadata.customFields to Deal.customFields)
    expect(hooks.upsertContactFromEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "cowork-pipeline-test@e2etest.co",
        firstName: "Cowork",
        lastName: "Pipeline Test",
        companyName: "E2E Test Co",
        source: "web_form",
      }),
    );

    // Event metadata carries dealName + vendor + formSource/leadType +
    // customFields (consumer puts the latter on Deal.customFields)
    const event = ctx.publishedEvents[0];
    expect(event.metadata.dealName).toBe("Early-access — E2E Test Co");
    expect(event.metadata.vendor).toBe("formspree");
    expect(event.metadata.formSource).toBe("growth-landing-v1");
    expect(event.metadata.leadType).toBe("early_access_request");
    expect(event.metadata.customFields).toMatchObject({
      formSource: "growth-landing-v1",
      leadType: "early_access_request",
      role: "Founder / CEO",
      monthlyLeadVolume: "100-500",
    });
    // fromAddress preserved (audit-trail signal — Formspree forwarded from noreply)
    expect(event.metadata.fromAddress).toBe("noreply@formspree.io");
    // bodyPreview now populated from the fetched specimen (closes the
    // empty-body bug for ALL inbound, KAN-954 D5)
    expect(event.metadata.bodyPreview).toContain("formSource:");
    expect(event.metadata.bodyPreview).toContain("growth-landing-v1");
  });
});

describe("KAN-954 — Formspree parser fallback paths (never drop a lead)", () => {
  it("Receiving API fetch fails → falls back to legacy noreply attribution + still lands the lead", async () => {
    const ctx = makeHooks({ resolvedTenant: { id: TENANT_A, inboxDkimStrict: true } });
    const hooks = {
      ...ctx.hooks,
      fetchEmailContent: vi.fn(async () => null), // simulates 4xx/5xx/timeout
    };
    __setInboundHooksForTest(hooks);

    const app = makeApp();
    const res = await app.request("/webhooks/resend-inbound", {
      method: "POST",
      body: JSON.stringify(formspreeInboundPayload),
    });
    expect(res.status).toBe(200);

    // Contact still created — mis-attributed but landed (the non-negotiable)
    expect(hooks.upsertContactFromEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "noreply@formspree.io",
      }),
    );
    expect(ctx.publishedEvents).toHaveLength(1);
    // Audit row written with "accepted" — lead NOT dropped
    expect(ctx.auditRows[0]?.status).toBe("accepted");
    // No vendor/dealName set when parser didn't fire
    expect(ctx.publishedEvents[0].metadata.dealName).toBeUndefined();
    expect(ctx.publishedEvents[0].metadata.vendor).toBeUndefined();
  });

  it("Body fetched but malformed (no recognizable fields) → falls back, lead lands mis-attributed", async () => {
    const ctx = makeHooks({ resolvedTenant: { id: TENANT_A, inboxDkimStrict: true } });
    const hooks = {
      ...ctx.hooks,
      fetchEmailContent: vi.fn(async () => ({
        text: "Garbage that doesn't match the Formspree format at all.",
        html: null,
        replyTo: [], // no reply-to either
        headers: {},
        messageId: null,
      })),
    };
    __setInboundHooksForTest(hooks);

    const app = makeApp();
    const res = await app.request("/webhooks/resend-inbound", {
      method: "POST",
      body: JSON.stringify(formspreeInboundPayload),
    });
    expect(res.status).toBe(200);

    // Parser returned null → legacy path → Contact under noreply
    expect(hooks.upsertContactFromEmail).toHaveBeenCalledWith(
      expect.objectContaining({ email: "noreply@formspree.io" }),
    );
    expect(ctx.auditRows[0]?.status).toBe("accepted");
    expect(ctx.publishedEvents[0].metadata.dealName).toBeUndefined();
  });
});

describe("KAN-954 — non-Formspree regression (parser is a no-op)", () => {
  it("direct inbound from fred@mkze.vc-style address routes through unchanged", async () => {
    const ctx = makeHooks({ resolvedTenant: { id: TENANT_A, inboxDkimStrict: true } });
    // Body is fetched for ALL inbound (D5 hydration step), but parser
    // doesn't fire because From is not formspree.io
    const hooks = {
      ...ctx.hooks,
      fetchEmailContent: vi.fn(async () => ({
        text: "Hi team, I'd like to learn about your enterprise tier.",
        html: null,
        replyTo: ["alice@customer.example"], // ignored by non-Formspree path
        headers: {},
        messageId: null,
      })),
    };
    __setInboundHooksForTest(hooks);

    const app = makeApp();
    const res = await app.request("/webhooks/resend-inbound", {
      method: "POST",
      body: JSON.stringify(validInboundPayload),
    });
    expect(res.status).toBe(200);

    // Contact upserted with original From-keyed identity (Alice Customer),
    // not from the body or replyTo
    expect(hooks.upsertContactFromEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "alice@customer.example",
        firstName: "Alice",
        lastName: "Customer",
      }),
    );
    // Critically: NO Formspree-specific attribution leaked to non-Formspree
    expect(hooks.upsertContactFromEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        companyName: null,
        source: undefined,
      }),
    );
    // Vendor-specific fields (vendor/formSource/leadType/dealName) preserved
    // as undefined since no vendor parser fires for this direct-inbound shape
    // — the KAN-954 "non-Formspree regression (parser is a no-op)" contract
    // still holds.
    //
    // KAN-1140 PR 1 contract addition: format-detection metadata
    // (_kan_1140_format + _kan_1140_confidence) is populated on every
    // non-Formspree inbound for the Phase 3 confidence-escalation queue
    // (per Q6 disposition (c) — schema-extension deferred; detection
    // result stashed in customFields until Phase 3 lands). This direct
    // inbound is plain-text/high since the body has no XML/HTML markers
    // and no label:value lines to extract.
    const event = ctx.publishedEvents[0];
    expect(event.metadata.vendor).toBeUndefined();
    expect(event.metadata.formSource).toBeUndefined();
    expect(event.metadata.leadType).toBeUndefined();
    expect(event.metadata.dealName).toBeUndefined();
    // KAN-1140 Phase 2 contract addition: language detection runs on every
    // non-vendor inbound. franc-min misclassifies the short body here, so
    // the specific resolved language is incidental to what THIS test
    // verifies — just assert the format-detection contract is preserved
    // and that the language fields are populated (audit-trail discipline).
    expect(event.metadata.customFields?._kan_1140_format).toBe("plain-text");
    expect(event.metadata.customFields?._kan_1140_confidence).toBe("high");
    expect(event.metadata.customFields?._kan_1140_language).toBeDefined();
    expect(event.metadata.customFields?._kan_1140_language_confidence).toMatch(
      /^(high|medium|low)$/,
    );
    // But bodyPreview IS populated from the fetched text — D5 win
    expect(event.metadata.bodyPreview).toContain("enterprise tier");
  });
});

// ─── KAN-1036 — extractSlugAndToken ──────────────────────────────────────
describe("KAN-1036 — extractSlugAndToken", () => {
  const VALID_TOKEN = "a7b2c5f9d1e6k2m4".replace(/[gk-z]/g, "0"); // 16-hex

  it("parses plain <slug@domain> with no subaddress (back-compat)", () => {
    const out = extractSlugAndToken("c03065f6@leads.axisone.ca");
    expect(out).toEqual({ slug: "c03065f6", replyToken: null });
  });

  it("parses display-name <slug+token@domain> form (the canonical reply shape)", () => {
    const tok = "deadbeef12345678";
    const out = extractSlugAndToken(`AxisOne <c03065f6+${tok}@leads.axisone.ca>`);
    expect(out).toEqual({ slug: "c03065f6", replyToken: tok });
  });

  it("parses bare slug+token@domain (no display-name wrapping)", () => {
    const tok = "1234567890abcdef";
    const out = extractSlugAndToken(`c03065f6+${tok}@leads.axisone.ca`);
    expect(out).toEqual({ slug: "c03065f6", replyToken: tok });
  });

  it("parses array form (Resend Receiving may send to[] for multiple recipients)", () => {
    const tok = VALID_TOKEN;
    const out = extractSlugAndToken([`c03065f6+${tok}@leads.axisone.ca`, "other@example.com"]);
    expect(out).toEqual({ slug: "c03065f6", replyToken: tok });
  });

  it("rejects non-16-char token shape — slug returned, token NULL (user-typed +foo)", () => {
    const out = extractSlugAndToken("c03065f6+kan1036test@leads.axisone.ca");
    expect(out).toEqual({ slug: "c03065f6", replyToken: null });
  });

  it("rejects non-hex token (correct length, wrong charset)", () => {
    // 16 chars of base32 — not hex
    const out = extractSlugAndToken("c03065f6+ABCDEFGHIJKLMNOP@leads.axisone.ca");
    expect(out).toEqual({ slug: "c03065f6", replyToken: null });
  });

  it("explicit pin — double `+` in local-part splits on first `+` only; second part fails the regex (no leakage)", () => {
    // Defensive: even though the regex catches it, document the split
    // semantics explicitly. If the regex is ever relaxed (e.g., allow
    // checksum chars), this test surfaces the still-load-bearing
    // split-on-first behavior so a future maintainer doesn't accidentally
    // open up a malformed-correlation hole via `+`-stuffed subaddresses.
    const out = extractSlugAndToken("c03065f6+foo+abc123def4567890@leads.axisone.ca");
    expect(out).toEqual({ slug: "c03065f6", replyToken: null });
  });

  it("explicit pin — empty subaddress (`slug+@domain`) returns replyToken: null (no empty-string leak through)", () => {
    // Defensive: confirms the empty-string post-`+` value fails the
    // /^[0-9a-f]{16}$/ regex and gets converted to null. Without this
    // test, a future change that uses `replyToken ?? ''` or similar
    // could let an empty string flow downstream silently. The
    // documented contract is: malformed subaddress → null, never empty.
    const out = extractSlugAndToken("c03065f6+@leads.axisone.ca");
    expect(out).toEqual({ slug: "c03065f6", replyToken: null });
  });

  it("returns null on null/undefined/non-string", () => {
    expect(extractSlugAndToken(undefined)).toBeNull();
    expect(extractSlugAndToken("")).toBeNull();
    expect(extractSlugAndToken([])).toBeNull();
  });

  it("returns null when no @ separator (malformed address)", () => {
    expect(extractSlugAndToken("not-an-address")).toBeNull();
  });

  it("extractSlugFromTo (deprecated) still returns slug-only for back-compat callers", () => {
    const tok = "fedcba9876543210";
    // KAN-1036 helper composes through extractSlugAndToken; slug-only return preserves
    // pre-KAN-1036 behavior for any caller that still uses it.
    expect(extractSlugFromTo(`c03065f6+${tok}@leads.axisone.ca`)).toBe("c03065f6");
    expect(extractSlugFromTo("plain@leads.axisone.ca")).toBe("plain");
  });
});

describe("KAN-1037-PR2 — autoresponder filter integration", () => {
  // Webhook payload for an OOO autoresponder. Subject + body together fire
  // the SUBJECT_REGEX path; the body fallback covers the case where the
  // upstream MTA stripped Auto-Submitted (some autoresponders do this).
  const autoresponderPayload = {
    type: "email.received",
    data: {
      email_id: "re_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      from: { email: "alice@customer.example", name: "Alice Customer" },
      to: ["abcd1234@leads.axisone.app"],
      subject: "Out of Office: away until Monday",
      attachments: [],
      spf: { pass: true },
      dkim: { pass: true },
      // text/html intentionally absent — body comes from Receiving fetch
    },
  };

  it("filters an OOO autoresponder: writes rejected_autoresponder audit row with reason, NO lead.received publish", async () => {
    const ctx = makeHooks({ resolvedTenant: { id: TENANT_A, inboxDkimStrict: true } });
    const hooks = {
      ...ctx.hooks,
      fetchEmailContent: vi.fn(async () => ({
        text: "I am currently out of the office until Monday. I will respond upon my return.",
        html: null,
        replyTo: [],
        headers: {
          "auto-submitted": "auto-replied",
          "message-id": "<auto-reply-xyz@customer.example>",
        },
        messageId: "<auto-reply-xyz@customer.example>",
      })),
    };
    __setInboundHooksForTest(hooks);

    const app = makeApp();
    const res = await app.request("/webhooks/resend-inbound", {
      method: "POST",
      body: JSON.stringify(autoresponderPayload),
    });

    expect(res.status).toBe(200);
    expect(ctx.auditRows).toHaveLength(1);
    expect(ctx.auditRows[0].status).toBe("rejected_autoresponder");
    expect(ctx.auditRows[0].rejectionReason).toBe("header:auto-submitted=auto-replied");
    // Contact upsert still runs — operator sees the identity behind the
    // autoresponder for forensic context (PR5 Last reply panel can render
    // "contact's autoresponder fired" as part of contact context).
    expect(ctx.auditRows[0].createdContactId).toBe("33333333-3333-3333-3333-333333333333");
    // The load-bearing assertion: no `lead.received` publish for filtered
    // inbounds. Downstream consumers (post-PR3: `contact.replied` →
    // `decision.run`) never get triggered → engine ↔ responder ping-pong
    // is structurally impossible.
    expect(ctx.publishedEvents).toHaveLength(0);
  });

  it("passes a genuine reply: writes accepted audit row + publishes lead.received (filter doesn't break happy path)", async () => {
    // Regression check: the same wire-shape as the autoresponder test
    // (resolved tenant, SPF/DKIM pass, fetchEmailContent populated) but
    // with a normal subject + body. The filter falls through cleanly.
    const ctx = makeHooks({ resolvedTenant: { id: TENANT_A, inboxDkimStrict: true } });
    const hooks = {
      ...ctx.hooks,
      fetchEmailContent: vi.fn(async () => ({
        text: "Hi team — Thursday at 2pm ET works. Looking forward to the call. — Alice",
        html: null,
        replyTo: [],
        headers: {
          "message-id": "<reply-abc@customer.example>",
          "in-reply-to": "<original-outbound@axisone.ca>",
        },
        messageId: "<reply-abc@customer.example>",
      })),
    };
    __setInboundHooksForTest(hooks);

    const app = makeApp();
    const res = await app.request("/webhooks/resend-inbound", {
      method: "POST",
      body: JSON.stringify({
        ...autoresponderPayload,
        data: {
          ...autoresponderPayload.data,
          subject: "Re: Quick question about pricing",
        },
      }),
    });

    expect(res.status).toBe(200);
    expect(ctx.auditRows).toHaveLength(1);
    expect(ctx.auditRows[0].status).toBe("accepted");
    expect(ctx.auditRows[0].rejectionReason).toBeNull();
    expect(ctx.publishedEvents).toHaveLength(1);
    expect(ctx.publishedEvents[0].source).toBe("email_inbox");
  });
});

// ─────────────────────────────────────────────
// KAN-1140 Phase 2 — language detection + Q4(c') fallback integration
// ─────────────────────────────────────────────
//
// Webhook-level coverage of the language-detector + resolveLanguage wedge.
// Module-level coverage of those functions lives in
// `parsers/__tests__/language-detector.test.ts`; here we verify the
// integration thins through the webhook → event → metadata.language path
// for the Contact.language persistence consumers + the lead-normalizer
// prompt block.

const EN_BODY =
  "Hi team, I would like to learn about your enterprise pricing tier. " +
  "We are evaluating several vendors and would appreciate a demo this week. " +
  "Please let me know what times work for your sales team. Thanks!";
const FR_BODY =
  "Bonjour, je souhaiterais obtenir des informations sur votre offre tarifaire " +
  "entreprise. Nous évaluons plusieurs prestataires et aimerions assister à une " +
  "démonstration cette semaine. Merci de me communiquer vos disponibilités.";

describe("KAN-1140 Phase 2 — language detection integration", () => {
  it("English body + en-only tenant → metadata.language=en + customFields._kan_1140_language=en", async () => {
    const ctx = makeHooks({
      resolvedTenant: {
        id: TENANT_A,
        inboxDkimStrict: true,
        defaultLanguage: "en",
        supportedLanguages: ["en"],
      },
    });
    const hooks = {
      ...ctx.hooks,
      fetchEmailContent: vi.fn(async () => ({
        text: EN_BODY,
        html: null,
        replyTo: [],
        headers: {},
        messageId: null,
      })),
    };
    __setInboundHooksForTest(hooks);

    const app = makeApp();
    const res = await app.request("/webhooks/resend-inbound", {
      method: "POST",
      body: JSON.stringify(validInboundPayload),
    });

    expect(res.status).toBe(200);
    expect(ctx.publishedEvents).toHaveLength(1);
    const event = ctx.publishedEvents[0];
    expect(event.metadata.language).toBe("en");
    expect(event.metadata.customFields?._kan_1140_language).toBe("en");
    expect(event.metadata.customFields?._kan_1140_language_detected).toBe("en");
    expect(event.metadata.customFields?._kan_1140_language_confidence).toMatch(
      /^(high|medium)$/,
    );
  });

  it("French body + multi-locale tenant → resolved=fr (operator declared fr supported)", async () => {
    const ctx = makeHooks({
      resolvedTenant: {
        id: TENANT_A,
        inboxDkimStrict: true,
        defaultLanguage: "en",
        supportedLanguages: ["en", "fr"],
      },
    });
    const hooks = {
      ...ctx.hooks,
      fetchEmailContent: vi.fn(async () => ({
        text: FR_BODY,
        html: null,
        replyTo: [],
        headers: {},
        messageId: null,
      })),
    };
    __setInboundHooksForTest(hooks);

    const app = makeApp();
    const res = await app.request("/webhooks/resend-inbound", {
      method: "POST",
      body: JSON.stringify(validInboundPayload),
    });

    expect(res.status).toBe(200);
    const event = ctx.publishedEvents[0];
    expect(event.metadata.language).toBe("fr");
    expect(event.metadata.customFields?._kan_1140_language).toBe("fr");
    expect(event.metadata.customFields?._kan_1140_language_detected).toBe("fr");
  });

  it("HIGH-confidence French body + en-only tenant → resolved=fr (doctrine: HIGH overrides supportedLanguages)", async () => {
    // Q4(c') doctrine rule 1: HIGH-confidence detection is trusted
    // OVER operator-declared supportedLanguages, on the rationale that
    // a clear-signal foreign-language inbound represents real-world data
    // the operator's intent didn't anticipate. The medium-confidence path
    // honors supportedLanguages (rule 2); HIGH does not (rule 1).
    //
    // Operator forensics: customFields preserve BOTH detected and
    // resolved so the operator can audit divergence-from-intent.
    const ctx = makeHooks({
      resolvedTenant: {
        id: TENANT_A,
        inboxDkimStrict: true,
        defaultLanguage: "en",
        supportedLanguages: ["en"],
      },
    });
    const hooks = {
      ...ctx.hooks,
      fetchEmailContent: vi.fn(async () => ({
        text: FR_BODY,
        html: null,
        replyTo: [],
        headers: {},
        messageId: null,
      })),
    };
    __setInboundHooksForTest(hooks);

    const app = makeApp();
    const res = await app.request("/webhooks/resend-inbound", {
      method: "POST",
      body: JSON.stringify(validInboundPayload),
    });

    expect(res.status).toBe(200);
    const event = ctx.publishedEvents[0];
    // HIGH confidence FR overrides en-only supportedLanguages
    expect(event.metadata.customFields?._kan_1140_language_confidence).toBe(
      "high",
    );
    expect(event.metadata.language).toBe("fr");
    expect(event.metadata.customFields?._kan_1140_language).toBe("fr");
    expect(event.metadata.customFields?._kan_1140_language_detected).toBe("fr");
  });

  it("Resend Receiving fetch unreachable (fetchEmailContent → null) → no metadata.language; no _kan_1140_language*", async () => {
    const ctx = makeHooks({
      resolvedTenant: {
        id: TENANT_A,
        inboxDkimStrict: true,
        defaultLanguage: "en",
        supportedLanguages: ["en"],
      },
    });
    const hooks = {
      ...ctx.hooks,
      fetchEmailContent: vi.fn(async () => null),
    };
    __setInboundHooksForTest(hooks);

    const app = makeApp();
    const res = await app.request("/webhooks/resend-inbound", {
      method: "POST",
      body: JSON.stringify(validInboundPayload),
    });

    expect(res.status).toBe(200);
    const event = ctx.publishedEvents[0];
    expect(event.metadata.language).toBeUndefined();
    expect(event.metadata.customFields?._kan_1140_language).toBeUndefined();
  });

  it("Brand-new tenant (resolveTenantBySlug defaults) → defaults to en/['en'] and resolves to en", async () => {
    // Sanity-check the production-impl defaults: app.ts:resolveTenantBySlug
    // falls back to defaultLanguage='en' / supportedLanguages=['en'] when
    // AccountProfile is absent. This test exercises the helper's default
    // branch (resolvedTenant carries no defaultLanguage / supportedLanguages).
    const ctx = makeHooks({
      resolvedTenant: {
        id: TENANT_A,
        inboxDkimStrict: true,
        // defaultLanguage + supportedLanguages omitted → helper supplies
        // ("en", ["en"]) — mirrors production AccountProfile-absent path.
      },
    });
    const hooks = {
      ...ctx.hooks,
      fetchEmailContent: vi.fn(async () => ({
        text: EN_BODY,
        html: null,
        replyTo: [],
        headers: {},
        messageId: null,
      })),
    };
    __setInboundHooksForTest(hooks);

    const app = makeApp();
    const res = await app.request("/webhooks/resend-inbound", {
      method: "POST",
      body: JSON.stringify(validInboundPayload),
    });

    expect(res.status).toBe(200);
    const event = ctx.publishedEvents[0];
    expect(event.metadata.language).toBe("en");
  });
});
