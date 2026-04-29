/**
 * KAN-717 — ops health endpoint for apps/web.
 *
 * Stable surface for monitoring + the KAN-747 smoke gate's container
 * startup probe. Stays decoupled from product UI: home-page redesigns
 * don't break the gate.
 *
 * `force-dynamic` ensures Next.js never aggressively caches the response —
 * monitoring tools always see fresh state.
 */
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({ status: "ok", service: "growth-web" });
}
