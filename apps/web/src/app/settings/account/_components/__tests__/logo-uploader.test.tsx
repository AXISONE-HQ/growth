/**
 * KAN-855 — LogoUploader unit tests.
 *
 * Covers:
 *  - Client-side file validation (type whitelist, size cap, empty file)
 *  - Picker click → opens hidden input
 *  - Replace / Remove button visibility based on currentUrl prop
 *  - variantWarning surface — "Retry thumbnails" button appears
 *  - Successful upload → uploadLogo → PUT → finalizeLogo → onChange called
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/lib/firebase", () => ({
  app: {},
  auth: { currentUser: { getIdToken: vi.fn(async () => "test-id-token") } },
  googleProvider: {},
}));

const toastSuccessMock = vi.fn();
const toastErrorMock = vi.fn();
const toastMessageMock = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccessMock(...args),
    error: (...args: unknown[]) => toastErrorMock(...args),
    message: (...args: unknown[]) => toastMessageMock(...args),
  },
}));

import { LogoUploader } from "../logo-uploader";

function buildFile({
  name,
  type,
  bytes,
}: {
  name: string;
  type: string;
  bytes: number;
}): File {
  const blob = new Blob([new Uint8Array(bytes)], { type });
  return new File([blob], name, { type });
}

beforeEach(() => {
  toastSuccessMock.mockReset();
  toastErrorMock.mockReset();
  toastMessageMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("LogoUploader — KAN-855", () => {
  it("renders 'Upload logo' when no current URL", () => {
    render(<LogoUploader currentUrl={null} variants={null} onChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Upload logo" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove logo" })).not.toBeInTheDocument();
  });

  it("renders 'Replace logo' + 'Remove logo' when a URL is set", () => {
    render(
      <LogoUploader
        currentUrl="https://example.com/logo.png"
        variants={null}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Replace logo" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove logo" })).toBeInTheDocument();
  });

  it("rejects unsupported MIME types client-side (no API call)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const onChange = vi.fn();

    render(<LogoUploader currentUrl={null} variants={null} onChange={onChange} />);

    // fireEvent.change bypasses userEvent's accept-filter, lets us inject
    // a GIF into an input that only accepts image/png|jpeg|svg+xml|webp
    // and observe the component's runtime validation kick in.
    const file = buildFile({ name: "anim.gif", type: "image/gif", bytes: 100 });
    const hidden = screen.getByLabelText("Choose logo file") as HTMLInputElement;
    Object.defineProperty(hidden, "files", { value: [file], configurable: true });
    fireEvent.change(hidden);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/PNG, JPG, SVG, or WebP/);
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("rejects oversized files client-side (5 MB cap)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<LogoUploader currentUrl={null} variants={null} onChange={vi.fn()} />);

    const file = buildFile({
      name: "big.png",
      type: "image/png",
      bytes: 5 * 1024 * 1024 + 1,
    });
    const hidden = screen.getByLabelText("Choose logo file") as HTMLInputElement;
    // user-event v14: applyAccept exists at runtime but the type
    // definition lags; cast to bypass the stale declaration.
    await (user.upload as unknown as (
      el: HTMLInputElement,
      f: File,
      opts: { applyAccept: boolean },
    ) => Promise<void>)(hidden, file, { applyAccept: false });

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/under 5 MB/);
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects empty files", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<LogoUploader currentUrl={null} variants={null} onChange={vi.fn()} />);

    const file = buildFile({ name: "empty.png", type: "image/png", bytes: 0 });
    const hidden = screen.getByLabelText("Choose logo file") as HTMLInputElement;
    // user-event v14: applyAccept exists at runtime but the type
    // definition lags; cast to bypass the stale declaration.
    await (user.upload as unknown as (
      el: HTMLInputElement,
      f: File,
      opts: { applyAccept: boolean },
    ) => Promise<void>)(hidden, file, { applyAccept: false });

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/empty/i);
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("happy path — accepts PNG, calls uploadLogo → PUT → finalizeLogo → onChange", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();

    // Mock the API roundtrip: 1) tRPC uploadLogo, 2) GCS PUT, 3) tRPC finalizeLogo.
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/trpc/account.uploadLogo")) {
        return {
          ok: true,
          json: async () => ({
            result: {
              data: {
                uploadUrl: "https://signed.example/put",
                uploadId: "tenants/T/account/logo-123.png",
                contentType: "image/png",
              },
            },
          }),
        } as Response;
      }
      if (url === "https://signed.example/put") {
        // GCS PUT
        return { ok: true, status: 200 } as Response;
      }
      if (url.endsWith("/trpc/account.finalizeLogo")) {
        return {
          ok: true,
          json: async () => ({
            result: {
              data: {
                logoUrl: "https://signed.example/get-original",
                logoVariants: {
                  256: "https://signed.example/get-256",
                  128: "https://signed.example/get-128",
                  64: "https://signed.example/get-64",
                },
                variantWarning: null,
              },
            },
          }),
        } as Response;
      }
      void init;
      return { ok: false, status: 404 } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<LogoUploader currentUrl={null} variants={null} onChange={onChange} />);
    const file = buildFile({ name: "logo.png", type: "image/png", bytes: 1000 });
    const hidden = screen.getByLabelText("Choose logo file") as HTMLInputElement;
    // user-event v14: applyAccept exists at runtime but the type
    // definition lags; cast to bypass the stale declaration.
    await (user.upload as unknown as (
      el: HTMLInputElement,
      f: File,
      opts: { applyAccept: boolean },
    ) => Promise<void>)(hidden, file, { applyAccept: false });

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({
          logoUrl: "https://signed.example/get-original",
          logoVariants: expect.objectContaining({
            256: "https://signed.example/get-256",
          }),
        }),
      );
    });
    // Three fetches: uploadLogo, GCS PUT, finalizeLogo
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls).toEqual(
      expect.arrayContaining([
        expect.stringContaining("/trpc/account.uploadLogo"),
        "https://signed.example/put",
        expect.stringContaining("/trpc/account.finalizeLogo"),
      ]),
    );
    expect(toastSuccessMock).toHaveBeenCalledWith("Logo uploaded.");
  });

  it("variantWarning prop renders 'Retry thumbnails' button", () => {
    render(
      <LogoUploader
        currentUrl="https://example.com/logo.png"
        variants={null}
        variantWarning="Sharp variant generation exceeded 10s timeout"
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Retry thumbnails" })).toBeInTheDocument();
    expect(
      screen.getByText(/Logo uploaded, but thumbnails couldn't be generated/),
    ).toBeInTheDocument();
  });

  it("Remove logo button calls account.removeLogo and onChange", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/trpc/account.removeLogo")) {
        return {
          ok: true,
          json: async () => ({
            result: { data: { logoUrl: null, logoVariants: null } },
          }),
        } as Response;
      }
      return { ok: false } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <LogoUploader
        currentUrl="https://example.com/logo.png"
        variants={null}
        onChange={onChange}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Remove logo" }));

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith({ logoUrl: null, logoVariants: null });
    });
    expect(toastSuccessMock).toHaveBeenCalledWith("Logo removed.");
  });
});
