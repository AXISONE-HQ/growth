/**
 * KAN-1140 Phase 1 PR 4 — Vendor handler barrel + registry bootstrap.
 *
 * Mirrors `apps/connectors/src/adapters/index.ts` precedent:
 * adapters/handlers self-register at startup via this module's
 * `registerAllVendorHandlers()` call.
 *
 * Detection order is registration order (Map insertion order is stable per
 * ECMA-262). Formspree is registered first because it's the only live
 * vendor today; stubs come after (their detect() returns false unconditionally
 * so the order is forensic-only until they activate).
 */
import { vendorRegistry } from "../registry.js";
import { formspreeHandler } from "../formspree-email.js";
import { tallyHandler } from "./tally-handler.js";
import { typeformHandler } from "./typeform-handler.js";
import { webflowHandler } from "./webflow-handler.js";

export { tallyHandler, typeformHandler, webflowHandler };

/**
 * Register all known vendor handlers in detection order. Call once at app
 * startup (apps/connectors/src/index.ts). Idempotent guard via the registry's
 * `clear()` method — tests can re-register from a clean state.
 */
export function registerAllVendorHandlers(): void {
  vendorRegistry.register(formspreeHandler);
  vendorRegistry.register(tallyHandler);
  vendorRegistry.register(typeformHandler);
  vendorRegistry.register(webflowHandler);
}
