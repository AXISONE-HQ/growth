/**
 * KAN-829 sub-cohort 3 — Knowledge Sources admin route.
 *
 * Recreated route after KAN-826 Option B cleanup deleted the legacy
 * KAN-707 admin UI. Server Component shell that imports the Client
 * Component with TanStack Query polling.
 */
import { SourceList } from "@/components/knowledge/source-list";

export default function KnowledgeSourcesPage(): JSX.Element {
  return <SourceList />;
}
