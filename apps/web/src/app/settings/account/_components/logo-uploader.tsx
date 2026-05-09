"use client";

/**
 * KAN-855 — Logo uploader (signed-URL flow).
 *
 * 3-step flow per spec §7.2:
 *   1. Client validates file (type whitelist + ≤5MB) before any API call
 *   2. POST to account.uploadLogo → server returns { uploadUrl, uploadId }
 *   3. PUT file body to uploadUrl (direct browser → GCS, no API roundtrip)
 *   4. POST to account.finalizeLogo with uploadId → server runs Sharp,
 *      returns updated AccountProfile (with signed GET URLs)
 *
 * SVG note: spec §2 decision 2 — SVG is vector, no raster resize. The
 * server short-circuits for SVG; client doesn't care.
 *
 * Drag-drop + file picker both supported (a11y both paths). Drag overlay
 * triggered via dragenter/dragleave. The `<button>` opens the hidden
 * `<input type="file">` for keyboard-only users.
 *
 * Variant generation can fail (Sharp timeout, malformed image). The
 * server returns `variantWarning` non-null in that case; we surface a
 * "Retry thumbnails" button that calls account.regenerateVariants.
 */
import * as React from "react";
import { Button } from "@/components/ui/button";
import { trpcMutation } from "@/lib/api";
import { toast } from "sonner";

const ALLOWED_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/svg+xml",
  "image/webp",
]);
const MAX_BYTES = 5 * 1024 * 1024;

interface AccountLogoState {
  logoUrl: string | null;
  logoVariants: { 256: string; 128: string; 64: string } | null;
  variantWarning?: string | null;
}

interface LogoUploaderProps {
  /** Current logo URL (signed GET, 1hr TTL); null when no logo set. */
  currentUrl: string | null;
  /** Variant URLs; null when Sharp failed or no logo. */
  variants: { 256: string; 128: string; 64: string } | null;
  /** Truthy when the last finalize returned a non-null variantWarning. */
  variantWarning?: string | null;
  /** Called with the updated AccountProfile shape after every successful
   * upload / finalize / remove / regenerate. Parent merges into form state. */
  onChange: (next: AccountLogoState) => void;
}

type UploadPhase = "idle" | "validating" | "uploading" | "finalizing" | "removing" | "regenerating";

