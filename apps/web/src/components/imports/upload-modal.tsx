'use client';

/**
 * KAN-901 — Upload modal for ImportJob create flow.
 *
 * Consumes the KAN-896 backend contract:
 *   1. importJobsApi.createUploadUrl({ filename, fileSize, fileMimeType, mode })
 *      → { importJobId, signedUploadUrl, gcsObjectPath, expiresAt }
 *   2. XHR PUT to signedUploadUrl with the file body. Progress tracked via
 *      xhr.upload.onprogress so the 20MB cap is endurable for the user.
 *      (Logo upload at KAN-855 uses fetch — no progress, fine for ≤5MB.
 *      Imports need progress feedback.)
 *   3. importJobsApi.confirmUpload({ importJobId }) — synchronous backend
 *      inspection. Returns the ImportJob row with detectedHeaders +
 *      sampleRows + detectedRowCount populated (status='inspected') or
 *      errorMessage set (status='failed').
 *   4. On success: close modal + router.push(`/imports/${id}`).
 *
 * Replace-all warning intentionally muted in V1: the brief says capture
 * the flag but don't promise destruction we won't perform yet (commit
 * phase is PR 8). Re-evaluate when KAN-PR-8 ships.
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Upload, X } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { importJobsApi, type ImportMode } from '@/lib/api';

const ALLOWED_MIMES = new Set<string>([
  'text/csv',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);
const MAX_BYTES = 20 * 1024 * 1024;
const ALLOWED_MIME_LITERALS = [
  'text/csv',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
] as const;
type AllowedMime = (typeof ALLOWED_MIME_LITERALS)[number];

type Phase = 'idle' | 'uploading' | 'inspecting';

interface UploadModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Wrap an XHR PUT in a Promise so the upload flow stays async/await-clean
 *  and lets us surface progress via onProgress. */
