import { Tier } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { HttpError, sendError } from "../lib/http.js";
import { logInfo, stringifyForLog } from "../lib/logger.js";
import { executeGatewayRequest } from "../services/gateway.js";

const chatRequestSchema = z.object({
  messages: z.array(z.object({
    role: z.enum(["system", "user", "assistant"]),
    content: z.string().min(1)
  })).min(1),
  requestedTier: z.nativeEnum(Tier).optional(),
  maxOutputTokens: z.number().int().positive().optional()
});

export const chatRouter = Router();

chatRouter.post("/chat", async (req, res) => {
  try {
    if (!req.gateway) {
      throw new HttpError(401, "Authentication required", "auth_required");
    }

    logInfo("chat", "request body received", {
      userId: req.gateway.user.id,
      body: stringifyForLog(req.body)
    });

    const payload = chatRequestSchema.parse(req.body);
    const result = await executeGatewayRequest({
      userId: req.gateway.user.id,
      policy: req.gateway.policy,
      aliases: req.gateway.aliases,
      clientProtocol: "openai_chat",
      messages: payload.messages,
      requestedTier: payload.requestedTier,
      maxOutputTokens: payload.maxOutputTokens
    });

    res.json({
      data: result
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      sendError(res, new HttpError(400, error.message, "invalid_request"));
      return;
    }

    sendError(res, error);
  }
});
