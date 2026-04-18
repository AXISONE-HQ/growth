import express from "express";
import cors from "cors";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { appRouter } from "./router.js";
import { createContext } from "./trpc.js";

const app = express();
const PORT = process.env.PORT || 8080;

// CORS middleware
app.use(cors({
  origin: process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(",")
    : [
        "http://localhost:3000",
        "http://localhost:3001",
        "https://growth-web-1086551891973.us-central1.run.app",
      ],
  allowedHeaders: ["Content-Type", "x-tenant-id", "Authorization"],
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  credentials: true,
}));

app.use(express.json());

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "growth-api", timestamp: new Date().toISOString() });
});

// Root
app.get("/", (_req, res) => {
  res.json({ message: "growth API  AI Revenue System by AxisOne" });
});

// tRPC
app.use("/trpc", createExpressMiddleware({
  router: appRouter,
  createContext,
}));

app.listen(PORT, () => {
  console.log(`growth-api listening on port ${PORT}`);
});
