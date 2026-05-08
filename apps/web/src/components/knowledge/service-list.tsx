// PROMOTION CANDIDATE: lift into packages/ui in KAN-847
// Used by: Knowledge admin page (KAN-XXX)

/**
 * ServiceList — admin list view for tenant Service entries (first-class
 * entity per KAN-XXX, parallel to FaqEntry from KAN-849).
 *
 * **Layout** mirrors FaqList structure with Service-specific columns:
 *   - Title (truncated, click row to expand)
 *   - Price (formatted: "$50 per hour" or custom label)
 *   - Status (StatusPill)
 *   - Last updated (relativeTime)
 *   - Row actions (Edit / Delete)
 *
 * **DS v1 compliance:**
 *  - All colors via `--ds-*` tokens
 *  - Three-part empty state per spec docs/design-system/v1.md Part 4
 *  - Skeleton loading + system-retriable error state (mirrors FaqList)
 *  - Sentence case + verb+object button labels
 *
 * **Polling contract:** 5s while any entry has status='queued' or 'embedding';
 * off otherwise. Identical pattern to FaqList.
 */
"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { StatusPill, type StatusPillStatus } from "@/components/ui/knowledge/status-pill";
import { AddServiceDialog } from "./add-service-dialog";
import { EditServiceDialog } from "./edit-service-dialog";
import { DeleteServiceConfirm } from "./delete-service-confirm";
import { API_BASE, buildHeaders } from "@/lib/api";
import { relativeTime } from "@/lib/relative-time";
import { formatServicePrice, type ServicePriceUnit } from "@/lib/service-pricing";

// KAN-851 fix-forward: `price` accepts `string | number | null` because
// Prisma serializes Decimal columns to string in JSON ("250.00"). The
// formatServicePrice helper coerces both shapes via Number().
interface Service {
  id: string;
  title: string;
  description: string;
  price: string | number | null;
  priceUnit: ServicePriceUnit;
  priceCustomLabel: string | null;
  startDate: string | null;
  endDate: string | null;
  includedItems: string[];
  excludedItems: string[];
  status: StatusPillStatus;
  errorDetail: string | null;
  createdAt: string;
  updatedAt: string;
}

const TITLE_PREVIEW_CHARS = 80;

