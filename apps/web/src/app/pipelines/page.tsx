/**
 * KAN-718 — /pipelines redirect.
 *
 * The mock-data /pipelines route was retired. The real-data pipeline UI lives
 * at /settings/pipelines (KAN-702 PR B). This page exists ONLY to preserve any
 * external links/bookmarks via a permanent redirect, NOT to render content.
 *
 * Once /pipelines hasn't seen meaningful traffic for ~30 days post-launch, the
 * route can be deleted entirely (404 instead of redirect). Tracked alongside
 * KAN-756 URL/API rationalization in Sprint 5+.
 */
import { redirect } from "next/navigation";

export default function PipelinesPage(): never {
  redirect("/settings/pipelines");
}
