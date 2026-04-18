import { ErrorCategory, RequestStatus, Tier } from "@prisma/client";
import type { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { HttpError, sendError } from "../lib/http.js";
import { estimateTextTokens } from "../lib/tokens.js";
import { isTierAllowed } from "../lib/tiers.js";
import type { GatewayPolicy, ModelConfigWithProvider } from "../types.js";

const anthropicMessageSchema = z.object({
  model: z.string().optional(),
  max_tokens: z.number().int().positive().default(1024),
  messages: z.array(z.object({
    role: z.enum(["user", "assistant"]),
    content: z.unknown()
  })).min(1),
  system: z.unknown().optional(),
  stream: z.boolean().optional()
}).passthrough();

export const anthropicCompatibleRouter = Router();

anthropicCompatibleRouter.post("/messages", async (req, res) => {
  try {
    if (!req.gateway) {
      throw new HttpError(401, "Authentication required", "auth_required");
    }

    const payload = anthropicMessageSchema.parse(req.body);
    const requestedTier = parseTierOverride(payload.model);
    const selectedTier = requestedTier ?? Tier.L1;

    if (!isTierAllowed(selectedTier, req.gateway.policy.maxTier)) {
      throw new HttpError(403, `Requested tier ${selectedTier} exceeds allowed tier ${req.gateway.policy.maxTier}`, "tier_not_allowed");
    }

    if (req.gateway.policy.cacheEnabled) {
      throw new HttpError(501, "Cache is enabled in policy but cache service is not configured", "cache_not_configured");
    }

    if (req.gateway.policy.ragEnabled) {
      throw new HttpError(501, "RAG is enabled in policy but RAG service is not configured", "rag_not_configured");
    }

    const model = modelForTier(req.gateway.policy, selectedTier);

    if (!model) {
      throw new HttpError(400, `No model configured for tier ${selectedTier}`, "model_not_configured");
    }

    const promptText = serializeAnthropicPrompt(payload.messages as AnthropicPromptMessage[], payload.system);
    const inputTokensEstimated = estimateTextTokens(promptText);

    if (inputTokensEstimated > req.gateway.policy.maxInputTokens) {
      await logAnthropicRequest({
        userId: req.gateway.user.id,
        status: RequestStatus.REJECTED,
        requestedTier,
        selectedTier,
        selectedModel: model.modelName,
        promptText,
        inputTokensEstimated,
        outputTokensLimit: payload.max_tokens,
        errorCategory: ErrorCategory.TOKEN_LIMIT,
        errorMessage: "Input token limit exceeded"
      });
      throw new HttpError(413, "Input token limit exceeded", "input_token_limit");
    }

    const maxTokens = Math.min(payload.max_tokens, req.gateway.policy.maxOutputTokens, model.maxOutputTokens);

    if (inputTokensEstimated + maxTokens > model.maxContextTokens) {
      throw new HttpError(413, `Context limit exceeded for model ${model.displayName}`, "context_limit");
    }

    const providerResponse = await callOpenRouterMessages({
      model,
      body: {
        ...payload,
        model: model.modelName,
        max_tokens: maxTokens
      }
    });

    if (!providerResponse.ok) {
      const errorBody = await providerResponse.text();
      await logAnthropicRequest({
        userId: req.gateway.user.id,
        status: RequestStatus.FAILED,
        requestedTier,
        selectedTier,
        selectedModel: model.modelName,
        promptText,
        inputTokensEstimated,
        outputTokensLimit: maxTokens,
        errorCategory: ErrorCategory.PROVIDER,
        errorMessage: errorBody || providerResponse.statusText
      });
      throw new HttpError(502, errorBody || providerResponse.statusText, "provider_failed");
    }

    if (payload.stream) {
      await streamAnthropicResponse({
        response: providerResponse,
        res,
        log: {
          model,
          userId: req.gateway.user.id,
          requestedTier,
          selectedTier,
          selectedModel: model.modelName,
          promptText,
          inputTokensEstimated,
          outputTokensLimit: maxTokens
        }
      });
      return;
    }

    const body = await providerResponse.json() as {
      id?: string;
      model?: string;
      usage?: AnthropicUsage;
    };

    await logAnthropicRequest({
      userId: req.gateway.user.id,
      status: RequestStatus.SUCCESS,
      requestedTier,
      selectedTier,
      selectedModel: body.model ?? model.modelName,
      promptText,
      inputTokensEstimated,
      outputTokensLimit: maxTokens,
      providerInputTokens: body.usage?.input_tokens,
      providerOutputTokens: body.usage?.output_tokens,
      providerTotalTokens: sumAnthropicUsage(body.usage),
      providerCachedTokens: body.usage?.cache_read_input_tokens,
      providerCost: estimateProviderCost({
        model,
        inputTokens: body.usage?.input_tokens ?? inputTokensEstimated,
        outputTokens: body.usage?.output_tokens ?? 0
      }),
      providerRawUsage: body.usage,
      errorCategory: ErrorCategory.NONE
    });

    res.json({
      id: body.id ?? `msg_${randomUUID().replaceAll("-", "")}`,
      ...body,
      model: body.model ?? model.modelName
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      sendError(res, new HttpError(400, error.message, "invalid_messages_request"));
      return;
    }

    sendError(res, error);
  }
});

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  [key: string]: unknown;
}

interface AnthropicPromptMessage {
  role: string;
  content: unknown;
}

async function callOpenRouterMessages(input: { model: ModelConfigWithProvider; body: Record<string, unknown> }): Promise<Response> {
  const provider = input.model.provider;
  const apiKey = process.env[provider.apiKeyEnvVar];

  if (!apiKey) {
    throw new HttpError(500, `Missing provider API key environment variable: ${provider.apiKeyEnvVar}`, "provider_key_missing");
  }

  return fetch(`${provider.baseUrl.replace(/\/$/, "")}/messages`, {
    method: "POST",
    headers: {
      "authorization": `Bearer ${apiKey}`,
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "http-referer": process.env.OPENROUTER_HTTP_REFERER ?? "http://localhost:3000",
      "x-title": process.env.OPENROUTER_APP_TITLE ?? "LLM Gateway"
    },
    body: JSON.stringify(input.body)
  });
}

async function streamAnthropicResponse(input: {
  response: Response;
  res: import("express").Response;
  log: Omit<LogInput, "status" | "errorCategory"> & { model: ModelConfigWithProvider };
}): Promise<void> {
  input.res.setHeader("content-type", input.response.headers.get("content-type") ?? "text/event-stream; charset=utf-8");
  input.res.setHeader("cache-control", "no-cache");
  input.res.setHeader("connection", "keep-alive");

  const reader = input.response.body?.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffered = "";
  let usage: AnthropicUsage | undefined;

  if (!reader) {
    input.res.end();
    return;
  }

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    const chunk = decoder.decode(value, { stream: true });
    buffered += chunk;
    input.res.write(encoder.encode(chunk));
  }

  usage = extractLastUsageFromSse(buffered);

  await logAnthropicRequest({
    ...input.log,
    status: RequestStatus.SUCCESS,
    providerInputTokens: usage?.input_tokens,
    providerOutputTokens: usage?.output_tokens,
    providerTotalTokens: sumAnthropicUsage(usage),
    providerCachedTokens: usage?.cache_read_input_tokens,
    providerCost: estimateProviderCost({
      model: input.log.model,
      inputTokens: usage?.input_tokens ?? input.log.inputTokensEstimated,
      outputTokens: usage?.output_tokens ?? 0
    }),
    providerRawUsage: usage,
    errorCategory: ErrorCategory.NONE
  });

  input.res.end();
}

