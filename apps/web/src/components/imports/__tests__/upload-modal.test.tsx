/**
 * KAN-901 — UploadModal smoke tests.
 *
 * Covers the 5 critical scenarios from the brief:
 *   1. renders mode selector + drag-drop zone
 *   2. file too large → client-side rejection (no API call)
 *   3. unsupported type → client-side rejection (no API call)
 *   4. happy path: createUploadUrl + PUT + confirmUpload → router.push
 *   5. confirmUpload returns status='failed' → surfaces errorMessage
 *
 * XMLHttpRequest is stubbed globally with a minimal class that
 * synthesizes upload.onprogress events + a 200 onload.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { UploadModal } from "../upload-modal";

const createUploadUrlMock = vi.fn();
const confirmUploadMock = vi.fn();
const routerPushMock = vi.fn();

vi.mock("@/lib/api", () => ({
  importJobsApi: {
    createUploadUrl: (...args: unknown[]) => createUploadUrlMock(...args),
    confirmUpload: (...args: unknown[]) => confirmUploadMock(...args),
  },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPushMock }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() },
}));

// Minimal XHR stub — synthesize a 200 PUT with a single onload event.
class FakeXHR {
  upload = { onprogress: null as ((e: ProgressEvent) => void) | null };
  status = 200;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  open(_method: string, _url: string) {}
  setRequestHeader(_h: string, _v: string) {}
  send(_body: unknown) {
    // simulate one progress event + onload synchronously
    queueMicrotask(() => {
      this.upload.onprogress?.({
        lengthComputable: true,
        loaded: 100,
        total: 100,
      } as unknown as ProgressEvent);
      this.onload?.();
    });
  }
}

beforeEach(() => {
  createUploadUrlMock.mockReset();
  confirmUploadMock.mockReset();
  routerPushMock.mockReset();
  // @ts-expect-error - test seam
  global.XMLHttpRequest = FakeXHR;
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeFile(name: string, size: number, mime: string): File {
  const blob = new Blob([new Uint8Array(size)], { type: mime });
  return new File([blob], name, { type: mime });
}

describe("KAN-901 — UploadModal", () => {
  it("renders mode selector + drag-drop zone when open", () => {
    render(<UploadModal open={true} onOpenChange={vi.fn()} />);
    // Mode selector radios
    expect(screen.getByText(/Update \+ add/)).toBeInTheDocument();
    expect(screen.getByText(/Replace all/)).toBeInTheDocument();
    // Drag-drop zone copy
    expect(
      screen.getByText(/Drag a CSV or XLSX here, or click to browse/),
    ).toBeInTheDocument();
    // Upload button is disabled when no file selected
    expect(screen.getByRole("button", { name: /^Upload$/i })).toBeDisabled();
  });

  it("rejects files larger than 20MB without calling createUploadUrl", async () => {
    render(<UploadModal open={true} onOpenChange={vi.fn()} />);
    const input = screen.getByLabelText(
      /Choose file to upload/i,
    ) as HTMLInputElement;
    // 21MB CSV
    const tooBig = makeFile("big.csv", 21 * 1024 * 1024, "text/csv");
    await act(async () => {
      fireEvent.change(input, { target: { files: [tooBig] } });
    });
    expect(screen.getByRole("alert")).toHaveTextContent(/File too large/i);
    expect(createUploadUrlMock).not.toHaveBeenCalled();
  });

  it("rejects unsupported file types without calling createUploadUrl", async () => {
    render(<UploadModal open={true} onOpenChange={vi.fn()} />);
    const input = screen.getByLabelText(
      /Choose file to upload/i,
    ) as HTMLInputElement;
    const pdfFile = makeFile("notes.pdf", 1024, "application/pdf");
    await act(async () => {
      fireEvent.change(input, { target: { files: [pdfFile] } });
    });
    expect(screen.getByRole("alert")).toHaveTextContent(/Unsupported file type/i);
    expect(createUploadUrlMock).not.toHaveBeenCalled();
  });

  it("happy path: createUploadUrl → PUT → confirmUpload → router.push", async () => {
    createUploadUrlMock.mockResolvedValue({
      importJobId: "j_123",
      signedUploadUrl: "https://storage.googleapis.com/STUB",
      gcsObjectPath: "tenants/T/imports/j_123/leads.csv",
      expiresAt: "2026-05-13T13:00:00Z",
    });
    confirmUploadMock.mockResolvedValue({
      id: "j_123",
      status: "inspected",
      fileName: "leads.csv",
      detectedRowCount: 2,
      detectedColumnCount: 2,
      detectedHeaders: ["email", "firstName"],
      sampleRows: [],
      errorMessage: null,
    });

    const onOpenChange = vi.fn();
    render(<UploadModal open={true} onOpenChange={onOpenChange} />);

    const input = screen.getByLabelText(
      /Choose file to upload/i,
    ) as HTMLInputElement;
    const file = makeFile("leads.csv", 256, "text/csv");
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
    });

    await act(async () => {
      screen.getByRole("button", { name: /^Upload$/i }).click();
    });

    await waitFor(() => {
      expect(createUploadUrlMock).toHaveBeenCalledWith({
        filename: "leads.csv",
        fileSize: 256,
        fileMimeType: "text/csv",
        mode: "update_add",
      });
    });
    await waitFor(() => {
      expect(confirmUploadMock).toHaveBeenCalledWith("j_123");
    });
    await waitFor(() => {
      expect(routerPushMock).toHaveBeenCalledWith("/imports/j_123");
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("confirmUpload returns status='failed' → renders ImportJob.errorMessage", async () => {
    createUploadUrlMock.mockResolvedValue({
      importJobId: "j_bad",
      signedUploadUrl: "https://storage.googleapis.com/STUB",
      gcsObjectPath: "tenants/T/imports/j_bad/bad.csv",
      expiresAt: "2026-05-13T13:00:00Z",
    });
    confirmUploadMock.mockResolvedValue({
      id: "j_bad",
      status: "failed",
      fileName: "bad.csv",
      errorMessage: "GCS object not found at expected path",
    });

    render(<UploadModal open={true} onOpenChange={vi.fn()} />);
    const input = screen.getByLabelText(
      /Choose file to upload/i,
    ) as HTMLInputElement;
    const file = makeFile("bad.csv", 256, "text/csv");
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
    });
    await act(async () => {
      screen.getByRole("button", { name: /^Upload$/i }).click();
    });

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        /GCS object not found at expected path/i,
      );
    });
    expect(routerPushMock).not.toHaveBeenCalled();
  });

  it("infers MIME from .xlsx extension when browser sends empty type", async () => {
    createUploadUrlMock.mockResolvedValue({
      importJobId: "j_xlsx",
      signedUploadUrl: "https://storage.googleapis.com/STUB",
      gcsObjectPath: "tenants/T/imports/j_xlsx/leads.xlsx",
      expiresAt: "2026-05-13T13:00:00Z",
    });
    confirmUploadMock.mockResolvedValue({
      id: "j_xlsx",
      status: "inspected",
      fileName: "leads.xlsx",
    });

    render(<UploadModal open={true} onOpenChange={vi.fn()} />);
    const input = screen.getByLabelText(
      /Choose file to upload/i,
    ) as HTMLInputElement;
    // Empty MIME — common for some browsers + .xlsx
    const file = makeFile("leads.xlsx", 1024, "");
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
    });
    await act(async () => {
      screen.getByRole("button", { name: /^Upload$/i }).click();
    });

    await waitFor(() => {
      expect(createUploadUrlMock).toHaveBeenCalledWith(
        expect.objectContaining({
          fileMimeType:
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        }),
      );
    });
  });
});
