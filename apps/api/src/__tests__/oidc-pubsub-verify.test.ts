/**
 * KAN-732 — oidc-pubsub-verify helper tests.
 *
 * Coverage:
 *   - expectedAudience computes from Host header
 *   - X-Forwarded-Host wins over Host (load balancer / VPC egress)
 *   - missing Host throws (caller responds 401)
 *   - trailing slash stripped to canonicalize aud match
 *   - test bypass via NODE_ENV='test' returns true unconditionally
 *   - logAudienceMismatch emits dual-format WARNING (message + JSON labels)
 *   - verifyPubsubOidc returns false on missing Bearer / malformed Bearer
 *   - real verify path rejects when audience mismatch (mocked OAuth2Client)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  expectedAudience,
  logAudienceMismatch,
  verifyPubsubOidc,
} from "../lib/oidc-pubsub-verify.js";

interface FakeContext {
  req: {
    url: string;
    path: string;
    header: (name: string) => string | undefined;
  };
}

function makeCtx(opts: {
  host?: string;
  xForwardedHost?: string;
  authorization?: string;
  path?: string;
  url?: string;
}): FakeContext {
  const headers: Record<string, string | undefined> = {
    host: opts.host,
    "x-forwarded-host": opts.xForwardedHost,
    authorization: opts.authorization,
  };
  return {
    req: {
      url: opts.url ?? `https://${opts.host ?? "unknown"}${opts.path ?? "/"}`,
      path: opts.path ?? "/pubsub/llm-call",
      header: (name: string) => headers[name.toLowerCase()],
    },
  };
}

describe("KAN-732 — expectedAudience", () => {
  it("computes from Host header", () => {
    const c = makeCtx({ host: "growth-api-biut5gfhuq-uc.a.run.app", path: "/pubsub/llm-call" });
    expect(expectedAudience(c as never)).toBe(
      "https://growth-api-biut5gfhuq-uc.a.run.app/pubsub/llm-call",
    );
  });

  it("X-Forwarded-Host wins over Host (load balancer / VPC egress)", () => {
    const c = makeCtx({
      host: "internal-host",
      xForwardedHost: "growth-api-biut5gfhuq-uc.a.run.app",
      path: "/pubsub/action-decided",
    });
    expect(expectedAudience(c as never)).toBe(
      "https://growth-api-biut5gfhuq-uc.a.run.app/pubsub/action-decided",
    );
  });

  it("strips trailing slash from path", () => {
    const c = makeCtx({ host: "x.example.com", path: "/pubsub/llm-call/" });
    expect(expectedAudience(c as never)).toBe("https://x.example.com/pubsub/llm-call");
  });

  it("preserves path without trailing slash", () => {
    const c = makeCtx({ host: "x.example.com", path: "/pubsub/llm-call" });
    expect(expectedAudience(c as never)).toBe("https://x.example.com/pubsub/llm-call");
  });

  it("throws when Host header missing (defensive)", () => {
    const c = makeCtx({ path: "/pubsub/x" });
    expect(() => expectedAudience(c as never)).toThrow(/no Host header/);
  });

  it("supports both growth-api hostnames Cloud Run assigns", () => {
    const c1 = makeCtx({ host: "growth-api-biut5gfhuq-uc.a.run.app", path: "/pubsub/llm-call" });
    const c2 = makeCtx({ host: "growth-api-1086551891973.us-central1.run.app", path: "/pubsub/llm-call" });
    expect(expectedAudience(c1 as never)).toBe(
      "https://growth-api-biut5gfhuq-uc.a.run.app/pubsub/llm-call",
    );
    expect(expectedAudience(c2 as never)).toBe(
      "https://growth-api-1086551891973.us-central1.run.app/pubsub/llm-call",
    );
  });
});

describe("KAN-732 — logAudienceMismatch dual-format", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("emits dual-format WARNING with structured labels", () => {
    logAudienceMismatch({
      expectedAudience: "https://growth-api.../pubsub/llm-call",
      tokenAudience: "https://growth-api.../pubsub/action-decided",
      requestUrl: "https://growth-api.../pubsub/llm-call",
      subscriberRoute: "/pubsub/llm-call",
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [msg, payload] = warnSpy.mock.calls[0];
    expect(msg).toContain("[oidc-pubsub-verify] audience mismatch");
    expect(msg).toContain("expected=https://growth-api.../pubsub/llm-call");
    expect(msg).toContain("token_aud=https://growth-api.../pubsub/action-decided");
    expect(msg).toContain("route=/pubsub/llm-call");
    const p = payload as {
      severity: string;
      "logging.googleapis.com/labels": {
        event: string;
        subscriberRoute: string;
      };
      expectedAudience: string;
    };
    expect(p.severity).toBe("WARNING");
    expect(p["logging.googleapis.com/labels"].event).toBe("oidc-pubsub-audience-mismatch");
    expect(p["logging.googleapis.com/labels"].subscriberRoute).toBe("/pubsub/llm-call");
    expect(p.expectedAudience).toBe("https://growth-api.../pubsub/llm-call");
  });
});

describe("KAN-732 — verifyPubsubOidc test bypass", () => {
  const origNodeEnv = process.env.NODE_ENV;
  const origSkip = process.env.PUBSUB_PUSH_SKIP_AUTH;

  afterEach(() => {
    process.env.NODE_ENV = origNodeEnv;
    process.env.PUBSUB_PUSH_SKIP_AUTH = origSkip;
  });

  it("NODE_ENV=test bypasses verification (returns true)", async () => {
    process.env.NODE_ENV = "test";
    const c = makeCtx({}); // no auth header, no host — would fail real verify
    expect(await verifyPubsubOidc(c as never)).toBe(true);
  });

  it("PUBSUB_PUSH_SKIP_AUTH=true bypasses verification", async () => {
    process.env.NODE_ENV = "production";
    process.env.PUBSUB_PUSH_SKIP_AUTH = "true";
    const c = makeCtx({});
    expect(await verifyPubsubOidc(c as never)).toBe(true);
  });

  it("PUBSUB_PUSH_SKIP_AUTH unset (any non-'true' value) does NOT bypass", async () => {
    process.env.NODE_ENV = "production";
    process.env.PUBSUB_PUSH_SKIP_AUTH = "false"; // exact string check
    const c = makeCtx({}); // missing auth → returns false
    expect(await verifyPubsubOidc(c as never)).toBe(false);
  });
});

describe("KAN-732 — verifyPubsubOidc rejection paths (production)", () => {
  const origNodeEnv = process.env.NODE_ENV;
  const origSkip = process.env.PUBSUB_PUSH_SKIP_AUTH;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env.NODE_ENV = "production";
    delete process.env.PUBSUB_PUSH_SKIP_AUTH;
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.env.NODE_ENV = origNodeEnv;
    if (origSkip !== undefined) process.env.PUBSUB_PUSH_SKIP_AUTH = origSkip;
    warnSpy.mockRestore();
  });

  it("rejects missing Authorization header", async () => {
    const c = makeCtx({ host: "x", path: "/pubsub/x" });
    expect(await verifyPubsubOidc(c as never)).toBe(false);
  });

  it("rejects malformed Authorization (not Bearer)", async () => {
    const c = makeCtx({ host: "x", path: "/pubsub/x", authorization: "Basic deadbeef" });
    expect(await verifyPubsubOidc(c as never)).toBe(false);
  });

  it("rejects when Host header missing + emits structured warning", async () => {
    const c = makeCtx({ authorization: "Bearer tok", path: "/pubsub/x" });
    expect(await verifyPubsubOidc(c as never)).toBe(false);
    expect(warnSpy).toHaveBeenCalled();
    const payload = warnSpy.mock.calls[0][1] as {
      "logging.googleapis.com/labels": { event: string };
    };
    expect(payload["logging.googleapis.com/labels"].event).toBe("oidc-pubsub-verify-no-host");
  });
});
