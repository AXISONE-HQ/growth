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
  LogOut,
  Shield,
  ChevronDown,
  Target,
  Receipt,
  Upload,
  Workflow,
} from 'lucide-react';
import { useState, useRef, useEffect } from 'react';
import { AuthProvider, useAuth } from '@/lib/AuthContext';
import { QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { queryClient } from '@/lib/query-client';
import { isDemoMode } from '@/lib/demo-mode';
import { DemoModeBanner } from '@/components/demo-mode-banner';
// KAN-977 Phase B.2 — TopNav lifted from the inline AppShell header into a
// shared component. AIStatusIndicator import retired from this file (it's
// now an internal of TopNav). The sidebar's logo/brand + user-footer drop-
// down stay here for Phase B.2 — Phase B.3 (IconRail rewrite) handles
// moving brand + account into the TopNav per the prototype.
import { TopNav } from '@/components/ui/top-nav';

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
  { href: '/settings', label: 'Settings', icon: Settings },
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
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Allow login page without auth
  if (pathname === '/login') {
    return <>{children}</>;
  }

  const handleLogout = async () => {
    setUserMenuOpen(false);
    await logout();
    router.push('/login');
  };

  // Loading spinner
  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-white">
        <div className="animate-spin">
          <Activity className="w-8 h-8 text-indigo-600" />
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

  return (
    <div className="flex min-h-screen">
      {/* Sidebar */}
      <nav className="fixed top-0 left-0 bottom-0 w-60 bg-black border-r border-slate-800 flex flex-col z-50">
        {/* Logo */}
        <div className="px-6 py-5 border-b border-white/10 flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-lg bg-indigo-500 flex items-center justify-center">
            <Activity className="w-4 h-4 text-white" />
          </div>
          <span className="text-white font-semibold text-base tracking-tight">growth</span>
        </div>

        {/* Navigation */}
        <div className="flex-1 p-3 flex flex-col gap-0.5">
          {(() => {
            const activeHref = findActiveHref(pathname);
            return navItems.map((item) => {
              const Icon = item.icon;
              const isActive = activeHref === item.href;

            // KAN-718: hide demo-only routes when DEMO_MODE is off (prod default).
            if (item.demoOnly && !isDemoMode()) {
              return null;
            }

            // Hide admin-only items from members
            if ('adminOnly' in item && item.adminOnly && user.role !== 'admin') {
              return null;
            }

            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm transition-all ${
                  isActive
                    ? 'bg-indigo-500 text-white'
                    : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
                }`}
              >
                <Icon className="w-[18px] h-[18px] flex-shrink-0" />
                {item.label}
                {item.badge && (
                  <span className="ml-auto text-[11px] font-semibold px-[7px] py-[2px] rounded-full bg-red-500 text-white">
                    {item.badge}
                  </span>
                )}
              </Link>
            );
            });
          })()}
        </div>

        {/* User Footer */}
        <div className="p-4 border-t border-white/10" ref={menuRef}>
          <div className="relative">
            <button
              onClick={() => setUserMenuOpen(!userMenuOpen)}
              className="w-full flex items-center gap-2.5 p-2 rounded-lg hover:bg-slate-800 transition-colors"
            >
              <div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center text-white text-[13px] font-semibold">
                {user.initials}
              </div>
              <div className="flex-1 text-left">
                <div className="text-[13px] font-medium text-white">{user.displayName || user.email}</div>
                <div className="text-[11px] text-white/50 flex items-center gap-1">
                  {user.role === 'admin' && <Shield className="w-3 h-3" />}
                  {user.role === 'admin' ? 'Admin' : 'Member'} &middot; {user.company}
                </div>
              </div>
              <ChevronDown className={`w-4 h-4 text-slate-400 transition-transform ${userMenuOpen ? 'rotate-180' : ''}`} />
            </button>

            {/* Dropdown Menu */}
            {userMenuOpen && (
              <div className="absolute bottom-full left-0 right-0 mb-2 bg-slate-900 border border-slate-700 rounded-lg shadow-xl overflow-hidden">
                <div className="px-3 py-2 border-b border-slate-700">
                  <div className="text-[12px] text-slate-400">{user.email}</div>
                </div>
                {user.role === 'admin' && (
                  <Link
                    href="/settings"
                    onClick={() => setUserMenuOpen(false)}
                    className="flex items-center gap-2 px-3 py-2.5 text-sm text-slate-300 hover:bg-slate-800 transition-colors"
                  >
                    <Settings className="w-4 h-4" />
                    Settings
                  </Link>
                )}
                <button
                  onClick={handleLogout}
                  className="w-full flex items-center gap-2 px-3 py-2.5 text-sm text-red-400 hover:bg-slate-800 transition-colors"
                >
                  <LogOut className="w-4 h-4" />
                  Sign out
                </button>
              </div>
            )}
          </div>
        </div>
      </nav>

      {/* Main Content */}
      <main className="ml-60 flex-1 min-h-screen">
        {/* KAN-718: top-of-page demo-mode disclaimer when NEXT_PUBLIC_DEMO_MODE is on */}
        <DemoModeBanner />
        {/* KAN-977 — TopNav lifted into a shared component (was inline header
         * at this location). Same content shape; restyled per Phase A tokens. */}
        <TopNav title={currentTitle} />

        {children}
      </main>
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
