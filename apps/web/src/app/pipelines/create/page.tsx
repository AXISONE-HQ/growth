/**
 * KAN-718 — /pipelines/create redirect.
 *
 * Same pattern as /pipelines (parent): mock-data route retired; real-data
 * pipeline-creation wizard lives at /settings/pipelines/new (KAN-702 PR B).
 */
import { redirect } from "next/navigation";

export default function PipelinesCreatePage(): never {
  redirect("/settings/pipelines/new");
}
