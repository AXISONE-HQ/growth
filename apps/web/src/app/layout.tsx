'use client';

import './globals.css';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  Activity,
  MessageSquare,
  AlertTriangle,
  Users,
  FileText,
  BookOpen,
  Settings,
  Search,
  Pause,
  Bell,
} from 'lucide-react';

const navItems = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/pipelines', label: 'Pipelines', icon: Activity },
  { href: '/conversations', label: 'Conversations', icon: MessageSquare },
  { href: '/escalations', label: 'Escalations', icon: AlertTriangle, badge: 3 },
  { href: '/customers', label: 'Customers', icon: Users },
  { href: '/audit', label: 'Audit Log', icon: FileText },
  { href: '/knowledge', label: 'Knowledge Center', icon: BookOpen },
  { href: '/settings', label: 'Settings', icon: Settings },
];

const pageTitle: Record<string, string> = {
  '/dashboard': 'Dashboard',
  '/pipelines': 'Pipelines',
  '/pipelines/create': 'Create Pipeline',
  '/conversations': 'Conversations',
  '/escalations': 'Escalations',
  '/customers': 'Customers',
  '/audit': 'Audit Log',
  '/knowledge': 'Knowledge Center',
  '/settings': 'Settings',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const currentTitle = pageTitle[pathname] || 'Dashboard';

  return (
    <html lang="en">
      <body className="flex min-h-screen">
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
            {navItems.map((item) => {
              const Icon = item.icon;
              const isActive = pathname === item.href || pathname.startsWith(item.href + '/');
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
            })}
          </div>

          {/* Tenant Footer */}
          <div className="p-4 border-t border-white/10">
            <div className="flex items-center gap-2.5 p-2 rounded-lg">
              <div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center text-white text-[13px] font-semibold">
                AC
              </div>
              <div>
                <div className="text-[13px] font-medium text-white">Acme Consulting</div>
                <div className="text-[11px] text-white/50">Growth Plan</div>
              </div>
            </div>
          </div>
        </nav>

        {/* Main Content */}
        <main className="ml-60 flex-1 min-h-screen">
          {/* Top Bar */}
          <header className="flex items-center justify-between px-8 py-3 border-b border-gray-200 bg-white sticky top-0 z-40">
            <div className="flex items-center gap-4">
              <h1 className="text-lg font-semibold text-gray-900">{currentTitle}</h1>
              <div className="flex items-center gap-1.5 text-[13px] text-emerald-600 bg-emerald-50 px-2.5 py-1 rounded-full">
                <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse-slow" />
                growth is active
              </div>
            </div>

            <div className="flex-1 max-w-[480px] mx-6">
              <div className="flex items-center gap-2 px-3.5 py-2 rounded-lg border border-gray-200 bg-gray-50 focus-within:border-indigo-500 focus-within:bg-white focus-within:ring-[3px] focus-within:ring-indigo-500/10 transition-all">
                <Search className="w-4 h-4 text-gray-400 flex-shrink-0" />
                <input
                  type="text"
                  placeholder="Search contacts, decisions, actions..."
                  className="border-none bg-transparent outline-none text-sm font-[inherit] text-gray-900 w-full placeholder:text-gray-400"
                />
                <span className="text-[11px] text-gray-400 border border-gray-200 rounded px-1.5 py-[1px] flex-shrink-0">
                  âK
                </span>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <button className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-amber-500 bg-white text-amber-600 text-[13px] hover:bg-amber-500/10 transition-all">
                <Pause className="w-4 h-4" />
                Pause growth
              </button>
              <button className="relative flex items-center gap-1.5 px-3 py-2 rounded-lg border border-gray-200 bg-white text-gray-700 text-[13px] hover:bg-gray-100 transition-all">
                <Bell className="w-4 h-4" />
                <span className="absolute top-1 right-1 w-2 h-2 bg-red-500 rounded-full border-2 border-white" />
              </button>
            </div>
          </header>

          {/* Page Content */}
          {children}
        </main>
      </body>
    </html>
  );
}