export function LogoUploader({
  currentUrl,
  variants,
  variantWarning,
  onChange,
}: LogoUploaderProps): React.ReactElement {
  const [phase, setPhase] = React.useState<UploadPhase>("idle");
  const [error, setError] = React.useState<string | null>(null);
  const [isDragOver, setIsDragOver] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  const display256 = variants?.[256] ?? currentUrl;
  const isBusy = phase !== "idle";

  function clientValidate(file: File): string | null {
    if (!ALLOWED_MIMES.has(file.type)) {
      return "Use PNG, JPG, SVG, or WebP.";
    }
    if (file.size > MAX_BYTES) {
      return "Logo must be under 5 MB. Try a smaller file.";
    }
    if (file.size === 0) {
      return "File is empty.";
    }
    return null;
  }

  async function handleFile(file: File): Promise<void> {
    setError(null);
    setPhase("validating");
    const validationError = clientValidate(file);
    if (validationError) {
      setError(validationError);
      setPhase("idle");
      return;
    }
    try {
      setPhase("uploading");
      const upload = await trpcMutation<{
        uploadUrl: string;
        uploadId: string;
        contentType: string;
      }>("account.uploadLogo", {
        contentType: file.type,
        sizeBytes: file.size,
      });
      const putRes = await fetch(upload.uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": upload.contentType },
        body: file,
      });
      if (!putRes.ok) {
        throw new Error(`Upload failed (HTTP ${putRes.status})`);
      }
      setPhase("finalizing");
      const finalized = await trpcMutation<AccountLogoState>("account.finalizeLogo", {
        uploadId: upload.uploadId,
      });
      onChange(finalized);
      if (finalized.variantWarning) {
        toast.message("Logo uploaded — thumbnails couldn't be generated.");
      } else {
        toast.success("Logo uploaded.");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Upload failed. Try again.";
      setError(message);
      toast.error(message);
    } finally {
      setPhase("idle");
    }
  }

  async function handleRemove(): Promise<void> {
    setError(null);
    setPhase("removing");
    try {
      const updated = await trpcMutation<AccountLogoState>("account.removeLogo", {});
      onChange(updated);
      toast.success("Logo removed.");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Remove failed. Try again.";
      setError(message);
      toast.error(message);
    } finally {
      setPhase("idle");
    }
  }

  async function handleRegenerate(): Promise<void> {
    setError(null);
    setPhase("regenerating");
    try {
      const updated = await trpcMutation<AccountLogoState>("account.regenerateVariants", {});
      onChange(updated);
      toast.success("Thumbnails generated.");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Retry failed. Try again.";
      setError(message);
      toast.error(message);
    } finally {
      setPhase("idle");
    }
  }

  function onPickerChange(e: React.ChangeEvent<HTMLInputElement>): void {
    const file = e.target.files?.[0];
    if (file) void handleFile(file);
    e.target.value = ""; // allow re-selecting the same file
  }

  function onDrop(e: React.DragEvent<HTMLDivElement>): void {
    e.preventDefault();
    setIsDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void handleFile(file);
  }

  return (
    <div className="flex flex-col gap-3">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragOver(true);
        }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={onDrop}
        className={[
          "flex items-center gap-4 p-4 rounded-lg border-2 border-dashed motion-default",
          isDragOver ? "bg-muted/50" : "",
        ].join(" ")}
        style={{
          borderColor: isDragOver ? "var(--ds-violet-500)" : "var(--ds-border-subtle)",
        }}
      >
        <div
          className="flex items-center justify-center w-20 h-20 rounded-md overflow-hidden flex-shrink-0"
          style={{ backgroundColor: "var(--ds-surface-sunken)" }}
          aria-label={display256 ? "Current logo preview" : "No logo set"}
        >
          {display256 ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={display256}
              alt=""
              className="w-full h-full object-contain"
            />
          ) : (
            <span
              className="text-xs"
              style={{ color: "var(--ds-ink-tertiary)" }}
            >
              No logo
            </span>
          )}
        </div>

        <div className="flex flex-col gap-1 flex-1">
          <p className="text-sm font-medium" style={{ color: "var(--ds-ink-primary)" }}>
            {currentUrl ? "Replace your logo or remove it." : "Upload your logo."}
          </p>
          <p className="text-xs" style={{ color: "var(--ds-ink-tertiary)" }}>
            PNG, JPG, SVG, or WebP. Up to 5 MB.
          </p>
          <div className="flex gap-2 mt-1">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isBusy}
              onClick={() => inputRef.current?.click()}
              aria-label={currentUrl ? "Replace logo" : "Upload logo"}
            >
              {phase === "uploading" || phase === "finalizing" || phase === "validating"
                ? "Uploading…"
                : currentUrl
                  ? "Replace logo"
                  : "Upload logo"}
            </Button>
            {currentUrl ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={isBusy}
                onClick={() => void handleRemove()}
                aria-label="Remove logo"
              >
                {phase === "removing" ? "Removing…" : "Remove logo"}
              </Button>
            ) : null}
          </div>
        </div>

        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/svg+xml,image/webp"
          className="sr-only"
          onChange={onPickerChange}
          aria-label="Choose logo file"
        />
      </div>

      {variantWarning ? (
        <div
          role="status"
          className="flex items-center justify-between gap-3 p-3 rounded-md text-sm"
          style={{
            backgroundColor: "var(--ds-warning-soft)",
            color: "var(--ds-warning-text)",
          }}
        >
          <span>Logo uploaded, but thumbnails couldn&apos;t be generated.</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={isBusy}
            onClick={() => void handleRegenerate()}
            aria-label="Retry thumbnails"
          >
            {phase === "regenerating" ? "Retrying…" : "Retry thumbnails"}
          </Button>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="text-sm" style={{ color: "var(--ds-danger-text)" }}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
