/**
 * KAN-829 sub-cohort 2 — Singleton TanStack Query client for the apps/web
 * admin UI. First TanStack Query usage in the app per pre-flight Decision 4.
 *
 * Default options aligned with admin UI usage:
 *   - staleTime 30s — admin UI tolerates slight staleness
 *   - refetchOnWindowFocus + refetchOnReconnect — admin returns to tab → fresh
 *   - retry 1 (queries) — single retry on transient failure (avoid spam)
 *   - retry 0 (mutations) — never retry (could re-submit unsafe actions)
 *
 * Future Sprint 11a + 11b admin features default to TanStack Query;
 * existing useState/trpcQuery code stays untouched (opportunistic migration
 * per pre-flight Decision 4).
 */
import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30 * 1000, // 30 seconds
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
      retry: 1,
    },
    mutations: {
      retry: 0,
    },
  },
});
