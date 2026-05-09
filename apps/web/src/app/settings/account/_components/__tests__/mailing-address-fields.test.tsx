/**
 * KAN-857 — MailingAddressFields toggle behavior (Decision 8).
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/lib/firebase", () => ({
  app: {},
  auth: { currentUser: { getIdToken: vi.fn(async () => "test-id-token") } },
  googleProvider: {},
}));

import { MailingAddressFields } from "../mailing-address-fields";

describe("MailingAddressFields — Decision 8", () => {
  it("Switch on (sameAsPhysical=true) hides mailing fields", () => {
    render(
      <MailingAddressFields
        sameAsPhysical={true}
        mailingAddress=""
        onSameAsPhysicalChange={vi.fn()}
        onMailingAddressChange={vi.fn()}
      />,
    );
    expect(screen.queryByLabelText("Mailing address")).not.toBeInTheDocument();
  });

  it("Switch off → mailing fields appear empty", () => {
    render(
      <MailingAddressFields
        sameAsPhysical={false}
        mailingAddress=""
        onSameAsPhysicalChange={vi.fn()}
        onMailingAddressChange={vi.fn()}
      />,
    );
    const mailing = screen.getByLabelText("Mailing address") as HTMLTextAreaElement;
    expect(mailing).toBeInTheDocument();
    expect(mailing.value).toBe("");
  });

  it("toggling fires onSameAsPhysicalChange", async () => {
    const onSameAsPhysicalChange = vi.fn();
    const user = userEvent.setup();
    render(
      <MailingAddressFields
        sameAsPhysical={true}
        mailingAddress=""
        onSameAsPhysicalChange={onSameAsPhysicalChange}
        onMailingAddressChange={vi.fn()}
      />,
    );
    await user.click(
      screen.getByRole("switch", { name: "Mailing address is the same as physical" }),
    );
    expect(onSameAsPhysicalChange).toHaveBeenCalledWith(false);
  });
});
