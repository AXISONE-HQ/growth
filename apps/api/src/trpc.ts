import { initTRPC, TRPCError } from "@trpc/server";
import { CreateHTTPContextOptions } from "@trpc/server/adapters/standalone";
import { prisma } from "./prisma.js";
export const createContext = async (opts: CreateHTTPContextOptions) => {
  const tenantId = opts.req.headers["x-tenant-id"] as string | undefined;
  return { prisma, tenantId };
};
export type Context = Awaited<ReturnType<typeof createContext>>;
const t = initTRPC.context<Context>().create();
export const router = t.router;
export const publicProcedure = t.procedure;
export const protectedProcedure = t.procedure.use(async (opts) => {
  const { ctx } = opts;
  if (!ctx.tenantId) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Missing x-tenant-id header" });
  }
  return opts.next({ ctx: { ...ctx, tenantId: ctx.tenantId } });
});
