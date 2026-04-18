import cors from "cors";
import express from "express";
import path from "node:path";
import { config } from "./config.js";
import { authenticateGatewayKey, authenticateSession } from "./middleware/auth.js";
import { requireAdmin } from "./middleware/admin.js";
import { accountRouter } from "./routes/account.js";
import { adminRouter } from "./routes/admin.js";
import { anthropicCompatibleRouter } from "./routes/anthropic-compatible.js";
import { authRouter } from "./routes/auth.js";
import { chatRouter } from "./routes/chat.js";
import { openAiCompatibleRouter } from "./routes/openai-compatible.js";
import { policyRouter } from "./routes/policy.js";

export function createApp(): express.Express {
  const app = express();

  app.use(cors({
    origin: config.NODE_ENV === "production" ? false : config.CLIENT_DEV_ORIGIN
  }));
  app.use(express.json({ limit: "1mb" }));

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use("/api/auth", authRouter);
  app.use("/api/account", authenticateSession, accountRouter);
  app.use("/api/v1", authenticateGatewayKey, policyRouter, chatRouter);
  app.use("/v1", authenticateGatewayKey, openAiCompatibleRouter);
  app.use("/v1", authenticateGatewayKey, anthropicCompatibleRouter);
  app.use("/api/admin", authenticateSession, requireAdmin, adminRouter);

  if (config.NODE_ENV === "production") {
    const clientDistPath = path.resolve(process.cwd(), "client", "dist");
    app.use(express.static(clientDistPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(clientDistPath, "index.html"));
    });
  }

  return app;
}
