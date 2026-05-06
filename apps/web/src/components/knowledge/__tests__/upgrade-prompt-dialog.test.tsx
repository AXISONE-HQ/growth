/**
 * KAN-829 sub-cohort 6 — UpgradePromptDialog tests.
 *
 * 9 tests covering: count-at-limit copy on Pro (recommends Enterprise),
 * count-at-limit Enterprise ceiling (custom-limit branch, no comparison),
 * feature-locked PDF on Free (recommends Pro), feature-locked FAQ on Starter
 * (recommends Pro), mailto href shape (subject + body decoded), "Your plan"
 * + "Recommended" pills, recommended-tier highlight token, comparison row
 * count per tier, combined microcopy forbidden-word audit (sub-cohort-6 +
 * carry-over), UPGRADE_INTENT_EMAIL is the actual recipient (no inline
 * hardcoded address).
 */
import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { UpgradePromptDialog, buildMailto } from "../upgrade-prompt-dialog";
import { UPGRADE_INTENT_EMAIL } from "@/lib/tier-labels";

describe("UpgradePromptDialog — KAN-829 sub-cohort 6", () => {
  it("Test 1 — count-at-limit on Pro renders Pro→Enterprise heading + body + 2-row comparison", () => {
    render(
      <UpgradePromptDialog
        open
        onOpenChange={() => {}}
        reason="count-at-limit"
        currentTier="pro"
      />,
    );
    expect(
      screen.getByText("You've used all your knowledge sources."),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Pro includes up to 5 sources/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Enterprise raises the cap to 9,999/i),
    ).toBeInTheDocument();
    // Comparison table — pro: 2 rows
    const table = screen.getByLabelText("Plan comparison");
    const rows = within(table).getAllByRole("row");
    // 1 header row + 2 data rows = 3
    expect(rows).toHaveLength(3);
  });

  it("Test 2 — count-at-limit on Enterprise renders custom-limit branch (no comparison table)", () => {
    render(
      <UpgradePromptDialog
        open
        onOpenChange={() => {}}
        reason="count-at-limit"
        currentTier="enterprise"
      />,
    );
    // Body copy unique to enterprise ceiling branch
    expect(
      screen.getByText(/Enterprise includes 9,999 sources, the current ceiling/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByLabelText("Plan comparison"),
    ).not.toBeInTheDocument();
    // Footer CTA labeled differently for enterprise
    expect(
      screen.getByRole("link", { name: /Talk to us about a custom limit/i }),
    ).toBeInTheDocument();
  });

  it("Test 3 — feature-locked PDF on Free renders 'PDF uploads is on a higher plan' + Pro recommendation", () => {
    render(
      <UpgradePromptDialog
        open
        onOpenChange={() => {}}
        reason="feature-locked"
        currentTier="free"
        feature="pdf"
      />,
    );
    expect(
      screen.getByText("PDF uploads is on a higher plan."),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/PDF uploads is available on Pro and above/i),
    ).toBeInTheDocument();
    // Free row + Pro (recommended) + Enterprise — 3 rows + header = 4
    const table = screen.getByLabelText("Plan comparison");
    expect(within(table).getAllByRole("row")).toHaveLength(4);
    // Pro row carries data-recommended="true"
    const proRow = table.querySelector('tr[data-tier="pro"]');
    expect(proRow?.getAttribute("data-recommended")).toBe("true");
  });

  it("Test 4 — feature-locked FAQ on Starter recommends Pro (synonym-skip not visible — Starter is current)", () => {
    render(
      <UpgradePromptDialog
        open
        onOpenChange={() => {}}
        reason="feature-locked"
        currentTier="starter"
        feature="faq"
      />,
    );
    expect(
      screen.getByText("FAQ entries is on a higher plan."),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/FAQ entries is available on Pro and above/i),
    ).toBeInTheDocument();
    // Starter row present, NO Free row (synonym skip)
    const table = screen.getByLabelText("Plan comparison");
    expect(table.querySelector('tr[data-tier="starter"]')).not.toBeNull();
    expect(table.querySelector('tr[data-tier="free"]')).toBeNull();
  });

  it("Test 5 — mailto href has correct subject + body (decoded structure)", () => {
    render(
      <UpgradePromptDialog
        open
        onOpenChange={() => {}}
        reason="feature-locked"
        currentTier="free"
        feature="pdf"
      />,
    );
    const link = screen.getByRole("link", { name: /Talk to us about upgrading/i });
    const href = link.getAttribute("href")!;
    expect(href.startsWith(`mailto:${UPGRADE_INTENT_EMAIL}?`)).toBe(true);
    const url = new URL(href);
    expect(url.searchParams.get("subject")).toBe("Upgrade request — Free → Pro");
    const body = url.searchParams.get("body")!;
    expect(body).toContain("upgrade my AxisOne plan from Free to Pro");
    expect(body).toContain("Reason: unlock PDF uploads.");
    expect(body).toContain("Tenant ID:");
  });

  it("Test 6 — \"Your plan\" pill renders next to current tier; \"Recommended\" pill on next tier", () => {
    render(
      <UpgradePromptDialog
        open
        onOpenChange={() => {}}
        reason="count-at-limit"
        currentTier="free"
      />,
    );
    const table = screen.getByLabelText("Plan comparison");
    const freeRow = table.querySelector('tr[data-tier="free"]')!;
    const proRow = table.querySelector('tr[data-tier="pro"]')!;
    expect(within(freeRow as HTMLElement).getByText("Your plan")).toBeInTheDocument();
    expect(within(proRow as HTMLElement).getByText("Recommended")).toBeInTheDocument();
  });

  it("Test 7 — recommended-tier row carries DS violet token treatment (inline style)", () => {
    render(
      <UpgradePromptDialog
        open
        onOpenChange={() => {}}
        reason="count-at-limit"
        currentTier="free"
      />,
    );
    const table = screen.getByLabelText("Plan comparison");
    const proRow = table.querySelector('tr[data-tier="pro"]')! as HTMLElement;
    // Inline style applies --ds-violet-100 background on recommended rows
    expect(proRow.style.backgroundColor).toContain("--ds-violet-100");
  });

  it("Test 8 — buildMailto produces stable subject + body shapes for all four reasons (template pin)", () => {
    // free + count-at-limit
    const m1 = buildMailto({
      reason: "count-at-limit",
      currentTier: "free",
      recommended: "pro",
      feature: undefined,
      isEnterpriseCeiling: false,
    });
    expect(m1.subject).toBe("Upgrade request — Free → Pro");
    expect(m1.body).toMatch(/Reason: count at limit\./);

    // free + feature-locked PDF
    const m2 = buildMailto({
      reason: "feature-locked",
      currentTier: "free",
      recommended: "pro",
      feature: "pdf",
      isEnterpriseCeiling: false,
    });
    expect(m2.subject).toBe("Upgrade request — Free → Pro");
    expect(m2.body).toMatch(/Reason: unlock PDF uploads\./);

    // starter + feature-locked FAQ
    const m3 = buildMailto({
      reason: "feature-locked",
      currentTier: "starter",
      recommended: "pro",
      feature: "faq",
      isEnterpriseCeiling: false,
    });
    expect(m3.subject).toBe("Upgrade request — Starter → Pro");
    expect(m3.body).toMatch(/Reason: unlock FAQ entries\./);

    // enterprise ceiling
    const m4 = buildMailto({
      reason: "count-at-limit",
      currentTier: "enterprise",
      recommended: null,
      feature: undefined,
      isEnterpriseCeiling: true,
    });
    expect(m4.subject).toBe("Custom limit request — Enterprise");
    expect(m4.body).toMatch(/discuss a custom source limit/);
  });

  it("Test 9 — combined microcopy audit across every reason × tier render (sub-cohort-6 + carry-over)", () => {
    const matrix: Array<{
      reason: "count-at-limit" | "feature-locked";
      currentTier: "free" | "starter" | "pro" | "enterprise";
      feature?: "pdf" | "faq";
    }> = [
      { reason: "count-at-limit", currentTier: "free" },
      { reason: "count-at-limit", currentTier: "starter" },
      { reason: "count-at-limit", currentTier: "pro" },
      { reason: "count-at-limit", currentTier: "enterprise" },
      { reason: "feature-locked", currentTier: "free", feature: "pdf" },
      { reason: "feature-locked", currentTier: "free", feature: "faq" },
      { reason: "feature-locked", currentTier: "starter", feature: "pdf" },
      { reason: "feature-locked", currentTier: "starter", feature: "faq" },
    ];

    const FORBIDDEN_SUB6 = [
      "unleash",
      "supercharge",
      "unlock the power",
      "take it to the next level",
      "limited time",
      "only X left",
      "hurry",
      "don't miss out",
      "exclusive",
      "premium experience",
    ];
    const FORBIDDEN_CARRYOVER = [
      "magic",
      "simply",
      "easily",
      "seamlessly",
      "revolutionary",
      "cutting-edge",
      "leverage",
      "synergy",
      "unfortunately",
      "please",
      "sorry",
    ];

    for (const args of matrix) {
      const { unmount } = render(
        <UpgradePromptDialog
          open
          onOpenChange={() => {}}
          reason={args.reason}
          currentTier={args.currentTier}
          feature={args.feature}
        />,
      );
      const allText = (document.body.textContent ?? "").toLowerCase();

      for (const phrase of [...FORBIDDEN_SUB6, ...FORBIDDEN_CARRYOVER]) {
        const re = new RegExp(`\\b${phrase.replace(/[-]/g, "[-]").replace(/ /g, "\\s+")}\\b`);
        expect(
          re.test(allText),
          `Forbidden phrase "${phrase}" found in render of ${JSON.stringify(args)}`,
        ).toBe(false);
      }
      // "just" exception: only "just now" allowed (not present in this dialog,
      // but verify any "just" tokens are part of "just now")
      const stripped = allText.replace(/\bjust\s+now\b/g, "");
      expect(/\bjust\b/.test(stripped)).toBe(false);

      unmount();
    }
  });
});
