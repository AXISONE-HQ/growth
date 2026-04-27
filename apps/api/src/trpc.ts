import { initTRPC, TRPCError } from "@trpc/server";
import { FetchCreateContextFnOptions } from "@trpc/server/adapters/fetch";
import { prisma } from "./prisma.js";

// Firebase Admin — lazy init to avoid failures if env not set
let firebaseAdmin: typeof import("firebase-admin") | null = null;

async function getFirebaseAdmin() {
  if (firebaseAdmin) return firebaseAdmin;
  try {
    firebaseAdmin = await import("firebase-admin");
    if ((firebaseAdmin as any).getApps().length === 0) {
      (firebaseAdmin as any).initializeApp({
        projectId: process.env.FIREBASE_PROJECT_ID || "growth-493400",
      });
    }
    return firebaseAdmin;
  } catch {
    console.warn("firebase-admin not available — JWT verification disabled");
    return null;
  }
}

async function verifyFirebaseToken(
  token: string
): Promise<{ uid: string; email?: string } | null> {
  try {
    const admin = await getFirebaseAdmin();
    if (!admin) return null;
    const decoded = await admin.auth().verifyIdToken(token);
    return { uid: decoded.uid, email: decoded.email };
  } catch (err) {
    console.warn("Firebase token verification failed:", err);
    return null;
  }
}

export const createContext = async (opts: FetchCreateContextFnOptions) => {
  const tenantId = opts.req.headers.get("x-tenant-id") ?? undefined;

  // Extract Firebase JWT from Authorization header
  let firebaseUser: { uid: string; email?: string } | null = null;
  const authHeader = opts.req.headers.get("authorization") ?? undefined;
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    firebaseUser = await verifyFirebaseToken(token);
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

// KAN-702: tenant-admin gate. Looks up the authenticated Firebase user's
// TeamMember row for the active tenant and rejects unless role is owner or
// admin. Per-tenant authority — same role source the team invite router uses
// (apps/api/src/router.ts:2106). Interim implementation until KAN-714 promotes
// TenantRole to a schema-level enum + canonicalizes the procedure shape.
//
// Failure modes:
//   - No firebaseUser → UNAUTHORIZED (caller bypassed Firebase auth)
//   - No TeamMember row for (tenantId, email) → FORBIDDEN (user not in tenant)
//   - role not in {owner, admin} → FORBIDDEN
const ADMIN_ROLES = new Set(["owner", "admin"]);

export const adminProcedure = protectedProcedure.use(async (opts) => {
  const { ctx } = opts;

  if (!ctx.firebaseUser?.email) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Admin procedures require a Firebase-authenticated user with email",
    });
  }

  const member: { role: string } | null = await (ctx.prisma as any).teamMember?.findFirst({
    where: { tenantId: ctx.tenantId, email: ctx.firebaseUser.email },
    select: { role: true },
  });

  if (!member) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `User ${ctx.firebaseUser.email} is not a member of tenant ${ctx.tenantId}`,
    });
  }

  if (!ADMIN_ROLES.has(member.role)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `Role '${member.role}' cannot perform admin-gated operations (requires owner or admin)`,
    });
  }

  return opts.next({
    ctx: {
      ...ctx,
      teamMemberRole: member.role,
    },
  });
});
