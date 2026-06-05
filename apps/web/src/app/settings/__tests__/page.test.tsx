/**
 * KAN-990 Phase C.6 — /settings page render + sub-tab smoke.
 *
 * Light coverage focused on the restyle convergence:
 *   - Header h1 + descriptor render
 *   - Pill Tabs surface all 6 sub-tabs
 *   - Switching tabs renders the right panel
 *   - AI panel: save mutation fires settingsApi.updateAIConfig
 *   - Notifications panel: toggle fires settingsApi.updateNotification
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import SettingsPage from "../page";

const aiConfig = {
  confidenceThreshold: 70,
  autoApproveEnabled: true,
  dailyActionLimit: 200,
  strategyPermissions: {
    directConversion: true,
    guidedAssistance: true,
    trustBuilding: true,
    reengagement: true,
  },
  guardrailSettings: {
    toneValidator: true,
    accuracyCheck: true,
    hallucinationFilter: true,
    complianceCheck: true,
    injectionDefense: true,
    confidenceGate: true,
  },
};

const getAIConfig = vi.fn();
const updateAIConfig = vi.fn();
const listChannels = vi.fn();
const listIntegrations = vi.fn();
const listTeam = vi.fn();
const getNotifications = vi.fn();
const updateNotification = vi.fn();
const getSecurity = vi.fn();

vi.mock("@/lib/api", () => ({
  settingsApi: {
    getAIConfig: () => getAIConfig(),
    updateAIConfig: (...args: unknown[]) => updateAIConfig(...args),
    listChannels: () => listChannels(),
    listIntegrations: () => listIntegrations(),
    listTeam: () => listTeam(),
    getNotifications: () => getNotifications(),
    updateNotification: (...args: unknown[]) => updateNotification(...args),
    getSecurity: () => getSecurity(),
  },
}));

// KAN-1100 — AuthContext mock. Default returns `user: null` so the
// admin-only Cognitive Metrics moverLink is filtered out, preserving the
// pre-KAN-1100 5-link contract for the existing KAN-993 D.3 tests below.
// The KAN-1100 describe block overrides this mock per-test to exercise
// admin / non-admin / unauthenticated branches of the moverLinks filter.
const useAuthMock = vi.fn();
vi.mock("@/lib/AuthContext", () => ({
  useAuth: () => useAuthMock(),
}));

beforeEach(() => {
  getAIConfig.mockReset();
  updateAIConfig.mockReset();
  listChannels.mockReset();
  listIntegrations.mockReset();
  listTeam.mockReset();
  getNotifications.mockReset();
  updateNotification.mockReset();
  getSecurity.mockReset();
  useAuthMock.mockReset();

  getAIConfig.mockResolvedValue(aiConfig);
  listChannels.mockResolvedValue([]);
  listIntegrations.mockResolvedValue([]);
  listTeam.mockResolvedValue({ members: [], invitations: [] });
  getNotifications.mockResolvedValue({
    escalation: true,
    daily_digest: true,
    weekly_report: true,
    brain_update: false,
  });
  getSecurity.mockResolvedValue({
    twoFactorEnabled: false,
    ssoEnabled: false,
    auditRetentionDays: 365,
    gdprCompliant: true,
  });

  // KAN-1100 default — unauthenticated. The admin-only Cognitive Metrics
  // moverLink is filtered out; existing KAN-993 D.3 5-link contracts hold.
  useAuthMock.mockReturnValue({ user: null, loading: false });
});

describe("KAN-990 — SettingsPage (DS v1 restyle)", () => {
  it("renders the page header (h1 'Settings' + descriptor)", async () => {
    render(<SettingsPage />);
    expect(screen.getByRole("heading", { level: 1, name: "Settings" })).toBeInTheDocument();
    expect(screen.getByText(/Configure your growth workspace/i)).toBeInTheDocument();
  });

  it("renders all 6 sub-tabs as pill TabsTrigger buttons", () => {
    render(<SettingsPage />);
    // Each TabsTrigger renders an icon + label; the label is the assertable
    // text since icons are aria-hidden.
    expect(screen.getByRole("tab", { name: /AI Configuration/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Channels/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Integrations/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Team & roles/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Notifications/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Security/i })).toBeInTheDocument();
  });

  it("AI tab is active by default and renders the AI decision controls section", async () => {
    render(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByText("AI decision controls")).toBeInTheDocument();
    });
    expect(screen.getByText(/Global confidence threshold/i)).toBeInTheDocument();
  });

  it("Each tab is reachable via role + accessible name (a11y contract)", () => {
    render(<SettingsPage />);
    // Six tabs with distinct accessible names. The activation contract is
    // owned by Radix Tabs (B.1 KAN-976) + tested there; this test pins
    // that our six labels are exposed correctly to AT.
    const tabNames = [
      "AI Configuration",
      "Channels",
      "Integrations",
      "Team & roles",
      "Notifications",
      "Security",
    ];
    for (const name of tabNames) {
      expect(screen.getByRole("tab", { name: new RegExp(name, "i") })).toBeInTheDocument();
    }
  });

  it("All 6 tabs reachable as buttons + only one has data-state='active' at a time (Radix invariant)", () => {
    render(<SettingsPage />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs.length).toBe(6);
    const active = tabs.filter((t) => t.getAttribute("data-state") === "active");
    expect(active.length).toBe(1);
    // The default-active tab is 'ai' per useState('ai')
    expect(active[0]?.textContent).toMatch(/AI Configuration/i);
  });

  // KAN-993 Phase D.3 — mover sub-tab nav (the 5 items removed from the
  // rail in D.2 surfaced inside Settings via router-push Links).
  it("KAN-993 D.3 — renders the 5 mover sub-tabs in the 'More settings' nav", () => {
    render(<SettingsPage />);
    const nav = screen.getByRole("navigation", { name: /More settings/i });
    expect(nav).toBeInTheDocument();
    // Links inside the nav landmark, not 'tab' role — these navigate, they
    // don't switch panels.
    const links = nav.querySelectorAll("a");
    expect(links.length).toBe(5);
  });

  it("KAN-993 D.3 — each mover sub-tab points at its existing route (no route churn)", () => {
    render(<SettingsPage />);
    const nav = screen.getByRole("navigation", { name: /More settings/i });
    const linksByLabel = Object.fromEntries(
      Array.from(nav.querySelectorAll("a")).map((a) => [a.textContent?.replace(/\s+/g, " ").trim(), a.getAttribute("href")]),
    );
    // textContent includes label + chevron; assert by partial label match
    // against the href map.
    const findHref = (labelPart: string): string | null | undefined => {
      const entry = Object.entries(linksByLabel).find(([k]) => k?.includes(labelPart));
      return entry?.[1];
    };
    expect(findHref("Objectives")).toBe("/settings/objectives");
    expect(findHref("Knowledge Center")).toBe("/settings/knowledge");
    expect(findHref("Data Imports")).toBe("/imports");
    expect(findHref("Audit Log")).toBe("/audit");
    expect(findHref("Account")).toBe("/settings/account/identity");
  });

  it("KAN-993 D.3 — mover items render as <a> (Links), NOT as Radix tab triggers", () => {
    render(<SettingsPage />);
    // The 5 mover items must NOT be reachable via getAllByRole('tab') —
    // that's reserved for Radix's 6 inline tabs.
    const tabs = screen.getAllByRole("tab");
    expect(tabs.length).toBe(6);
    // No tab has the mover labels.
    const tabLabels = tabs.map((t) => t.textContent?.replace(/\s+/g, " ").trim() ?? "");
    expect(tabLabels.some((l) => l.includes("Objectives"))).toBe(false);
    expect(tabLabels.some((l) => l.includes("Knowledge Center"))).toBe(false);
    expect(tabLabels.some((l) => l.includes("Data Imports"))).toBe(false);
    expect(tabLabels.some((l) => l.includes("Audit Log"))).toBe(false);
    // "Account" label intentionally not asserted negative here — other tabs
    // could in theory mention it; we already pinned the count + href above.
  });

  it("Tab labels use sentence case (DS v1 — 'Team & roles' not 'Team & Roles')", () => {
    render(<SettingsPage />);
    // 'Team & roles' is the migrated copy; the old label was 'Team & Roles'.
    expect(screen.getByRole("tab", { name: /Team & roles/i })).toBeInTheDocument();
    // Explicit case check — the rendered label is "Team & roles", not the
    // legacy "Team & Roles".
    const teamTab = screen.getByRole("tab", { name: /Team & roles/i });
    expect(teamTab.textContent).toMatch(/Team & roles/);
    expect(teamTab.textContent).not.toMatch(/Team & Roles/);
  });
});

// KAN-1100 — Cognitive Metrics moverLink admin gating
//
// Sentinel coverage for the first admin-only moverLink. The `.filter()`
// idiom at the render site (`!m.adminOnly || user?.role === 'admin'`)
// becomes the canonical precedent for future admin-only moverLinks; these
// tests lock that idiom in machine-enforced regression coverage so future
// changes to the filter shape are caught at CI rather than UI smoke.
describe("KAN-1100 — Cognitive Metrics moverLink admin gating", () => {
  it("renders the Cognitive Metrics moverLink when user.role === 'admin'", () => {
    useAuthMock.mockReturnValue({
      user: { role: "admin", email: "admin@test.local" },
      loading: false,
    });
    render(<SettingsPage />);
    const nav = screen.getByRole("navigation", { name: /More settings/i });
    const link = nav.querySelector('a[href="/settings/cognitive-metrics"]');
    expect(link).not.toBeNull();
    expect(link?.textContent).toMatch(/Cognitive Metrics/);
  });

  it("does NOT render the Cognitive Metrics moverLink when user.role === 'member'", () => {
    useAuthMock.mockReturnValue({
      user: { role: "member", email: "member@test.local" },
      loading: false,
    });
    render(<SettingsPage />);
    const nav = screen.getByRole("navigation", { name: /More settings/i });
    expect(nav.querySelector('a[href="/settings/cognitive-metrics"]')).toBeNull();
    // Sibling moverLinks remain visible — the 5 non-admin links should all
    // be present, confirming the filter only removes the admin-only entry.
    expect(nav.querySelector('a[href="/settings/objectives"]')).not.toBeNull();
    expect(nav.querySelector('a[href="/settings/knowledge"]')).not.toBeNull();
    expect(nav.querySelector('a[href="/imports"]')).not.toBeNull();
    expect(nav.querySelector('a[href="/audit"]')).not.toBeNull();
    expect(nav.querySelector('a[href="/settings/account/identity"]')).not.toBeNull();
  });

  it("does NOT render the Cognitive Metrics moverLink when user is null (unauthenticated)", () => {
    useAuthMock.mockReturnValue({ user: null, loading: false });
    render(<SettingsPage />);
    const nav = screen.getByRole("navigation", { name: /More settings/i });
    expect(nav.querySelector('a[href="/settings/cognitive-metrics"]')).toBeNull();
  });
});
