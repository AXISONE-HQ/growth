'use client';

import './globals.css';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  LayoutDashboard,
  Activity,
  MessageSquare,
  AlertTriangle,
  Users,
  FileText,
  BookOpen,
  Building2,
  Settings,
  Target,
  Receipt,
  Upload,
  Workflow,
} from 'lucide-react';
import { AuthProvider, useAuth } from '@/lib/AuthContext';
import { QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { queryClient } from '@/lib/query-client';
import { isDemoMode } from '@/lib/demo-mode';
import { DemoModeBanner } from '@/components/demo-mode-banner';
// KAN-978 Phase B.3 — IconRail rewrite (240px dark → 72px white icon-only)
// + brand mark and account dropdown migrated to TopNav. The old sidebar
// component is gone; its responsibilities split between IconRail (nav)
// + TopNav (brand + account). useState/useRef/useEffect + LogOut/Shield/
// ChevronDown imports retired (now internals of AccountMenu).
import { TopNav } from '@/components/ui/top-nav';
import { IconRail, type IconRailItem } from '@/components/ui/icon-rail';

// KAN-992 Phase D.2 — IA reorg: rail trimmed to target-8 + Settings
// pinned-bottom. Movers (Objectives / Imports / Audit Log / Knowledge
// Center / Account) carry `hideFromRail: true` and stay in the array
// so findActiveHref + the pageTitle longest-prefix resolver still
// behave correctly when the user navigates to their routes directly
// (or via D.3's Settings sub-tabs). Order matches the founder's locked
// target rail (top section), with Messages dropping its demoOnly flag
// to render in prod (clicks → existing "Messages — coming soon" page
// from KAN-991 D.1).
//
// History context:
// KAN-718 nav surgery: /pipelines mock → redirect to /settings/pipelines;
//   /pipelines/create → /settings/pipelines/new; /audit-log dupe → deleted;
//   /competitors broken → deleted; /conversations demoOnly flag.
// KAN-878 — activePrefix lets an item's rail-highlight scope differ from
//   its href (e.g., Account active on every /settings/account/* sub-tab).
//   Longest-prefix-wins via findActiveHref. Even hideFromRail items still
//   participate in the resolver so direct nav to a hidden route gets the
//   right active state (rail just renders no highlight for hidden items).
// Exported for KAN-992 D.2 rail-order regression test (apps/web/src/app/
// __tests__/nav-items.test.ts). Pin the target-8 order + hideFromRail
// invariant so a future edit can't silently churn the rail.
export const navItems: Array<{
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  badge?: number;
  demoOnly?: boolean;
  activePrefix?: string;
  /** KAN-978 — pin to the bottom of the IconRail (Settings pattern). */
  pinBottom?: boolean;
  /** KAN-992 Phase D.2 — exclude from rail render. Item still participates
   *  in findActiveHref + pageTitle resolution, so direct nav to the route
   *  (or D.3's Settings sub-tab) still resolves correctly. */
  hideFromRail?: boolean;
}> = [
  // Target-8 rail (ordered, founder-locked):
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/pipelines', label: 'Pipelines', icon: Workflow },
  // KAN-991 Phase D.1 — display label renamed Opportunities → Leads. Route
  // stays /opportunities, entity stays Deal, route literal stays.
  { href: '/opportunities', label: 'Leads', icon: Target },
  // KAN-991 Phase D.1 — display label renamed Customers → Contacts. Route
  // stays /customers, entity stays Contact, route literal stays (31 refs).
  { href: '/customers', label: 'Contacts', icon: Users },
  // KAN-884 — /companies sits in the org → person → transaction flow.
  // activePrefix keeps /companies/abc highlighted on the parent entry.
  { href: '/companies', label: 'Companies', icon: Building2, activePrefix: '/companies' },
  { href: '/orders', label: 'Orders', icon: Receipt, activePrefix: '/orders' },
  { href: '/escalations', label: 'Escalations', icon: AlertTriangle },
  // KAN-991 + KAN-992 — display label renamed Conversations → Messages
  // (D.1); demoOnly flag DROPPED (D.2) so Messages renders in prod.
  // Clicking → /conversations → existing "Messages — coming soon" page.
  { href: '/conversations', label: 'Messages', icon: MessageSquare },

  // Bottom-pinned:
  // KAN-978 — Settings pinned to IconRail bottom per the prototype's
  // .spacer + bottom-pinned `.rbtn` pattern.
  { href: '/settings', label: 'Settings', icon: Settings, pinBottom: true },

  // KAN-992 Phase D.2 — movers (off the rail, still active in resolver).
  // D.3 (KAN-993) wires these as Settings sub-tabs via router-push.
  { href: '/settings/objectives', label: 'Objectives', icon: Target, hideFromRail: true },
  { href: '/imports', label: 'Imports', icon: Upload, activePrefix: '/imports', hideFromRail: true },
  { href: '/audit', label: 'Audit Log', icon: FileText, hideFromRail: true },
  { href: '/settings/knowledge', label: 'Knowledge Center', icon: BookOpen, hideFromRail: true },
  {
    href: '/settings/account/identity',
    label: 'Account',
    icon: Building2,
    activePrefix: '/settings/account',
    hideFromRail: true,
  },
];

// Pick the single nav item to highlight for the current pathname.
// Longest matching prefix wins, so `/settings/account/contact` activates
// "Account" rather than the broader "Settings" entry.
function findActiveHref(pathname: string): string | null {
  let bestHref: string | null = null;
  let bestLen = -1;
  for (const item of navItems) {
    const prefix = item.activePrefix ?? item.href;
    if (pathname === prefix || pathname.startsWith(prefix + '/')) {
      if (prefix.length > bestLen) {
        bestHref = item.href;
        bestLen = prefix.length;
      }
    }
  }
  return bestHref;
}

// Cohort 3.5 — longest-prefix match (mirrors findActiveHref above) so
// detail / new / edit routes like /companies/[id]/edit resolve to
// "Companies" instead of falling through to "Dashboard". Longest match
// wins so `/settings/account/identity` beats `/settings`. Keys MUST be
// sorted longest-first for the rule to read declaratively at a glance,
// but resolveTitle scans all entries so ordering is documentation-only.
// `/knowledge` legacy entry kept — Fred deferred deletion (sales objections
// data still consumes the route).
const pageTitle: Record<string, string> = {
  '/settings/account/identity': 'Account',
  // KAN-992 Phase D.2 — '/settings/account' prefix added so the 5 Account
  // sub-tab routes (contact/hours/identity/legal/payments) all resolve to
  // "Account" via longest-prefix-wins. Mirrors navItems' activePrefix:
  // '/settings/account' for the Account rail entry (hideFromRail in D.2).
  '/settings/account': 'Account',
  '/settings/knowledge': 'Knowledge Center',
  // KAN-968 — Objectives + Pipelines page titles for the top-bar h1 resolver.
  '/settings/objectives': 'Objectives',
  '/pipelines': 'Pipelines',
  '/dashboard': 'Dashboard',
  '/opportunities': 'Leads',
  '/conversations': 'Messages',
  '/escalations': 'Escalations',
  '/companies': 'Companies',
  '/customers': 'Contacts',
  '/orders': 'Orders',
  '/imports': 'Data Imports',
  '/audit': 'Audit Log',
  '/knowledge': 'Knowledge Center',
  '/settings': 'Settings',
};

export function resolveTitle(pathname: string): string {
  let bestTitle = 'Dashboard';
  let bestLen = -1;
  for (const [prefix, title] of Object.entries(pageTitle)) {
    if (pathname === prefix || pathname.startsWith(prefix + '/')) {
      if (prefix.length > bestLen) {
        bestTitle = title;
        bestLen = prefix.length;
      }
    }
  }
  return bestTitle;
}

function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { user, loading, logout } = useAuth();
  const currentTitle = resolveTitle(pathname);
  const isLoginPage = pathname === '/login';

  // Allow login page without auth
  if (pathname === '/login') {
    return <>{children}</>;
  }

  const handleLogout = async () => {
    await logout();
    router.push('/login');
  };

  // Loading spinner
  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-background">
        <div className="animate-spin">
          <Activity className="w-8 h-8 text-primary" />
        </div>
      </div>
    );
  }

  // Login page — no sidebar, no top bar
  if (isLoginPage) {
    return <>{children}</>;
  }

  // Redirect to login if not authenticated
  if (!user) {
    router.push('/login');
    return null;
  }

  // KAN-978 Phase B.3 — visible items for the IconRail. Demo-only items
  // hide when DEMO_MODE is off; adminOnly items hide from non-admins.
  // KAN-992 Phase D.2 — `hideFromRail` filters movers (Objectives /
  // Imports / Audit / Knowledge / Account) that still live in navItems
  // so findActiveHref + pageTitle keep resolving them on direct nav.
  const activeHref = findActiveHref(pathname);
  const visibleNavItems: IconRailItem[] = navItems
    .filter((item) => !item.hideFromRail)
    .filter((item) => !(item.demoOnly && !isDemoMode()))
    .filter((item) => !('adminOnly' in item && item.adminOnly && user.role !== 'admin'))
    .map(({ href, label, icon, badge, pinBottom }) => ({
      href,
      label,
      icon,
      badge,
      pinBottom,
    }));

  // KAN-978 — new shell shape per prototype: TopNav full-width on top
  // (sticky), then a flex row below with IconRail (sticky top-16) on the
  // left and main content filling the rest. The prior `fixed`-position
  // sidebar with `ml-60` main-margin is gone — IconRail is a flow element
  // inside the flex row.
  return (
    <div className="min-h-screen bg-background">
      <TopNav title={currentTitle} user={user} onSignOut={handleLogout} />
      <div className="flex">
        <IconRail items={visibleNavItems} activeHref={activeHref} />
        <main className="min-w-0 flex-1">
          {/* KAN-718: top-of-page demo-mode disclaimer when NEXT_PUBLIC_DEMO_MODE is on */}
          <DemoModeBanner />
          {children}
        </main>
      </div>
    </div>
  );
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {/* KAN-829 sub-cohort 2 — TanStack Query provider above AuthProvider so
         * authenticated queries can use it. layout.tsx is already 'use client'
         * (line 1) so the provider can wrap directly without a separate
         * Client Component. */}
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <AppShell>{children}</AppShell>
          </AuthProvider>
          {/* KAN-829 sub-cohort 5 — sonner Toaster for mutation success
           * notifications. richColors=false keeps the surface monochrome so
           * DS v1 tokens own the visual treatment; position bottom-right
           * stays out of the way of dialogs that may be open. */}
          <Toaster richColors={false} position="bottom-right" />
        </QueryClientProvider>
      </body>
    </html>
  );
}
