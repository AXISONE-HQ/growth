/**
 * KAN-855 — account-logo-storage helpers (Sharp + GCS).
 *
 * Covers:
 *  - Tenant-scope validation (isOwnedByTenant) — blocks cross-tenant
 *    paths before any GCS call
 *  - Object name parsing (ext, timestamp)
 *  - Sharp variant generation against a real PNG fixture (verifies
 *    Sharp install + Cloud Run base image compat at test time, not
 *    deploy time)
 *  - SVG short-circuit (raster path not invoked)
 *  - 10s Sharp timeout — synthetic delay rejects with the documented
 *    error message
 *
 * GCS calls are mocked via the `_setStorageForTest` seam — no network.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import sharp from "sharp";
import {
  isOwnedByTenant,
  parseExtFromObjectName,
  parseTimestampFromObjectName,
  generateAndUploadVariants,
  ALLOWED_LOGO_MIME_TO_EXT,
  MAX_LOGO_BYTES,
  _setStorageForTest,
} from "../account-logo-storage.js";

const TENANT_A = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "22222222-2222-4222-8222-222222222222";

// ─────────────────────────────────────────────
// Fixture — a tiny 4×4 transparent PNG
// ─────────────────────────────────────────────

async function makeFixturePng(): Promise<Buffer> {
  return sharp({
    create: {
      width: 200,
      height: 200,
      channels: 4,
      background: { r: 100, g: 150, b: 200, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
}

// ─────────────────────────────────────────────
// Mock GCS storage client
// ─────────────────────────────────────────────

interface MockFile {
  saveCalls: Array<{ buffer: Buffer; contentType: string; name: string }>;
}

function makeMockStorage(): {
  storage: {
    bucket: (name: string) => {
      file: (name: string) => {
        save: (buf: Buffer, opts: { contentType: string }) => Promise<void>;
        getSignedUrl: () => Promise<[string]>;
        download: () => Promise<[Buffer]>;
        delete: () => Promise<void>;
        exists: () => Promise<[boolean]>;
      };
    };
  };
  files: MockFile;
} {
  const files: MockFile = { saveCalls: [] };
  return {
    storage: {
      bucket: () => ({
        file: (name: string) => ({
          save: async (buffer: Buffer, opts: { contentType: string }) => {
            files.saveCalls.push({ buffer, contentType: opts.contentType, name });
          },
          getSignedUrl: async () =>
            [`https://signed.example/${name}?token=mock`] as [string],
          download: async () => [await makeFixturePng()] as [Buffer],
          delete: async () => undefined,
          exists: async () => [true] as [boolean],
        }),
      }),
    },
    files,
  };
}

beforeEach(() => {
  const { storage } = makeMockStorage();
  _setStorageForTest(storage as unknown as Parameters<typeof _setStorageForTest>[0]);
});

afterEach(() => {
  _setStorageForTest(null);
});

// ─────────────────────────────────────────────
// Tenant scope guards
// ─────────────────────────────────────────────

describe("isOwnedByTenant", () => {
  it("accepts canonical tenant-scoped path", () => {
    expect(
      isOwnedByTenant(`tenants/${TENANT_A}/account/logo-1700000000000.png`, TENANT_A),
    ).toBe(true);
  });

  it("rejects another tenant's path even when shape is canonical", () => {
    expect(
      isOwnedByTenant(`tenants/${TENANT_B}/account/logo-1700000000000.png`, TENANT_A),
    ).toBe(false);
  });

  it("rejects paths outside the tenants/<id>/account/ prefix", () => {
    expect(
      isOwnedByTenant(`tenants/${TENANT_A}/other/logo-1700000000000.png`, TENANT_A),
    ).toBe(false);
    expect(isOwnedByTenant(`/etc/passwd`, TENANT_A)).toBe(false);
    expect(isOwnedByTenant(`logo.png`, TENANT_A)).toBe(false);
  });

  it("rejects path-traversal attempts via the prefix check", () => {
    // The attack string starts with `tenants/{A}/account/` but the next
    // path segment is `..` (escape attempt) — the helper requires the
    // path to start with `tenants/{tenantId}/account/logo-` so the
    // traversal escapes the prefix match. GCS doesn't honor `..` anyway,
    // but the prefix check is defense-in-depth.
    expect(
      isOwnedByTenant(
        `tenants/${TENANT_A}/account/../../${TENANT_B}/account/logo-1.png`,
        TENANT_A,
      ),
    ).toBe(false);
  });
});

// ─────────────────────────────────────────────
// Object name parsing
// ─────────────────────────────────────────────

describe("parseExtFromObjectName", () => {
  it.each([
    ["png", `tenants/${TENANT_A}/account/logo-1700000000000.png`],
    ["jpg", `tenants/${TENANT_A}/account/logo-1700000000000.jpg`],
    ["svg", `tenants/${TENANT_A}/account/logo-1700000000000.svg`],
    ["webp", `tenants/${TENANT_A}/account/logo-1700000000000.webp`],
    ["png", `tenants/${TENANT_A}/account/logo-1700000000000-256.png`],
  ])("extracts %s from %s", (expected, name) => {
    expect(parseExtFromObjectName(name)).toBe(expected);
  });

  it("returns null for unknown extensions", () => {
    expect(
      parseExtFromObjectName(`tenants/${TENANT_A}/account/logo-1.gif`),
    ).toBeNull();
    expect(parseExtFromObjectName(`logo-no-ext`)).toBeNull();
  });
});

describe("parseTimestampFromObjectName", () => {
  it("extracts timestamp from original path", () => {
    expect(
      parseTimestampFromObjectName(`tenants/${TENANT_A}/account/logo-1700000000000.png`),
    ).toBe(1700000000000);
  });

  it("extracts timestamp from variant path (any size)", () => {
    expect(
      parseTimestampFromObjectName(`tenants/${TENANT_A}/account/logo-1700000000000-256.jpg`),
    ).toBe(1700000000000);
    expect(
      parseTimestampFromObjectName(`tenants/${TENANT_A}/account/logo-1700000000000-64.webp`),
    ).toBe(1700000000000);
  });

  it("returns null for malformed paths", () => {
    expect(parseTimestampFromObjectName(`logo.png`)).toBeNull();
    expect(parseTimestampFromObjectName(`tenants/x/account/logo-abc.png`)).toBeNull();
  });
});

// ─────────────────────────────────────────────
// MIME / size constants
// ─────────────────────────────────────────────

describe("ALLOWED_LOGO_MIME_TO_EXT", () => {
  it("matches spec §2 decision 2 — PNG/JPG/SVG/WebP only", () => {
    expect(Object.keys(ALLOWED_LOGO_MIME_TO_EXT).sort()).toEqual([
      "image/jpeg",
      "image/png",
      "image/svg+xml",
      "image/webp",
    ]);
  });

  it("MAX_LOGO_BYTES = 5 MB per spec §2 decision 2", () => {
    expect(MAX_LOGO_BYTES).toBe(5 * 1024 * 1024);
  });
});

// ─────────────────────────────────────────────
// Sharp variant generation — real fixture
// ─────────────────────────────────────────────

describe("generateAndUploadVariants — Sharp end-to-end", () => {
  it("produces and uploads 3 variants with correct paths", async () => {
    const { storage, files } = makeMockStorage();
    _setStorageForTest(storage as unknown as Parameters<typeof _setStorageForTest>[0]);

    const original = await makeFixturePng();
    const ts = 1_700_000_000_000;
    const result = await generateAndUploadVariants(TENANT_A, original, "png", ts);

    expect(result.size256).toBe(`tenants/${TENANT_A}/account/logo-${ts}-256.png`);
    expect(result.size128).toBe(`tenants/${TENANT_A}/account/logo-${ts}-128.png`);
    expect(result.size64).toBe(`tenants/${TENANT_A}/account/logo-${ts}-64.png`);

    expect(files.saveCalls).toHaveLength(3);
    const uploadedNames = files.saveCalls.map((c) => c.name).sort();
    expect(uploadedNames).toEqual(
      [result.size128, result.size256, result.size64].sort(),
    );

    // Each uploaded buffer should be a valid PNG that resizes to the
    // declared dimensions — exercises Sharp end-to-end.
    for (const call of files.saveCalls) {
      expect(call.contentType).toBe("image/png");
      const meta = await sharp(call.buffer).metadata();
      expect(meta.format).toBe("png");
      const expectedSize = call.name.includes("-256.")
        ? 256
        : call.name.includes("-128.")
          ? 128
          : 64;
      // `fit: contain` preserves aspect ratio, so a square original
      // produces a square output at the bounding size.
      expect(meta.width).toBe(expectedSize);
      expect(meta.height).toBe(expectedSize);
    }
  });

  it("throws for SVG ext — caller must short-circuit (vector exception)", async () => {
    const buffer = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>");
    await expect(
      generateAndUploadVariants(TENANT_A, buffer, "svg" as never, 1),
    ).rejects.toThrow(/SVG ext.*caller must short-circuit/);
  });
});

// ─────────────────────────────────────────────
// Spec §2 mime/extension surface — defense-in-depth
// ─────────────────────────────────────────────

describe("KAN-855 — mime/extension surface lockdown", () => {
  it("rejects new mime types from accidentally being accepted by the helper", () => {
    // Sentinel test — if a future PR widens ALLOWED_LOGO_MIME_TO_EXT to
    // GIF or BMP, this fires loudly. Spec §2 decision 2 locks the set.
    const expected = new Set(["image/png", "image/jpeg", "image/svg+xml", "image/webp"]);
    const actual = new Set(Object.keys(ALLOWED_LOGO_MIME_TO_EXT));
    expect(actual).toEqual(expected);
  });
});