function putWithProgress(
  url: string,
  body: File,
  contentType: string,
  onProgress: (percent: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', contentType);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        onProgress(Math.round((e.loaded / e.total) * 100));
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(100);
        resolve();
      } else {
        reject(new Error(`Upload failed (HTTP ${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new Error('Network error during upload'));
    xhr.send(body);
  });
}

export function UploadModal({ open, onOpenChange }: UploadModalProps) {
  const router = useRouter();
  const [mode, setMode] = React.useState<ImportMode>('update_add');
  const [file, setFile] = React.useState<File | null>(null);
  const [phase, setPhase] = React.useState<Phase>('idle');
  const [progress, setProgress] = React.useState(0);
  const [error, setError] = React.useState<string | null>(null);
  const [isDragOver, setIsDragOver] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  const isBusy = phase !== 'idle';

  function reset() {
    setFile(null);
    setPhase('idle');
    setProgress(0);
    setError(null);
    setIsDragOver(false);
  }

  function handleOpenChange(next: boolean) {
    if (!next && isBusy) return; // don't allow close mid-upload
    if (!next) reset();
    onOpenChange(next);
  }

  function clientValidate(f: File): string | null {
    if (!ALLOWED_MIMES.has(f.type) && !/\.(csv|xlsx|xls)$/i.test(f.name)) {
      return 'Unsupported file type. Use CSV or XLSX.';
    }
    if (f.size > MAX_BYTES) {
      return `File too large. Max ${formatBytes(MAX_BYTES)} (yours is ${formatBytes(f.size)}).`;
    }
    if (f.size === 0) {
      return 'File is empty.';
    }
    return null;
  }

  function handleFile(f: File) {
    setError(null);
    const validationError = clientValidate(f);
    if (validationError) {
      setError(validationError);
      setFile(null);
      return;
    }
    setFile(f);
  }

  async function handleUpload() {
    if (!file) return;
    setError(null);

    // Normalize MIME: if the browser sends an empty type but the filename ends
    // in .csv/.xlsx, infer. createUploadUrl's zod enum requires one of three
    // specific strings.
    let mimeType: AllowedMime;
    if ((ALLOWED_MIME_LITERALS as readonly string[]).includes(file.type)) {
      mimeType = file.type as AllowedMime;
    } else if (/\.csv$/i.test(file.name)) {
      mimeType = 'text/csv';
    } else if (/\.xlsx$/i.test(file.name)) {
      mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    } else if (/\.xls$/i.test(file.name)) {
      mimeType = 'application/vnd.ms-excel';
    } else {
      setError('Could not determine file type. Use CSV or XLSX.');
      return;
    }

    try {
      setPhase('uploading');
      setProgress(0);

      const signed = await importJobsApi.createUploadUrl({
        filename: file.name,
        fileSize: file.size,
        fileMimeType: mimeType,
        mode,
      });

      await putWithProgress(signed.signedUploadUrl, file, mimeType, setProgress);

      setPhase('inspecting');
      const inspected = await importJobsApi.confirmUpload(signed.importJobId);

      if (inspected.status === 'failed') {
        setError(inspected.errorMessage ?? 'Inspection failed. The file may be malformed.');
        setPhase('idle');
        return;
      }

      toast.success('Upload complete. Inspection ready.');
      onOpenChange(false);
      reset();
      router.push(`/imports/${signed.importJobId}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Upload failed. Try again.';
      setError(message);
      toast.error(message);
      setPhase('idle');
      setProgress(0);
    }
  }

  function onPickerChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (f) handleFile(f);
    e.target.value = ''; // allow reselecting same file after error
  }

  function onDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setIsDragOver(false);
    if (isBusy) return;
    const f = e.dataTransfer.files?.[0];
    if (f) handleFile(f);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>New upload</DialogTitle>
          <DialogDescription>
            Upload a CSV or XLSX file. We&apos;ll inspect headers and a sample of rows,
            then guide you through mapping (coming in a later release).
          </DialogDescription>
        </DialogHeader>

        {/* Mode selector */}
        <div className="space-y-2">
          <div className="text-sm font-medium">Import mode</div>
          <div className="space-y-2">
            <label
              className={`flex items-start gap-3 rounded-md border p-3 cursor-pointer ${
                mode === 'update_add' ? 'border-indigo-500 bg-indigo-50' : 'border-gray-200'
              }`}
            >
              <input
                type="radio"
                name="import-mode"
                value="update_add"
                checked={mode === 'update_add'}
                onChange={() => setMode('update_add')}
                disabled={isBusy}
                className="mt-1"
              />
              <div className="flex-1">
                <div className="text-sm font-medium text-gray-900">
                  Update + add <span className="text-xs font-normal text-gray-500">(recommended)</span>
                </div>
                <div className="text-xs text-gray-500 mt-0.5">
                  Existing records updated, new records added, existing-not-in-file kept as-is.
                </div>
              </div>
            </label>
            <label
              className={`flex items-start gap-3 rounded-md border p-3 cursor-pointer ${
                mode === 'replace_all' ? 'border-indigo-500 bg-indigo-50' : 'border-gray-200'
              }`}
            >
              <input
                type="radio"
                name="import-mode"
                value="replace_all"
                checked={mode === 'replace_all'}
                onChange={() => setMode('replace_all')}
                disabled={isBusy}
                className="mt-1"
              />
              <div className="flex-1">
                <div className="text-sm font-medium text-gray-900">Replace all</div>
                <div className="text-xs text-gray-500 mt-0.5">
                  Captured for later — the commit phase in a future release will use this flag.
                  No data destruction happens yet.
                </div>
              </div>
            </label>
          </div>
        </div>

        {/* Drag-drop + file picker */}
        <div
          role="button"
          tabIndex={isBusy ? -1 : 0}
          onClick={() => !isBusy && inputRef.current?.click()}
          onKeyDown={(e) => {
            if (!isBusy && (e.key === 'Enter' || e.key === ' ')) {
              e.preventDefault();
              inputRef.current?.click();
            }
          }}
          onDragOver={(e) => {
            e.preventDefault();
            if (!isBusy) setIsDragOver(true);
          }}
          onDragLeave={() => setIsDragOver(false)}
          onDrop={onDrop}
          className={`flex flex-col items-center justify-center rounded-lg border-2 border-dashed p-8 cursor-pointer transition-colors ${
            isDragOver
              ? 'border-indigo-500 bg-indigo-50'
              : 'border-gray-300 hover:border-gray-400'
          } ${isBusy ? 'opacity-50 pointer-events-none' : ''}`}
        >
          <Upload className="w-8 h-8 text-gray-400 mb-2" />
          {file ? (
            <div className="text-center">
              <div className="text-sm font-medium text-gray-900">{file.name}</div>
              <div className="text-xs text-gray-500 mt-0.5">{formatBytes(file.size)}</div>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  if (!isBusy) {
                    setFile(null);
                    setError(null);
                  }
                }}
                disabled={isBusy}
                className="text-xs text-gray-500 underline mt-2 inline-flex items-center gap-1"
              >
                <X className="w-3 h-3" /> Remove
              </button>
            </div>
          ) : (
            <>
              <p className="text-sm font-medium text-gray-900">Drag a CSV or XLSX here, or click to browse</p>
              <p className="text-xs text-gray-500 mt-1">Max {formatBytes(MAX_BYTES)}</p>
            </>
          )}
          <input
            ref={inputRef}
            type="file"
            accept=".csv,.xlsx,.xls,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="sr-only"
            onChange={onPickerChange}
            aria-label="Choose file to upload"
          />
        </div>

        {/* Progress + state */}
        {phase === 'uploading' ? (
          <div className="space-y-1">
            <div className="flex items-center justify-between text-xs">
              <span className="text-gray-600">Uploading…</span>
              <span className="tabular-nums text-gray-600">{progress}%</span>
            </div>
            <Progress value={progress} />
          </div>
        ) : null}

        {phase === 'inspecting' ? (
          <div className="rounded-md border border-blue-200 bg-blue-50 p-3 text-sm text-blue-700">
            Inspecting your file… reading headers and sampling rows.
          </div>
        ) : null}

        {error ? (
          <div role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            {error}
          </div>
        ) : null}

        <div className="flex items-center justify-end gap-2 pt-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={isBusy}
          >
            Cancel
          </Button>
          <Button type="button" onClick={() => void handleUpload()} disabled={!file || isBusy}>
            {phase === 'uploading' ? 'Uploading…' : phase === 'inspecting' ? 'Inspecting…' : 'Upload'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
