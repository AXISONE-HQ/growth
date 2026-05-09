/**
 * KAN-855 — SocialProfileList unit tests.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/lib/firebase", () => ({
  app: {},
  auth: { currentUser: { getIdToken: vi.fn(async () => "test-id-token") } },
  googleProvider: {},
}));

const toastSuccessMock = vi.fn();
const toastErrorMock = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccessMock(...args),
    error: (...args: unknown[]) => toastErrorMock(...args),
    message: vi.fn(),
  },
}));

import { SocialProfileList, type SocialProfileRow } from "../social-profile-list";

const PROFILES: SocialProfileRow[] = [
  { id: "p1", platform: "linkedin", url: "https://linkedin.com/in/acme", handle: "@acme", position: 0 },
  { id: "p2", platform: "twitter", url: "https://x.com/acme", handle: null, position: 1 },
];

beforeEach(() => {
  toastSuccessMock.mockReset();
  toastErrorMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SocialProfileList — KAN-855", () => {
  it("Test 1 — empty state renders the §8 copy", () => {
    render(<SocialProfileList profiles={[]} onChange={vi.fn()} />);
    expect(
      screen.getByText(
        /No social profiles added\. AI cites these when contacts ask how to follow you\./,
      ),
    ).toBeInTheDocument();
  });

  it("Test 2 — renders one row per profile with platform badge + URL/handle", () => {
    render(<SocialProfileList profiles={PROFILES} onChange={vi.fn()} />);
    // Scope to the rendered list — "LinkedIn" also appears in the
    // platform <select> options below.
    const list = screen.getByRole("list", { name: "Social profiles" });
    expect(list).toContainElement(screen.getByText("@acme"));
    // Twitter/X has no handle → URL renders
    expect(list).toContainElement(screen.getByText("https://x.com/acme"));
    // Two list items, one per profile
    const items = list.querySelectorAll("li");
    expect(items.length).toBe(2);
  });

  it("Test 3 — rejects URLs that don't start with https:// (no API call)", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(<SocialProfileList profiles={[]} onChange={vi.fn()} />);
    const urlInput = screen.getByLabelText("URL") as HTMLInputElement;
    await user.type(urlInput, "http://insecure.com");
    await user.click(screen.getByRole("button", { name: "Add social profile" }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/https:\/\//);
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("Test 4 — Add CTA calls account.addSocialProfile + onChange + clears input", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ result: { data: { id: "new" } } }),
    }) as Response);
    vi.stubGlobal("fetch", fetchMock);

    render(<SocialProfileList profiles={[]} onChange={onChange} />);
    const urlInput = screen.getByLabelText("URL") as HTMLInputElement;
    await user.type(urlInput, "https://linkedin.com/in/acme");
    await user.click(screen.getByRole("button", { name: "Add social profile" }));

    await waitFor(() => {
      expect(onChange).toHaveBeenCalled();
    });
    expect(toastSuccessMock).toHaveBeenCalledWith("Social profile added.");
    expect(urlInput.value).toBe("");
    const fetchCalls = fetchMock.mock.calls as unknown as Array<[unknown, RequestInit | undefined]>;
    const callBody = JSON.parse(fetchCalls[0][1]?.body as string);
    expect(callBody).toMatchObject({ platform: "linkedin", url: "https://linkedin.com/in/acme" });
  });

  it("Test 5 — Remove icon button calls account.removeSocialProfile with the row id", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ result: { data: { ok: true } } }),
    }) as Response);
    vi.stubGlobal("fetch", fetchMock);

    render(<SocialProfileList profiles={PROFILES} onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: "Remove LinkedIn profile" }));

    await waitFor(() => {
      expect(onChange).toHaveBeenCalled();
    });
    const fetchCalls = fetchMock.mock.calls as unknown as Array<[unknown, RequestInit | undefined]>;
    const callBody = JSON.parse(fetchCalls[0][1]?.body as string);
    expect(callBody).toMatchObject({ id: "p1" });
    expect(toastSuccessMock).toHaveBeenCalledWith("Social profile removed.");
  });
});