export function ServiceList(): React.ReactElement {
  const [isAddDialogOpen, setIsAddDialogOpen] = React.useState(false);
  const [editTarget, setEditTarget] = React.useState<Service | null>(null);
  const [deleteTarget, setDeleteTarget] = React.useState<{ id: string; title: string } | null>(null);

  const servicesQuery = useQuery<{ services: Service[] }>({
    queryKey: ["knowledge", "services"],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/api/knowledge/services`, {
        headers: await buildHeaders(),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as { services: Service[] };
    },
    refetchInterval: (data: { services: Service[] } | undefined): number | false => {
      const services = data?.services ?? [];
      return services.some((s) => s.status === "queued" || s.status === "embedding") ? 5000 : false;
    },
  });

  const services = servicesQuery.data?.services ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-end">
        <Button onClick={() => setIsAddDialogOpen(true)} aria-label="Add service">
          Add service
        </Button>
      </div>

      <div className="mt-2">
        {servicesQuery.isLoading ? (
          <SkeletonTable />
        ) : servicesQuery.isError ? (
          <ErrorState onRetry={() => void servicesQuery.refetch()} />
        ) : services.length === 0 ? (
          <EmptyState onAdd={() => setIsAddDialogOpen(true)} />
        ) : (
          <ServiceTable
            services={services}
            onEdit={(s) => setEditTarget(s)}
            onRequestDelete={(id, title) => setDeleteTarget({ id, title })}
          />
        )}
      </div>

      <AddServiceDialog open={isAddDialogOpen} onOpenChange={setIsAddDialogOpen} />

      <EditServiceDialog
        service={editTarget}
        open={editTarget !== null}
        onOpenChange={(next) => {
          if (!next) setEditTarget(null);
        }}
      />

      <DeleteServiceConfirm
        serviceId={deleteTarget?.id ?? null}
        title={deleteTarget?.title ?? null}
        open={deleteTarget !== null}
        onOpenChange={(next) => {
          if (!next) setDeleteTarget(null);
        }}
      />
    </div>
  );
}

// ─────────────────────────────────────────────
// EmptyState — three-part formula per DS v1 spec Part 4
// ─────────────────────────────────────────────

function EmptyState({ onAdd }: { onAdd: () => void }): React.ReactElement {
  return (
    <div
      className="flex flex-col items-center text-center py-16 px-6 rounded-lg border"
      style={{
        backgroundColor: "var(--ds-surface-raised)",
        borderColor: "var(--ds-border-subtle)",
      }}
    >
      <h3 className="text-h3 mb-2" style={{ color: "var(--ds-ink-primary)" }}>
        No services yet.
      </h3>
      <p
        className="text-body max-w-md mb-6"
        style={{ color: "var(--ds-ink-secondary)" }}
      >
        Services appear here as you create them. The AI cites them when a customer asks about pricing or what you offer.
      </p>
      <Button onClick={onAdd} aria-label="Add service">
        Add service
      </Button>
    </div>
  );
}

// ─────────────────────────────────────────────
// SkeletonTable
// ─────────────────────────────────────────────

function SkeletonTable(): React.ReactElement {
  return (
    <div
      className="rounded-lg border overflow-hidden"
      style={{ borderColor: "var(--ds-border-subtle)" }}
      aria-label="Loading services"
      role="status"
    >
      {Array.from({ length: 4 }, (_, i) => (
        <div
          key={i}
          className="flex items-center gap-4 px-4 py-4 border-b last:border-0"
          style={{ borderColor: "var(--ds-border-subtle)" }}
        >
          <div
            className="rounded h-4 flex-[2]"
            style={{ backgroundColor: "var(--ds-surface-sunken)" }}
            aria-hidden="true"
          />
          <div
            className="rounded h-4 flex-1"
            style={{ backgroundColor: "var(--ds-surface-sunken)" }}
            aria-hidden="true"
          />
          <div
            className="rounded h-4 flex-1"
            style={{ backgroundColor: "var(--ds-surface-sunken)" }}
            aria-hidden="true"
          />
          <div
            className="rounded h-4 w-24"
            style={{ backgroundColor: "var(--ds-surface-sunken)" }}
            aria-hidden="true"
          />
        </div>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────
// ErrorState
// ─────────────────────────────────────────────

function ErrorState({ onRetry }: { onRetry: () => void }): React.ReactElement {
  return (
    <div
      role="alert"
      className="flex flex-col items-center text-center py-12 px-6 rounded-lg border"
      style={{
        backgroundColor: "var(--ds-danger-soft)",
        borderColor: "var(--ds-danger)",
        color: "var(--ds-danger-text)",
      }}
    >
      <p className="text-body mb-4">
        We couldn&apos;t load your services. Try again.
      </p>
      <Button variant="outline" onClick={onRetry} aria-label="Retry loading services">
        Try again
      </Button>
    </div>
  );
}

// ─────────────────────────────────────────────
// ServiceTable
// ─────────────────────────────────────────────

function ServiceTable({
  services,
  onEdit,
  onRequestDelete,
}: {
  services: Service[];
  onEdit: (s: Service) => void;
  onRequestDelete: (id: string, title: string) => void;
}): React.ReactElement {
  return (
    <div
      className="rounded-lg border overflow-hidden"
      style={{ borderColor: "var(--ds-border-subtle)" }}
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Title</TableHead>
            <TableHead>Price</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Last updated</TableHead>
            <TableHead aria-label="Row actions"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {services.map((s) => {
            const truncatedTitle =
              s.title.length > TITLE_PREVIEW_CHARS
                ? `${s.title.slice(0, TITLE_PREVIEW_CHARS)}…`
                : s.title;
            const priceLabel = formatServicePrice(s);
            return (
              <TableRow key={s.id} data-service-id={s.id}>
                <TableCell className="font-medium" title={s.title}>
                  {truncatedTitle}
                </TableCell>
                <TableCell style={{ color: "var(--ds-ink-tertiary)" }}>
                  {priceLabel}
                </TableCell>
                <TableCell>
                  <StatusPill status={s.status} />
                </TableCell>
                <TableCell style={{ color: "var(--ds-ink-tertiary)" }}>
                  {relativeTime(new Date(s.updatedAt))}
                </TableCell>
                <TableCell>
                  <div className="flex gap-2 justify-end">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => onEdit(s)}
                      aria-label={`Edit service: ${truncatedTitle}`}
                    >
                      Edit
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => onRequestDelete(s.id, s.title)}
                      aria-label={`Delete service: ${truncatedTitle}`}
                    >
                      Delete
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
