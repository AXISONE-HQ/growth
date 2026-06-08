/**
 * KAN-1140 Phase 1 PR 4 — Tally form-vendor handler stub.
 *
 * Detection-only stub; template for activation when AxisOne onboards a
 * Tally-using customer. `detect()` returns false unconditionally so this
 * handler never fires; `extract()` throws if reached (defensive — should
 * be unreachable via the registry's first-match-wins iteration).
 *
 * Activation steps:
 *   1. Identify Tally's email forwarding shape (sender domain + body schema)
 *   2. Replace `detect()` with a real predicate
 *   3. Implement `extract()` to map Tally form fields → VendorExtraction
 *   4. Update tests at `__tests__/tally-handler.test.ts`
 *   5. File closing ticket; remove this stub-comment block
 */
import type {
  VendorHandler,
  VendorDetectionInput,
  VendorExtractionInput,
  VendorExtraction,
} from "../registry.js";

export const tallyHandler: VendorHandler = {
  name: "tally",
  detect(_payload: VendorDetectionInput): boolean {
    return false;
  },
  extract(_payload: VendorExtractionInput): VendorExtraction | null {
    throw new Error(
      "tally handler not implemented — stub registered for KAN-1140 Phase 1 PR 4 template; activate when a Tally-using customer onboards",
    );
  },
};
