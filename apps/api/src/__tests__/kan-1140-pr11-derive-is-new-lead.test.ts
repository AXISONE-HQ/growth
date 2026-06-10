/**
 * KAN-1140 PR 11 — Reply vs new-lead derivation unit tests.
 *
 * Pure-function tests for `deriveIsNewLead`. Covers the Q-ADD-SEMANTIC
 * lock (5s tolerance) + Q-ADD-OOO lock (only `status === 'accepted'`
 * rows get a non-null verdict) + defensive null surface (missing
 * createdContactId or missing Contact row).
 *
 * No Prisma / no tRPC ceremony — the derivation is pure data, extracted
 * from the `inbox.listRecentEvents` procedure for testability.
 */
import { describe, expect, it } from "vitest";
import { deriveIsNewLead, ISNEWLEAD_TOLERANCE_MS_PR11 } from "../router.js";

const baseEvent = {
  status: "accepted",
  createdContactId: "contact-1",
  eventCreatedAt: new Date("2026-06-10T12:00:00.000Z"),
};

describe("KAN-1140 PR 11 — deriveIsNewLead", () => {
  it("returns true when Contact was created at the same moment as the event", () => {
    expect(
      deriveIsNewLead({
        ...baseEvent,
        contactCreatedAt: new Date("2026-06-10T12:00:00.000Z"),
      }),
    ).toBe(true);
  });

  it("returns true when Contact was created 1s before event (within 5s tolerance)", () => {
    expect(
      deriveIsNewLead({
        ...baseEvent,
        contactCreatedAt: new Date("2026-06-10T11:59:59.000Z"),
      }),
    ).toBe(true);
  });

  it("returns true at the exact 5s tolerance boundary (edge inclusive)", () => {
    // Event at T=0; Contact at T-5s. Contact.getTime() === event.getTime() - 5000.
    // Condition: contact.getTime() >= event.getTime() - TOLERANCE → 0 >= 0 → true.
    expect(
      deriveIsNewLead({
        ...baseEvent,
        contactCreatedAt: new Date("2026-06-10T11:59:55.000Z"),
      }),
    ).toBe(true);
  });

  it("returns false when Contact predates event by > 5s (reply)", () => {
    expect(
      deriveIsNewLead({
        ...baseEvent,
        contactCreatedAt: new Date("2026-06-10T11:59:00.000Z"),
      }),
    ).toBe(false);
  });

  it("returns false for week-old Contact (clear reply)", () => {
    expect(
      deriveIsNewLead({
        ...baseEvent,
        contactCreatedAt: new Date("2026-06-03T00:00:00.000Z"),
      }),
    ).toBe(false);
  });

  it("returns null for non-accepted status — rejected_spam", () => {
    expect(
      deriveIsNewLead({
        ...baseEvent,
        status: "rejected_spam",
        contactCreatedAt: new Date("2026-06-10T12:00:00.000Z"),
      }),
    ).toBeNull();
  });

  it("returns null for non-accepted status — rejected_autoresponder (Q-ADD-OOO lock)", () => {
    expect(
      deriveIsNewLead({
        ...baseEvent,
        status: "rejected_autoresponder",
        contactCreatedAt: new Date("2026-06-10T12:00:00.000Z"),
      }),
    ).toBeNull();
  });

  it("returns null for non-accepted status — rejected_unverified", () => {
    expect(
      deriveIsNewLead({
        ...baseEvent,
        status: "rejected_unverified",
        contactCreatedAt: new Date("2026-06-10T12:00:00.000Z"),
      }),
    ).toBeNull();
  });

  it("returns null when createdContactId is missing (defensive surface)", () => {
    expect(
      deriveIsNewLead({
        ...baseEvent,
        createdContactId: null,
        contactCreatedAt: new Date("2026-06-10T12:00:00.000Z"),
      }),
    ).toBeNull();
  });

  it("returns null when Contact row lookup missed (data-loss race; defensive)", () => {
    expect(
      deriveIsNewLead({
        ...baseEvent,
        contactCreatedAt: null,
      }),
    ).toBeNull();
  });

  it("exports the tolerance constant for cross-test reference", () => {
    expect(ISNEWLEAD_TOLERANCE_MS_PR11).toBe(5_000);
  });

  it("Contact created EXACTLY 5001ms before event → false (just past tolerance)", () => {
    // Tolerance is inclusive at 5000ms; one ms past is reply territory.
    expect(
      deriveIsNewLead({
        ...baseEvent,
        contactCreatedAt: new Date("2026-06-10T11:59:54.999Z"),
      }),
    ).toBe(false);
  });
});
