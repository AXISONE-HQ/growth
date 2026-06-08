/**
 * KAN-1140 Phase 1 PR 4 — Vendor-detection registry.
 *
 * Plugin pattern for form-vendor email parsers. Each handler self-identifies
 * via a cheap `detect()` predicate; the registry iterates handlers
 * first-match-wins. Mirrors the API surface of `adapters/registry.ts` (the
 * ChannelAdapter precedent) for naming + convention consistency, with one
 * added method (`detect`) since vendor identification is detection-driven
 * rather than key-driven.
 *
 * Currently registered handlers (see vendor-handlers/index.ts barrel):
 *   - formspreeHandler (live — KAN-954)
 *   - tallyHandler (stub — KAN-1140 Phase 1 PR 4 template)
 *   - typeformHandler (stub — KAN-1140 Phase 1 PR 4 template)
 *   - webflowHandler (stub — KAN-1140 Phase 1 PR 4 template)
 *
 * Adding a new vendor:
 *   1. Create `vendor-handlers/<name>-handler.ts` implementing VendorHandler
 *   2. Register it in `vendor-handlers/index.ts` registerAllVendorHandlers
 *   3. Add tests at `__tests__/<name>-handler.test.ts`
 *   No webhook handler change needed — the registry dispatch is uniform.
 */

/**
 * Lightweight detection input — every vendor handler can decide from these
 * three signals. Cheap to compute; webhook supplies all three from the
 * Resend Receiving API response shape.
 */
export interface VendorDetectionInput {
  fromHeader: string;
  subject: string | null;
  text: string | null;
}

/**
 * Full extraction input. Extends detection input with `replyTo` because some
 * vendors (Formspree V1) carry the real submitter's identity on the Reply-To
 * header rather than embedded in the body.
 */
export interface VendorExtractionInput extends VendorDetectionInput {
  replyTo: string[];
}

/**
 * Normalized extraction shape — uniform across all vendor handlers so the
 * webhook handler treats every vendor identically downstream. Maps directly
 * to the wire `lead.received` event metadata + the Contact upsert input.
 */
export interface VendorExtraction {
  /** The real submitter's email (post-vendor-relay translation — e.g.,
   *  Formspree's `noreply@formspree.io` From is replaced by the real
   *  submitter from Reply-To or the body). */
  senderEmail: string;
  /** Optional identity fields — populate Contact row when available. */
  firstName?: string | null;
  lastName?: string | null;
  companyName?: string | null;
  /** Wire metadata for `lead.received`. `vendor` matches the handler's name. */
  vendor: string;
  formSource?: string | null;
  leadType?: string | null;
  dealName?: string;
  customFields?: Record<string, string>;
}

/**
 * A vendor handler. Stateless; cheap to instantiate; pure functions.
 *
 * detect() runs on every inbound until first match returns true. Should be
 * fast (header check, sender-domain check). Returning true commits the
 * webhook to this handler — no further handlers are consulted.
 *
 * extract() runs only when detect() returned true. May return null on
 * extraction failure (publish raw with low-confidence per KAN-1141 PR 0
 * doctrine — never drop a lead).
 */
export interface VendorHandler {
  readonly name: string;
  detect(payload: VendorDetectionInput): boolean;
  extract(payload: VendorExtractionInput): VendorExtraction | null;
}

/**
 * Registry contract. Mirrors `AdapterRegistry` shape from
 * `@growth/connector-contracts` (used by ChannelAdapter at
 * apps/connectors/src/adapters/registry.ts) for convention consistency.
 */
export interface VendorRegistry {
  register(handler: VendorHandler): void;
  list(): VendorHandler[];
  /**
   * Iterate registered handlers; return the first whose detect() returned
   * true OR null if no handler matched. Detection order is registration order
   * (Map insertion order is stable per ECMA-262).
   */
  detect(payload: VendorDetectionInput): VendorHandler | null;
  /** Reset state — used by tests + the webhook bootstrap. */
  clear(): void;
}

class InMemoryVendorRegistry implements VendorRegistry {
  private readonly handlers = new Map<string, VendorHandler>();

  register(handler: VendorHandler): void {
    if (this.handlers.has(handler.name)) {
      throw new Error(
        `Vendor handler already registered for name="${handler.name}". ` +
          `Check vendor-handlers/index.ts for duplicates.`,
      );
    }
    this.handlers.set(handler.name, handler);
  }

  list(): VendorHandler[] {
    return Array.from(this.handlers.values());
  }

  detect(payload: VendorDetectionInput): VendorHandler | null {
    for (const handler of this.handlers.values()) {
      if (handler.detect(payload)) return handler;
    }
    return null;
  }

  clear(): void {
    this.handlers.clear();
  }
}

/**
 * Module-scoped singleton. Production code uses this; tests can either
 * (a) instantiate their own `InMemoryVendorRegistry` for isolation OR
 * (b) call `vendorRegistry.clear()` + re-register a subset for test scope.
 */
export const vendorRegistry: VendorRegistry = new InMemoryVendorRegistry();
