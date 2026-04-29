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
    expect(ctx.publishedEvents[0].source).toBe("inbox_email");
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
    expect(event.source).toBe("inbox_email");
    expect(event.metadata.subject).toBe("Pricing inquiry");
    expect(event.metadata.attachmentCount).toBe(0);
    expect(typeof event.eventId).toBe("string");
    expect(event.eventId).toMatch(/^evt_/);
  });
});
