/**
 * KAN-1140 Phase 1 PR 4 — Typeform form-vendor handler stub.
 *
 * Detection-only stub; template for activation when AxisOne onboards a
 * Typeform-using customer. See tally-handler.ts for the activation playbook.
 */
import type {
  VendorHandler,
  VendorDetectionInput,
  VendorExtractionInput,
  VendorExtraction,
} from "../registry.js";

export const typeformHandler: VendorHandler = {
  name: "typeform",
  detect(_payload: VendorDetectionInput): boolean {
    return false;
  },
  extract(_payload: VendorExtractionInput): VendorExtraction | null {
    throw new Error(
      "typeform handler not implemented — stub registered for KAN-1140 Phase 1 PR 4 template; activate when a Typeform-using customer onboards",
    );
  },
};
