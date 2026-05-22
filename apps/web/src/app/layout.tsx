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

// KAN-718 nav surgery:
//   - /pipelines (mock) → redirect to /settings/pipelines (KAN-702 real)
//   - /pipelines/create (mock) → redirect to /settings/pipelines/new
//   - /audit-log (literal dupe of /audit) → deleted; /audit kept
//   - /competitors (broken imports, no API) → deleted
//   - /conversations (V1+ feature, no backend) → demoOnly flag; visible in
//     dev/staging for sales demos, hidden in prod
// KAN-878 — `activePrefix` lets an item's sidebar-highlight scope differ
// from its href. Account points at /settings/account/identity (the first
// tab) but should light up on every /settings/account/* sub-tab. Resolution
// is longest-prefix-wins via `findActiveHref` below, so the broader
// Settings item correctly yields to Account (and to Knowledge Center) when
// the path lives under their respective prefixes.
const navItems: Array<{
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  badge?: number;
  demoOnly?: boolean;
  activePrefix?: string;
  /** KAN-978 — pin to the bottom of the IconRail (Settings pattern). */
  pinBottom?: boolean;
}> = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  // KAN-968 — Pipelines (kanban board, read-only) + Objectives promoted to
  // top-level nav. Both sit near Opportunities since they're the "what is
  // growth pursuing right now?" surfaces. Objectives stays at its existing
  // /settings/objectives route (no URL move, matches the Knowledge Center
  // pattern of top-level link to a settings route).
  { href: '/pipelines', label: 'Pipelines', icon: Workflow },
  { href: '/settings/objectives', label: 'Objectives', icon: Target },
  { href: '/opportunities', label: 'Opportunities', icon: Target },
  { href: '/conversations', label: 'Conversations', icon: MessageSquare, demoOnly: true },
  // KAN-884 — CRM cohort 1 PR 2. /companies sits between Opportunities and
  // Customers (orgs → people they belong to); /orders sits after Customers
  // and before Escalations (transactional outcomes from those people).
  // activePrefix lets /companies/abc + /orders/xyz keep their parent entry
  // highlighted via the existing KAN-878 longest-prefix-wins resolver.
  { href: '/companies', label: 'Companies', icon: Building2, activePrefix: '/companies' },
  { href: '/customers', label: 'Customers', icon: Users },
  { href: '/orders', label: 'Orders', icon: Receipt, activePrefix: '/orders' },
  // KAN-901 — Ingestion Cohort 2.1b. /imports sits between Orders and
  // Escalations: data flows in via Imports → transactional outcomes flow
  // out via Orders/Escalations. activePrefix keeps /imports/[id] on the
  // parent (longest-prefix-wins resolver).
  { href: '/imports', label: 'Imports', icon: Upload, activePrefix: '/imports' },
  { href: '/escalations', label: 'Escalations', icon: AlertTriangle },
  { href: '/audit', label: 'Audit Log', icon: FileText },
  { href: '/settings/knowledge', label: 'Knowledge Center', icon: BookOpen },
  {
    href: '/settings/account/identity',
    label: 'Account',
    icon: Building2,
    activePrefix: '/settings/account',
  },
  // KAN-978 — Settings pinned to the IconRail bottom per the prototype's
  // .spacer + bottom-pinned `.rbtn` pattern. The route stays /settings.
  { href: '/settings', label: 'Settings', icon: Settings, pinBottom: true },
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
  '/settings/knowledge': 'Knowledge Center',
  // KAN-968 — Objectives + Pipelines page titles for the top-bar h1 resolver.
  '/settings/objectives': 'Objectives',
  '/pipelines': 'Pipelines',
  '/dashboard': 'Dashboard',
  '/opportunities': 'Opportunities',
  '/conversations': 'Conversations',
  '/escalations': 'Escalations',
  '/companies': 'Companies',
  '/customers': 'Customers',
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
  // Filter once here so the IconRail stays a pure rendering primitive.
  const activeHref = findActiveHref(pathname);
  const visibleNavItems: IconRailItem[] = navItems
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
