/**
 * KAN-1140 Phase 1 PR 4 — Webflow form-vendor handler stub.
 *
 * Detection-only stub; template for activation when AxisOne onboards a
 * Webflow-using customer. See tally-handler.ts for the activation playbook.
 */
import type {
  VendorHandler,
  VendorDetectionInput,
  VendorExtractionInput,
  VendorExtraction,
} from "../registry.js";

export const webflowHandler: VendorHandler = {
  name: "webflow",
  detect(_payload: VendorDetectionInput): boolean {
    return false;
  },
  extract(_payload: VendorExtractionInput): VendorExtraction | null {
    throw new Error(
      "webflow handler not implemented — stub registered for KAN-1140 Phase 1 PR 4 template; activate when a Webflow-using customer onboards",
    );
  },
};