function extractLastUsageFromSse(buffered: string): AnthropicUsage | undefined {
  let usage: AnthropicUsage | undefined;

  for (const line of buffered.split(/\r?\n/)) {
    if (!line.startsWith("data: ")) {
      continue;
    }

    const data = line.slice("data: ".length);

    if (data === "[DONE]") {
      continue;
    }

    try {
      const parsed = JSON.parse(data) as { usage?: AnthropicUsage };

      if (parsed.usage) {
        usage = parsed.usage;
      }
    } catch {
      continue;
    }
  }

  return usage;
}

interface LogInput {
  userId: string;
  status: RequestStatus;
  requestedTier?: Tier;
  selectedTier?: Tier;
  selectedModel?: string;
  promptText: string;
  inputTokensEstimated: number;
  outputTokensLimit: number;
  providerInputTokens?: number;
  providerOutputTokens?: number;
  providerTotalTokens?: number;
  providerCachedTokens?: number;
  providerCost?: number;
  providerRawUsage?: AnthropicUsage;
  errorCategory: ErrorCategory;
  errorMessage?: string;
}

async function logAnthropicRequest(input: LogInput): Promise<void> {
  await prisma.requestLog.create({
    data: {
      userId: input.userId,
      status: input.status,
      requestedTier: input.requestedTier,
      selectedTier: input.selectedTier,
      selectedModel: input.selectedModel,
      promptText: input.promptText,
      promptPreview: input.promptText.slice(0, 300),
      inputTokensEstimated: input.inputTokensEstimated,
      outputTokensLimit: input.outputTokensLimit,
      providerInputTokens: input.providerInputTokens,
      providerOutputTokens: input.providerOutputTokens,
      providerTotalTokens: input.providerTotalTokens,
      providerCachedTokens: input.providerCachedTokens,
      providerCost: input.providerCost,
      providerRawUsage: toPrismaJson(input.providerRawUsage),
      errorCategory: input.errorCategory,
      errorMessage: input.errorMessage
    }
  });
}

function modelForTier(policy: GatewayPolicy, tier: Tier): ModelConfigWithProvider | null {
  if (tier === Tier.L1) return policy.l1Model;
  if (tier === Tier.L2) return policy.l2Model;
  return policy.l3Model;
}

function parseTierOverride(model?: string): Tier | undefined {
  if (model === Tier.L1 || model === Tier.L2 || model === Tier.L3) {
    return model;
  }

  return undefined;
}

function serializeAnthropicPrompt(messages: Array<{ role: string; content: unknown }>, system: unknown): string {
  const systemText = system ? `system: ${stringifyContent(system)}\n\n` : "";
  return `${systemText}${messages.map((message) => `${message.role}: ${stringifyContent(message.content)}`).join("\n\n")}`;
}

function stringifyContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  return JSON.stringify(content);
}

function sumAnthropicUsage(usage?: AnthropicUsage): number | undefined {
  if (!usage) {
    return undefined;
  }

  return (usage.input_tokens ?? 0)
    + (usage.output_tokens ?? 0)
    + (usage.cache_creation_input_tokens ?? 0)
    + (usage.cache_read_input_tokens ?? 0);
}

function estimateProviderCost(input: {
  model: ModelConfigWithProvider;
  inputTokens: number;
  outputTokens: number;
}): number | undefined {
  if (!input.model.inputCostPer1M || !input.model.outputCostPer1M) {
    return undefined;
  }

  const inputCost = Number(input.model.inputCostPer1M);
  const outputCost = Number(input.model.outputCostPer1M);

  if (!Number.isFinite(inputCost) || !Number.isFinite(outputCost)) {
    return undefined;
  }

  return ((input.inputTokens / 1_000_000) * inputCost) + ((input.outputTokens / 1_000_000) * outputCost);
}

function toPrismaJson(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined) {
    return undefined;
  }

  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
