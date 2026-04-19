import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { trpcServer } from "@hono/trpc-server";
import { appRouter } from "./router.js";
import { createContext } from "./trpc.js";

const app = new Hono();
const PORT = Number(process.env.PORT) || 8080;

// CORS middleware
app.use("/*", cors({
  origin: process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(",")
    : [
        "http://localhost:3000",
        "http://localhost:3001",
        "https://growth-web-1086551891973.us-central1.run.app",
      ],
  allowHeaders: ["Content-Type", "x-tenant-id", "Authorization"],
  allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  credentials: true,
}));

// Health check
app.get("/health", (c) => {
  return c.json({ status: "ok", service: "growth-api", timestamp: new Date().toISOString() });
});

// Root
app.get("/", (c) => {
  return c.json({ message: "growth API - AI Revenue System by AxisOne" });
});

// tRPC
app.use("/trpc/*", trpcServer({
  router: appRouter,
  createContext,
}));

serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`growth-api listening on port ${PORT}`);
});
