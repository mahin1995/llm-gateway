import { Tier } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { HttpError, sendError } from "../lib/http.js";
import { logError, logInfo, stringifyForLog } from "../lib/logger.js";
import { executeGatewayRequest } from "../services/gateway.js";
import type { GatewayMessage, GatewayToolCall, GatewayToolDefinition } from "../types.js";

const contentPartSchema = z.object({
  type: z.string(),
  text: z.string().optional()
}).passthrough();

const toolCallSchema = z.object({
  id: z.string().optional(),
  type: z.string().optional(),
  function: z.object({
    name: z.string(),
    arguments: z.string().optional()
  }).optional()
}).passthrough();

const openAiMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.union([z.string(), z.array(contentPartSchema), z.null()]).optional(),
  tool_call_id: z.string().optional(),
  tool_calls: z.array(toolCallSchema).optional()
}).passthrough();

const toolSchema = z.object({
  type: z.literal("function"),
  function: z.object({
    name: z.string(),
    description: z.string().optional(),
    parameters: z.record(z.unknown()).optional()
  })
}).passthrough();

const completionSchema = z.object({
  model: z.string().optional(),
  messages: z.array(openAiMessageSchema).min(1),
  max_tokens: z.number().int().positive().optional(),
  tools: z.array(toolSchema).optional(),
  tool_choice: z.union([
    z.literal("auto"),
    z.literal("none"),
    z.object({
      type: z.literal("function"),
      function: z.object({ name: z.string() })
    })
  ]).optional(),
  stream: z.boolean().optional()
}).passthrough();

export const openAiCompatibleRouter = Router();

openAiCompatibleRouter.post("/chat/completions", async (req, res) => {
  try {
    if (!req.gateway) {
      throw new HttpError(401, "Authentication required", "auth_required");
    }

    logInfo("openai", "request body received", {
      userId: req.gateway.user.id,
      body: stringifyForLog(req.body)
    });

    const payload = completionSchema.parse(req.body);
    const requestedTier = parseTierOverride(payload.model);
    const requestedModelAlias = payload.model && !requestedTier ? payload.model : undefined;
    const messages = payload.messages.map(toGatewayMessage);
    const tools = payload.tools?.map(toGatewayTool);
    const result = await executeGatewayRequest({
      userId: req.gateway.user.id,
      policy: req.gateway.policy,
      aliases: req.gateway.aliases,
      clientProtocol: "openai_chat",
      messages,
      tools,
      toolChoice: toGatewayToolChoice(payload.tool_choice),
      stream: payload.stream,
      requestedTier,
      requestedModelAlias,
      maxOutputTokens: payload.max_tokens,
      metadata: {
        incomingModel: payload.model
      }
    });

    logInfo("openai", "request received", {
      userId: req.gateway.user.id,
      incomingModel: payload.model,
      requestedTier,
      requestedModelAlias,
      messageCount: payload.messages.length,
      stream: payload.stream ?? false
    });

    const responseId = `chatcmpl_${randomUUID().replaceAll("-", "")}`;
    const created = Math.floor(Date.now() / 1000);
    const usage = {
      prompt_tokens: result.providerInputTokens ?? result.inputTokensEstimated,
      completion_tokens: result.providerOutputTokens ?? 0,
      total_tokens: result.providerTotalTokens
        ?? (result.providerInputTokens ?? result.inputTokensEstimated) + (result.providerOutputTokens ?? 0)
    };
    const assistantMessage = toOpenAIAssistantMessage(result.content, result.toolCalls);

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
          delta: assistantDeltaForStream(result.content, result.toolCalls),
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
          finish_reason: result.toolCalls?.length ? "tool_calls" : "stop"
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
        message: assistantMessage,
        finish_reason: result.toolCalls?.length ? "tool_calls" : "stop"
      }],
      usage
    });
  } catch (error) {
    logError("openai", "request errored", {
      path: req.originalUrl,
      userId: req.gateway?.user.id,
      error: error instanceof Error ? error.message : "Unknown error"
    });

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

function toGatewayMessage(message: z.infer<typeof openAiMessageSchema>): GatewayMessage {
  return {
    role: message.role,
    content: normalizeOpenAIContent(message.content),
    toolCallId: message.tool_call_id,
    toolCalls: message.tool_calls?.map((toolCall) => ({
      id: toolCall.id ?? `call_${randomUUID().replaceAll("-", "")}`,
      name: toolCall.function?.name ?? "tool",
      arguments: toolCall.function?.arguments ?? "{}"
    }))
  };
}

function toGatewayTool(tool: z.infer<typeof toolSchema>): GatewayToolDefinition {
  return {
    name: tool.function.name,
    description: tool.function.description,
    inputSchema: tool.function.parameters
  };
}

function toGatewayToolChoice(
  toolChoice?: z.infer<typeof completionSchema>["tool_choice"]
): "auto" | "none" | { name: string } | undefined {
  if (!toolChoice) {
    return undefined;
  }

  if (toolChoice === "auto" || toolChoice === "none") {
    return toolChoice;
  }

  return { name: toolChoice.function.name };
}

function normalizeOpenAIContent(
  content: string | Array<{ type: string; text?: string }> | null | undefined
): string {
  if (!content) {
    return "";
  }

  if (typeof content === "string") {
    return content;
  }

  return content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

function toOpenAIAssistantMessage(content: string, toolCalls?: GatewayToolCall[]) {
  return {
    role: "assistant",
    content: content || null,
    ...(toolCalls?.length ? {
      tool_calls: toolCalls.map((toolCall) => ({
        id: toolCall.id,
        type: "function",
        function: {
          name: toolCall.name,
          arguments: toolCall.arguments
        }
      }))
    } : {})
  };
}

function assistantDeltaForStream(content: string, toolCalls?: GatewayToolCall[]) {
  const delta: Record<string, unknown> = { role: "assistant" };

  if (content) {
    delta.content = content;
  }

  if (toolCalls?.length) {
    delta.tool_calls = toolCalls.map((toolCall, index) => ({
      index,
      id: toolCall.id,
      type: "function",
      function: {
        name: toolCall.name,
        arguments: toolCall.arguments
      }
    }));
  }

  return delta;
}
