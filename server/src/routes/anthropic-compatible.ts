import { Tier } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { HttpError, sendError } from "../lib/http.js";
import { logError, logInfo, stringifyForLog } from "../lib/logger.js";
import { executeGatewayRequest } from "../services/gateway.js";
import type { GatewayMessage, GatewayToolCall, GatewayToolDefinition } from "../types.js";

const contentBlockSchema = z.object({
  type: z.string(),
  text: z.string().optional(),
  id: z.string().optional(),
  name: z.string().optional(),
  input: z.unknown().optional(),
  tool_use_id: z.string().optional(),
  content: z.unknown().optional()
}).passthrough();

const anthropicMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.union([z.string(), z.array(contentBlockSchema)])
}).passthrough();

const toolSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  input_schema: z.record(z.unknown()).optional()
}).passthrough();

const messagesRequestSchema = z.object({
  model: z.string().optional(),
  max_tokens: z.number().int().positive().default(1024),
  messages: z.array(anthropicMessageSchema).min(1),
  system: z.union([z.string(), z.array(contentBlockSchema)]).optional(),
  tools: z.array(toolSchema).optional(),
  tool_choice: z.union([
    z.object({ type: z.literal("auto") }).passthrough(),
    z.object({ type: z.literal("tool"), name: z.string() }).passthrough()
  ]).optional(),
  stream: z.boolean().optional()
}).passthrough();

const unsupportedAnthropicContentTypes = new Set(["thinking", "redacted_thinking"]);

export const anthropicCompatibleRouter = Router();

anthropicCompatibleRouter.post("/messages", async (req, res) => {
  try {
    if (!req.gateway) {
      throw new HttpError(401, "Authentication required", "auth_required");
    }

    logInfo("anthropic", "request body received", {
      userId: req.gateway.user.id,
      body: stringifyForLog(req.body)
    });

    const payload = messagesRequestSchema.parse(req.body);
    const sanitizedPayload = sanitizeAnthropicPayload(payload);
    const requestedTier = parseTierOverride(payload.model);
    const requestedModelAlias = payload.model && !requestedTier ? payload.model : undefined;
    const result = await executeGatewayRequest({
      userId: req.gateway.user.id,
      policy: req.gateway.policy,
      aliases: req.gateway.aliases,
      clientProtocol: "anthropic_messages",
      messages: toGatewayMessages(sanitizedPayload.system, sanitizedPayload.messages),
      tools: sanitizedPayload.tools?.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.input_schema
      })),
      toolChoice: toGatewayToolChoice(sanitizedPayload.tool_choice),
      stream: sanitizedPayload.stream,
      requestedTier,
      requestedModelAlias,
      maxOutputTokens: sanitizedPayload.max_tokens,
      metadata: {
        incomingModel: payload.model,
        adapterWarnings: buildAdapterWarnings(payload, sanitizedPayload)
      }
    });

    logInfo("anthropic", "request received", {
      userId: req.gateway.user.id,
      requestedTier,
      requestedModelAlias,
      incomingModel: payload.model,
      messageCount: payload.messages.length,
      stream: payload.stream ?? false
    });

    const responseId = `msg_${randomUUID().replaceAll("-", "")}`;
    const contentBlocks = toAnthropicContentBlocks(result.content, result.toolCalls);
    const usage = {
      input_tokens: result.providerInputTokens ?? result.inputTokensEstimated,
      output_tokens: result.providerOutputTokens ?? 0
    };

    if (payload.stream) {
      res.setHeader("content-type", "text/event-stream; charset=utf-8");
      res.setHeader("cache-control", "no-cache");
      res.setHeader("connection", "keep-alive");

      res.write(`event: message_start\ndata: ${JSON.stringify({
        type: "message_start",
        message: {
          id: responseId,
          type: "message",
          role: "assistant",
          model: result.selectedModel,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage
        }
      })}\n\n`);

      contentBlocks.forEach((block, index) => {
        res.write(`event: content_block_start\ndata: ${JSON.stringify({
          type: "content_block_start",
          index,
          content_block: block
        })}\n\n`);

        if (block.type === "text") {
          res.write(`event: content_block_delta\ndata: ${JSON.stringify({
            type: "content_block_delta",
            index,
            delta: {
              type: "text_delta",
              text: block.text
            }
          })}\n\n`);
        }

        res.write(`event: content_block_stop\ndata: ${JSON.stringify({
          type: "content_block_stop",
          index
        })}\n\n`);
      });

      res.write(`event: message_delta\ndata: ${JSON.stringify({
        type: "message_delta",
        delta: {
          stop_reason: result.toolCalls?.length ? "tool_use" : "end_turn",
          stop_sequence: null
        },
        usage
      })}\n\n`);
      res.write(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
      res.end();
      return;
    }

    res.json({
      id: responseId,
      type: "message",
      role: "assistant",
      model: result.selectedModel,
      content: contentBlocks,
      stop_reason: result.toolCalls?.length ? "tool_use" : "end_turn",
      stop_sequence: null,
      usage
    });
  } catch (error) {
    logError("anthropic", "request errored", {
      path: req.originalUrl,
      userId: req.gateway?.user.id,
      error: error instanceof Error ? error.message : "Unknown error"
    });

    if (error instanceof z.ZodError) {
      sendError(res, new HttpError(400, error.message, "invalid_messages_request"));
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

function sanitizeAnthropicPayload(
  payload: z.infer<typeof messagesRequestSchema>
): z.infer<typeof messagesRequestSchema> {
  const nextPayload = {
    ...payload,
    system: sanitizeAnthropicContent(payload.system),
    messages: payload.messages.map((message) => ({
      ...message,
      content: sanitizeAnthropicContent(message.content)
    }))
  } as z.infer<typeof messagesRequestSchema> & { thinking?: unknown };

  if ("thinking" in nextPayload) {
    delete nextPayload.thinking;
  }

  return nextPayload;
}

function sanitizeAnthropicContent(
  content: string | Array<Record<string, unknown>> | undefined
): string | Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(content)) {
    return content;
  }

  const blocks = content
    .map((block) => sanitizeAnthropicBlock(block))
    .filter((block): block is Record<string, unknown> => block !== null);

  if (!blocks.length) {
    return "";
  }

  return blocks;
}

