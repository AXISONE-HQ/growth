'use client';

/**
 * KAN-932 — EntityFormShell (Cohort 3 Foundation).
 *
 * Page layout shell for all Cohort 3 CRUD forms (Contact, Company, Deal,
 * Order). Provides:
 *   - Header with title + breadcrumb + back navigation
 *   - Card-grouped body via children prop (form sections per Q7 design)
 *   - Sticky bottom Save bar with Cancel + Save buttons
 *   - Top-of-body error banner when `errors` prop populated
 *
 * Save button disabled when !isDirty || isPending per Q3+Q4 locked
 * design decisions. Cancel button always enabled, navigates back via
 * router.back().
 */
import { useRouter } from 'next/navigation';
import { AlertTriangle, ArrowLeft, Loader2, Save } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';

const HEADER_STYLE = { color: 'var(--ds-ink-primary)' } as const;
const MUTED_STYLE = { color: 'var(--ds-ink-tertiary)' } as const;

export interface BreadcrumbItem {
  label: string;
  href: string;
}

export interface EntityFormShellProps {
  title: string;
  breadcrumb?: BreadcrumbItem[];
  mode: 'create' | 'edit';
  isPending: boolean;
  isDirty: boolean;
  onSave: () => void;
  /**
   * Optional cancel handler. When omitted, defaults to `router.back()`.
   * Useful when the entity form needs custom cleanup (e.g., abort an
   * in-flight image upload) before navigation.
   */
  onCancel?: () => void;
  /** Top-level error messages displayed in a banner above body. */
  errors?: string[];
  /** Form body (Card-grouped sections per Q7). */
  children: React.ReactNode;
}

export function EntityFormShell({
  title,
  breadcrumb,
  mode,
  isPending,
  isDirty,
  onSave,
  onCancel,
  errors,
  children,
}: EntityFormShellProps) {
  const router = useRouter();
  const handleCancel = onCancel ?? (() => router.back());
  const canSave = isDirty && !isPending;
  const hasErrors = errors && errors.length > 0;

  return (
    <div className="max-w-4xl mx-auto p-6 pb-32">
      {/* Header */}
      <div className="mb-6">
        {breadcrumb && breadcrumb.length > 0 ? (
          <nav aria-label="Breadcrumb" className="text-sm mb-2" style={MUTED_STYLE}>
            <ol className="flex flex-wrap gap-1 items-center">
              {breadcrumb.map((item, i) => (
                <li key={i} className="flex items-center gap-1">
                  <Link href={item.href} className="hover:underline">
                    {item.label}
                  </Link>
                  {i < breadcrumb.length - 1 ? <span>/</span> : null}
                </li>
              ))}
            </ol>
          </nav>
        ) : null}
        <div className="flex items-center gap-3">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleCancel}
            aria-label="Go back"
          >
            <ArrowLeft className="w-4 h-4" />
          </Button>
          <h1 className="text-xl font-semibold" style={HEADER_STYLE}>
            {title}
          </h1>
          <span
            className="text-xs px-2 py-0.5 rounded uppercase tracking-wider"
            style={{ backgroundColor: 'var(--ds-violet-50)', color: 'var(--ds-violet-700)' }}
          >
            {mode === 'create' ? 'New' : 'Edit'}
          </span>
        </div>
      </div>

      {/* Error banner */}
      {hasErrors ? (
        <div
          className="flex items-start gap-2 p-3 mb-4 rounded-md border"
          style={{
            backgroundColor: 'var(--ds-danger-soft)',
            color: 'var(--ds-danger-text)',
            borderColor: 'var(--ds-danger)',
          }}
          role="alert"
        >
          <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" aria-hidden />
          <div className="text-sm">
            <ul className="list-disc pl-5">
              {errors!.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}

      {/* Body — Card-grouped sections passed as children */}
      <div className="space-y-4">{children}</div>

      {/* Sticky bottom Save bar */}
      <div
        className="fixed bottom-0 left-0 right-0 bg-white border-t px-6 py-3 shadow-lg z-10"
        style={{ borderColor: 'var(--ds-border-default)' }}
      >
        <div className="max-w-4xl mx-auto flex items-center justify-end gap-3">
          <Button
            type="button"
            variant="outline"
            onClick={handleCancel}
            disabled={isPending}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={onSave}
            disabled={!canSave}
            variant="default"
          >
            {isPending ? (
              <>
                <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
                Saving…
              </>
            ) : (
              <>
                <Save className="w-4 h-4 mr-1.5" />
                {mode === 'create' ? 'Create' : 'Save changes'}
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
