import { Tier } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { HttpError, sendError } from "../lib/http.js";
import { executeGatewayRequest } from "../services/gateway.js";

const completionSchema = z.object({
  model: z.string().optional(),
  messages: z.array(z.object({
    role: z.enum(["system", "user", "assistant"]),
    content: z.string().min(1)
  })).min(1),
  max_tokens: z.number().int().positive().optional(),
  stream: z.boolean().optional()
});

export const openAiCompatibleRouter = Router();

openAiCompatibleRouter.post("/chat/completions", async (req, res) => {
  try {
    if (!req.gateway) {
      throw new HttpError(401, "Authentication required", "auth_required");
    }

    const payload = completionSchema.parse(req.body);
    const requestedTier = parseTierOverride(payload.model);
    const result = await executeGatewayRequest({
      userId: req.gateway.user.id,
      policy: req.gateway.policy,
      messages: payload.messages,
      requestedTier,
      maxOutputTokens: payload.max_tokens
    });

    const responseId = `chatcmpl_${randomUUID().replaceAll("-", "")}`;
    const created = Math.floor(Date.now() / 1000);
    const usage = {
      prompt_tokens: result.providerInputTokens ?? result.inputTokensEstimated,
      completion_tokens: result.providerOutputTokens ?? 0,
      total_tokens: result.providerTotalTokens ?? (result.providerInputTokens ?? result.inputTokensEstimated) + (result.providerOutputTokens ?? 0)
    };

    if (payload.stream) {
      res.setHeader("content-type", "text/event-stream; charset=utf-8");
      res.setHeader("cache-control", "no-cache");
      res.setHeader("connection", "keep-alive");
      res.write(`data: ${JSON.stringify({
        id: responseId,
        object: "chat.completion.chunk",
        created,
        model: result.selectedModel,
        choices: [{
          index: 0,
          delta: { role: "assistant", content: result.content },
          finish_reason: null
        }]
      })}\n\n`);
      res.write(`data: ${JSON.stringify({
        id: responseId,
        object: "chat.completion.chunk",
        created,
        model: result.selectedModel,
        choices: [{
          index: 0,
          delta: {},
          finish_reason: "stop"
        }]
      })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    res.json({
      id: responseId,
      object: "chat.completion",
      created,
      model: result.selectedModel,
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: result.content
        },
        finish_reason: "stop"
      }],
      usage
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      sendError(res, new HttpError(400, error.message, "invalid_completion_request"));
      return;
    }

    sendError(res, error);
  }
});

function parseTierOverride(model?: string): Tier | undefined {
  if (model === Tier.L1 || model === Tier.L2 || model === Tier.L3) {
    return model;
  }

  return undefined;
}
