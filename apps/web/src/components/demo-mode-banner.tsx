'use client';

/**
 * KAN-718 — top-of-page banner shown whenever NEXT_PUBLIC_DEMO_MODE is on.
 *
 * Prevents accidental confusion — if anyone lands in demo mode unexpectedly
 * (wrong env var in prod, copy-paste of staging URL, internal tool sharing),
 * they immediately see the "data is illustrative" disclaimer.
 */
import { Sparkles } from "lucide-react";
import { isDemoMode } from "@/lib/demo-mode";

export function DemoModeBanner(): React.ReactElement | null {
  if (!isDemoMode()) return null;
  return (
    <div className="bg-amber-50 border-b border-amber-200 px-6 py-2 flex items-center gap-2 text-xs text-amber-800">
      <Sparkles className="w-3.5 h-3.5 flex-shrink-0" />
      <span className="font-medium">DEMO MODE</span>
      <span className="text-amber-700">
        — data shown is illustrative and may not reflect real tenant state.
      </span>
    </div>
  );
}
