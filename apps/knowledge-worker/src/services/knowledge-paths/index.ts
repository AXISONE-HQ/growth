/**
 * KAN-707 PR B — Path handler registry.
 *
 * Maps `IngestionPathInput.path` discriminator to the matching handler. The
 * worker binary uses this to dispatch by path; tests use it to verify the
 * wiring without coupling to specific handler imports.
 */
import { ingestQaPair } from "./qa-pair.js";
import { ingestDocument } from "./document.js";
import { ingestUrl } from "./url.js";
import type { PathHandler } from "./types.js";

export const pathHandlers: Record<"url" | "document" | "qa_pair", PathHandler> = {
  url: ingestUrl,
  document: ingestDocument,
  qa_pair: ingestQaPair,
};

export { ingestQaPair, ingestDocument, ingestUrl };
export type { PathHandler, PathHandlerDeps, IngestionPathInput, IngestionPathResult } from "./types.js";
