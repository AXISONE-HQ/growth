import { initTRPC, TRPCError } from "@trpc/server";
import { CreateHTTPContextOptions } from "@trpc/server/adapters/standalone";
import { prisma } from "./prisma.js";

// Firebase Admin — lazy init to avoid failures if env not set
let firebaseAdmin: typeof import("firebase-admin") | null = null;

async function getFirebaseAdmin() {
  if (firebaseAdmin) return firebaseAdmin;
  try {
    firebaseAdmin = await import("firebase-admin");
    if (firebaseAdmin.getApps().length === 0) {
      firebaseAdmin.initializeApp({
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

export const createContext = async (opts: CreateHTTPContextOptions) => {
  const tenantId = opts.req.headers["x-tenant-id"] as string | undefined;

  // Extract Firebase JWT from Authorization header
  let firebaseUser: { uid: string; email?: string } | null = null;
  const authHeader = opts.req.headers["authorization"] as string | undefined;
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
