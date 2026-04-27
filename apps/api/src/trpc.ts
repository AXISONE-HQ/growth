import { initTRPC, TRPCError } from "@trpc/server";
import { FetchCreateContextFnOptions } from "@trpc/server/adapters/fetch";
import { initializeApp, getApps, applicationDefault } from "firebase-admin/app";
import { getAuth, type Auth } from "firebase-admin/auth";
import { prisma } from "./prisma.js";

// KAN-702 PR A.2 — fail-loud Firebase Admin init.
//
// Previous shape was a try/catch dynamic import that returned null on any
// failure (missing package, init crash, anything). The package wasn't even
// in package-lock.json, so verification was silently disabled in prod. Caught
// by PR A.1 sniff-test when adminProcedure threw UNAUTHORIZED for a known-good
// allowlisted email — there was no Firebase verification happening at all.
//
// Now: import statically (CI fails if firebase-admin isn't installed),
// initialize once at module load (container refuses to start if config is
// broken), and let verifyIdToken errors propagate to the caller. No silent
// "auth disabled" mode.
if (getApps().length === 0) {
  initializeApp({
    credential: applicationDefault(),
    projectId: process.env.FIREBASE_PROJECT_ID || "growth-493400",
  });
}
const firebaseAuth: Auth = getAuth();

async function verifyFirebaseToken(
  token: string,
): Promise<{ uid: string; email?: string }> {
  // Errors propagate. Caller (createContext) maps them to TRPCError UNAUTHORIZED
  // so a bad token gets an explicit 401 instead of falling through anonymously.
  const decoded = await firebaseAuth.verifyIdToken(token);
  return { uid: decoded.uid, email: decoded.email };
}

export const createContext = async (opts: FetchCreateContextFnOptions) => {
  const tenantId = opts.req.headers.get("x-tenant-id") ?? undefined;

  let firebaseUser: { uid: string; email?: string } | null = null;
  const authHeader = opts.req.headers.get("authorization") ?? undefined;
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    try {
      firebaseUser = await verifyFirebaseToken(token);
    } catch (err) {
      // Surface invalid/expired tokens as 401 explicitly. Silently leaving
      // firebaseUser=null would let the request flow through protectedProcedure
      // and only fail at adminProcedure with a misleading "missing email" error.
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: "Invalid or expired Firebase ID token",
        cause: err,
      });
    }
  }

  return {
    prisma,
    tenantId,
    firebaseUser,
  };
};

export type Context = Awaited<ReturnType<typeof createContext>>;

const t = initTRPC.context<Context>().create();

export const router = t.router;
export const publicProcedure = t.procedure;

export const protectedProcedure = t.procedure.use(async (opts) => {
  const { ctx } = opts;

  if (!ctx.tenantId) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Missing x-tenant-id header",
    });
  }

  // Log authenticated user for audit trail (non-blocking)
  if (ctx.firebaseUser) {
    console.log(
      `[auth] uid=${ctx.firebaseUser.uid} email=${ctx.firebaseUser.email} tenant=${ctx.tenantId}`
    );
  }

  return opts.next({
    ctx: {
      ...ctx,
      tenantId: ctx.tenantId,
      firebaseUser: ctx.firebaseUser,
    },
  });
});

// KAN-702 PR A.1 — admin gate via ADMIN_EMAILS env var allowlist.
//
// Pre-launch admin gate. Single admin (founder) pattern. Migrate to
// TeamMember-based per-tenant role authority in Sprint 7 alongside GoRush
// onboarding (KAN-714).
//
// Why this shape: PR A's first version queried `(prisma as any).teamMember`
// — TS short-circuited on the optional-chained delegate so the build passed,
// but at runtime the team_members table doesn't exist (Prisma error 42P01)
// because the TeamMember model was never added to schema.prisma. The cast-
// loose pattern silently shipped a broken middleware. Env-var allowlist is
// the simplest correct path until KAN-714 lands the schema work.
//
// Default-deny posture: empty / unset ADMIN_EMAILS rejects everyone. No
// silent "wide open in dev" fallback.
//
// Failure modes:
//   - No firebaseUser?.email → UNAUTHORIZED (caller bypassed Firebase auth)
//   - email not in ADMIN_EMAILS allowlist → FORBIDDEN
export const adminProcedure = protectedProcedure.use(async ({ ctx, next }) => {
  if (!ctx.firebaseUser?.email) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Admin procedures require a Firebase-authenticated user with email",
    });
  }

  const allowedEmails = (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

  if (!allowedEmails.includes(ctx.firebaseUser.email.toLowerCase())) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Admin access required",
    });
  }

  return next({ ctx });
});