function sanitizeAnthropicBlock(block: Record<string, unknown>): Record<string, unknown> | null {
  const type = typeof block.type === "string" ? block.type : "";

  if (unsupportedAnthropicContentTypes.has(type)) {
    return null;
  }

  if ((type === "tool_result" || type === "document") && "content" in block) {
    return {
      ...block,
      content: sanitizeAnthropicContent(block.content as string | Array<Record<string, unknown>> | undefined)
    };
  }

  return block;
}

function toGatewayMessages(
  system: string | Array<Record<string, unknown>> | undefined,
  messages: Array<z.infer<typeof anthropicMessageSchema>>
): GatewayMessage[] {
  const gatewayMessages: GatewayMessage[] = [];

  if (system) {
    gatewayMessages.push({
      role: "system",
      content: normalizeAnthropicContent(system)
    });
  }

  for (const message of messages) {
    gatewayMessages.push(...gatewayMessagesFromAnthropicMessage(message));
  }

  return gatewayMessages;
}

function gatewayMessagesFromAnthropicMessage(
  message: z.infer<typeof anthropicMessageSchema>
): GatewayMessage[] {
  if (typeof message.content === "string") {
    return [{
      role: message.role,
      content: message.content
    }];
  }

  const textParts = message.content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text ?? "")
    .join("");
  const toolCalls = message.role === "assistant"
    ? message.content
      .filter((block) => block.type === "tool_use")
      .map((block) => ({
        id: block.id ?? `call_${randomUUID().replaceAll("-", "")}`,
        name: block.name ?? "tool",
        arguments: JSON.stringify(block.input ?? {})
      }))
    : undefined;
  const toolResults = message.role === "user"
    ? message.content
      .filter((block) => block.type === "tool_result")
      .map((block) => ({
        role: "tool" as const,
        content: normalizeAnthropicContent(block.content),
        toolCallId: block.tool_use_id
      }))
    : [];

  const normalized: GatewayMessage[] = [{
    role: message.role,
    content: textParts,
    toolCalls
  }];

  return [...normalized, ...toolResults];
}

function normalizeAnthropicContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .filter((block) => typeof block === "object" && block !== null && "text" in block && typeof block.text === "string")
    .map((block) => String(block.text))
    .join("");
}

function toGatewayToolChoice(
  toolChoice?: z.infer<typeof messagesRequestSchema>["tool_choice"]
): "auto" | "none" | { name: string } | undefined {
  if (!toolChoice) {
    return undefined;
  }

  if (toolChoice.type === "tool") {
    return { name: toolChoice.name };
  }

  return "auto";
}

function buildAdapterWarnings(
  original: z.infer<typeof messagesRequestSchema>,
  sanitized: z.infer<typeof messagesRequestSchema>
): string[] {
  const warnings: string[] = [];

  if ("thinking" in original) {
    warnings.push("Removed unsupported Anthropic thinking field");
  }

  if (JSON.stringify(original.messages) !== JSON.stringify(sanitized.messages)) {
    warnings.push("Removed unsupported Anthropic content blocks");
  }

  return warnings;
}

function toAnthropicContentBlocks(content: string, toolCalls?: GatewayToolCall[]) {
  const blocks: Array<Record<string, unknown>> = [];

  if (content) {
    blocks.push({
      type: "text",
      text: content
    });
  }

  if (toolCalls?.length) {
    blocks.push(...toolCalls.map((toolCall) => ({
      type: "tool_use",
      id: toolCall.id,
      name: toolCall.name,
      input: safeJsonParse(toolCall.arguments)
    })));
  }

  return blocks;
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}
