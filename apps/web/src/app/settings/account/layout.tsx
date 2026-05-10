/**
 * KAN-855 — Account Page Cohort 2 layout. Wraps every nested
 * /settings/account/* page with the Tab navigation bar. Composes
 * existing atoms (no new shared primitive) per Fred's decision A.
 *
 * KAN-866 — Cohort 6 mounts DriftBanner ABOVE AccountTabs (spec §7.1).
 * The banner self-no-ops when there are no proposed detections, so the
 * layout stays visually clean for tenants with nothing pending.
 */
"use client";
import * as React from "react";
import { AccountTabs } from "./_components/account-tabs";
import { DriftBanner } from "./_components/drift-banner";

export default function AccountSettingsLayout({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="px-8 py-6 max-w-4xl mx-auto">
      <header className="mb-4">
        <h1
          className="text-2xl font-semibold"
          style={{ color: "var(--ds-ink-primary)" }}
        >
          Account
        </h1>
        <p
          className="text-sm mt-1"
          style={{ color: "var(--ds-ink-secondary)" }}
        >
          How growth refers to your business in messages and decisions.
        </p>
      </header>
      <DriftBanner />
      <AccountTabs />
      {children}
    </div>
  );
}
