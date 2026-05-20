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
  extractFromAddress,
  splitDisplayName,
  isAnonymousDomain,
  type LeadInboxEventRow,
} from "../resend-inbound.js";
import type { LeadReceivedEvent } from "@growth/shared";

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
  resolvedTenant?: { id: string; inboxDkimStrict: boolean } | null;
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
      resolveTenantBySlug: vi.fn(async () => opts.resolvedTenant ?? null),
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
    expect(hooks.upsertContactFromEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "cowork-pipeline-test@e2etest.co",
        firstName: "Cowork",
        lastName: "Pipeline Test",
        companyName: "E2E Test Co",
        source: "web_form",
        customFields: expect.objectContaining({
          formSource: "growth-landing-v1",
          leadType: "early_access_request",
          role: "Founder / CEO",
          monthlyLeadVolume: "100-500",
        }),
      }),
    );

    // Event metadata carries dealName + vendor + formSource/leadType
    const event = ctx.publishedEvents[0];
    expect(event.metadata.dealName).toBe("Early-access — E2E Test Co");
    expect(event.metadata.vendor).toBe("formspree");
    expect(event.metadata.formSource).toBe("growth-landing-v1");
    expect(event.metadata.leadType).toBe("early_access_request");
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
    const upsertArg = hooks.upsertContactFromEmail.mock.calls[0][0];
    expect(upsertArg.companyName).toBeNull();
    expect(upsertArg.source).toBeUndefined();
    expect(upsertArg.customFields).toBeUndefined();
    // Event has no vendor/formSource/leadType/dealName
    const event = ctx.publishedEvents[0];
    expect(event.metadata.vendor).toBeUndefined();
    expect(event.metadata.formSource).toBeUndefined();
    expect(event.metadata.leadType).toBeUndefined();
    expect(event.metadata.dealName).toBeUndefined();
    // But bodyPreview IS populated from the fetched text — D5 win
    expect(event.metadata.bodyPreview).toContain("enterprise tier");
  });
});
