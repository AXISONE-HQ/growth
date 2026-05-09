/**
 * KAN-859 — IndustryDisclosureList unit tests. Mirrors the
 * SocialProfileList / HolidayList pattern.
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

import {
  IndustryDisclosureList,
  type DisclosureRow,
} from "../industry-disclosure-list";

const DISCLOSURES: DisclosureRow[] = [
  {
    id: "d1",
    label: "FINRA disclosure",
    body: "Required regulatory text customers see in every email.",
    appliesToChannels: ["email"],
    position: 0,
  },
  {
    id: "d2",
    label: "Insurance fine print",
    body: "Coverage details required by state insurance regulators.",
    appliesToChannels: ["email", "sms"],
    position: 1,
  },
];

beforeEach(() => {
  toastSuccessMock.mockReset();
  toastErrorMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("IndustryDisclosureList — KAN-859", () => {
  it("empty state renders spec §8 verbatim copy", () => {
    render(<IndustryDisclosureList disclosures={[]} onChange={vi.fn()} />);
    expect(
      screen.getByText("No disclosures added. Required for regulated industries."),
    ).toBeInTheDocument();
  });

  it("renders one row per disclosure with label + body preview + channel badges", () => {
    render(
      <IndustryDisclosureList disclosures={DISCLOSURES} onChange={vi.fn()} />,
    );
    const list = screen.getByRole("list", { name: "Industry disclosures" });
    const items = list.querySelectorAll("li");
    expect(items.length).toBe(2);
    expect(list).toContainElement(screen.getByText("FINRA disclosure"));
    expect(list).toContainElement(screen.getByText("Insurance fine print"));
    // Scope channel-badge counts to the list — the add-row's channel
    // checkboxes also have "Email"/"SMS"/"WhatsApp" labels, so an
    // unscoped getAllByText would over-count.
    const emailInList = Array.from(list.querySelectorAll("span")).filter(
      (s) => s.textContent === "Email",
    );
    const smsInList = Array.from(list.querySelectorAll("span")).filter(
      (s) => s.textContent === "SMS",
    );
    expect(emailInList.length).toBe(2); // d1 + d2 both have email
    expect(smsInList.length).toBe(1); // d2 only
  });

  it("rejects add when label or body is empty (button disabled, no API call)", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<IndustryDisclosureList disclosures={[]} onChange={vi.fn()} />);
    const addBtn = screen.getByRole("button", { name: "Add disclosure" });
    expect(addBtn).toBeDisabled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("Add CTA calls account.addDisclosure with label+body+channels and clears form", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ result: { data: { id: "new" } } }),
    }) as Response);
    vi.stubGlobal("fetch", fetchMock);

    render(<IndustryDisclosureList disclosures={[]} onChange={onChange} />);
    const labelInput = screen.getByLabelText("Disclosure label") as HTMLInputElement;
    const bodyInput = screen.getByLabelText("Body") as HTMLTextAreaElement;
    await user.type(labelInput, "GDPR notice");
    await user.type(bodyInput, "Body of the GDPR disclosure.");
    await user.click(document.getElementById("disclosure-channel-email")!);
    await user.click(screen.getByRole("button", { name: "Add disclosure" }));

    await waitFor(() => {
      expect(onChange).toHaveBeenCalled();
    });
    expect(toastSuccessMock).toHaveBeenCalledWith("Disclosure added.");
    expect(labelInput.value).toBe("");
    expect(bodyInput.value).toBe("");
    const fetchCalls = fetchMock.mock.calls as unknown as Array<
      [unknown, RequestInit | undefined]
    >;
    const callBody = JSON.parse(fetchCalls[0][1]?.body as string);
    expect(callBody).toMatchObject({
      label: "GDPR notice",
      body: "Body of the GDPR disclosure.",
      appliesToChannels: ["email"],
    });
  });

  it("toggling channel checkboxes builds the appliesToChannels array", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ result: { data: { id: "new" } } }),
    }) as Response);
    vi.stubGlobal("fetch", fetchMock);

    render(<IndustryDisclosureList disclosures={[]} onChange={vi.fn()} />);
    await user.type(screen.getByLabelText("Disclosure label"), "Test");
    await user.type(screen.getByLabelText("Body"), "Body");
    await user.click(document.getElementById("disclosure-channel-email")!);
    await user.click(document.getElementById("disclosure-channel-whatsapp")!);
    await user.click(screen.getByRole("button", { name: "Add disclosure" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const fetchCalls = fetchMock.mock.calls as unknown as Array<
      [unknown, RequestInit | undefined]
    >;
    const callBody = JSON.parse(fetchCalls[0][1]?.body as string);
    expect(callBody.appliesToChannels).toEqual(["email", "whatsapp"]);
  });

  it("Remove icon calls account.removeDisclosure with the row id", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ result: { data: { ok: true } } }),
    }) as Response);
    vi.stubGlobal("fetch", fetchMock);

    render(
      <IndustryDisclosureList disclosures={DISCLOSURES} onChange={onChange} />,
    );
    await user.click(
      screen.getByRole("button", { name: "Remove disclosure: FINRA disclosure" }),
    );
    await waitFor(() => {
      expect(onChange).toHaveBeenCalled();
    });
    const fetchCalls = fetchMock.mock.calls as unknown as Array<
      [unknown, RequestInit | undefined]
    >;
    const callBody = JSON.parse(fetchCalls[0][1]?.body as string);
    expect(callBody).toMatchObject({ id: "d1" });
    expect(toastSuccessMock).toHaveBeenCalledWith("Disclosure removed.");
  });
});
