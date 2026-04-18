import { ErrorCategory, RequestStatus, Tier } from "@prisma/client";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { HttpError } from "../lib/http.js";
import { estimateMessagesTokens, truncateMessagesToTokenBudget } from "../lib/tokens.js";
import { isTierAllowed, tierSequence } from "../lib/tiers.js";
import { createChatCompletion, ProviderError } from "./provider.js";
import type { ChatMessage, GatewayPolicy, ModelConfigWithProvider } from "../types.js";

export interface GatewayRequest {
  userId: string;
  policy: GatewayPolicy;
  messages: ChatMessage[];
  requestedTier?: Tier;
  maxOutputTokens?: number;
}

export interface GatewayResponse {
  content: string;
  selectedTier: Tier;
  selectedModel: string;
  inputTokensEstimated: number;
  outputTokensLimit: number;
  providerInputTokens?: number;
  providerOutputTokens?: number;
  providerTotalTokens?: number;
  providerCost?: number;
  escalationAttempts: number;
}

function modelForTier(policy: GatewayPolicy, tier: Tier): ModelConfigWithProvider | null {
  if (tier === Tier.L1) return policy.l1Model;
  if (tier === Tier.L2) return policy.l2Model;
  return policy.l3Model;
}

function shouldEscalate(error: unknown): boolean {
  return error instanceof ProviderError;
}

export async function executeGatewayRequest(request: GatewayRequest): Promise<GatewayResponse> {
  if (request.policy.cacheEnabled) {
    throw new HttpError(501, "Cache is enabled in policy but cache service is not configured", "cache_not_configured");
  }

  if (request.policy.ragEnabled) {
    throw new HttpError(501, "RAG is enabled in policy but RAG service is not configured", "rag_not_configured");
  }

  const startTier = request.requestedTier ?? Tier.L1;

  if (!isTierAllowed(startTier, request.policy.maxTier)) {
    throw new HttpError(403, `Requested tier ${startTier} exceeds allowed tier ${request.policy.maxTier}`, "tier_not_allowed");
  }

  let messages = request.messages;
  let estimatedInputTokens = estimateMessagesTokens(messages);
  const promptText = serializePrompt(request.messages);
  const promptPreview = promptText.slice(0, 300);

  if (estimatedInputTokens > request.policy.maxInputTokens) {
    if (!request.policy.truncateInput) {
      await logRejectedRequest(request, startTier, estimatedInputTokens, ErrorCategory.TOKEN_LIMIT, "Input token limit exceeded");
      throw new HttpError(413, "Input token limit exceeded", "input_token_limit");
    }

    messages = truncateMessagesToTokenBudget(messages, request.policy.maxInputTokens);
    estimatedInputTokens = estimateMessagesTokens(messages);
  }

  const outputTokensLimit = Math.min(
    request.maxOutputTokens ?? request.policy.maxOutputTokens,
    request.policy.maxOutputTokens
  );

  if (outputTokensLimit < 1) {
    throw new HttpError(400, "Output token limit must be positive", "invalid_output_limit");
  }

  let lastError: unknown;
  let escalationAttempts = 0;
  const attempts = tierSequence(startTier, request.policy.maxTier);

  for (const tier of attempts) {
    const model = modelForTier(request.policy, tier);

    if (!model) {
      lastError = new ProviderError(`No model configured for tier ${tier}`);
      escalationAttempts += 1;
      continue;
    }

    const modelOutputLimit = Math.min(outputTokensLimit, model.maxOutputTokens);

    if (estimatedInputTokens + modelOutputLimit > model.maxContextTokens) {
      lastError = new ProviderError(`Context limit exceeded for model ${model.displayName}`);
      escalationAttempts += 1;
      continue;
    }

    try {
      const completion = await createChatCompletion({
        model,
        messages,
        maxOutputTokens: modelOutputLimit
      });
      const providerCost = completion.cost ?? estimateProviderCost({
        model,
        inputTokens: completion.inputTokens ?? estimatedInputTokens,
        outputTokens: completion.outputTokens ?? 0
      });

      await prisma.requestLog.create({
        data: {
          userId: request.userId,
          modelConfigId: model.id,
          status: RequestStatus.SUCCESS,
          requestedTier: request.requestedTier,
          selectedTier: tier,
          selectedModel: model.modelName,
          promptText,
          promptPreview,
          inputTokensEstimated: estimatedInputTokens,
          outputTokensLimit: modelOutputLimit,
          providerInputTokens: completion.inputTokens,
          providerOutputTokens: completion.outputTokens,
          providerTotalTokens: completion.totalTokens,
          providerCachedTokens: completion.cachedTokens,
          providerReasoningTokens: completion.reasoningTokens,
          providerCost,
          providerRawUsage: toPrismaJson(completion.rawUsage),
          escalationAttempts,
          errorCategory: ErrorCategory.NONE
        }
      });

      return {
        content: completion.content,
        selectedTier: tier,
        selectedModel: completion.rawModel ?? model.modelName,
        inputTokensEstimated: estimatedInputTokens,
        outputTokensLimit: modelOutputLimit,
        providerInputTokens: completion.inputTokens,
        providerOutputTokens: completion.outputTokens,
        providerTotalTokens: completion.totalTokens,
        providerCost,
        escalationAttempts
      };
    } catch (error) {
      lastError = error;

      if (!shouldEscalate(error)) {
        break;
      }

      escalationAttempts += 1;
    }
  }

  const message = lastError instanceof Error ? lastError.message : "Gateway request failed";

  await prisma.requestLog.create({
    data: {
      userId: request.userId,
      status: RequestStatus.FAILED,
      requestedTier: request.requestedTier,
      promptText,
      promptPreview,
      inputTokensEstimated: estimatedInputTokens,
      outputTokensLimit,
      escalationAttempts,
      errorCategory: ErrorCategory.PROVIDER,
      errorMessage: message
    }
  });

  throw new HttpError(502, message, "provider_failed");
}

async function logRejectedRequest(
  request: GatewayRequest,
  requestedTier: Tier,
  inputTokensEstimated: number,
  errorCategory: ErrorCategory,
  errorMessage: string
): Promise<void> {
  await prisma.requestLog.create({
    data: {
      userId: request.userId,
      status: RequestStatus.REJECTED,
      requestedTier,
      promptText: serializePrompt(request.messages),
      promptPreview: serializePrompt(request.messages).slice(0, 300),
      inputTokensEstimated,
      outputTokensLimit: request.maxOutputTokens ?? request.policy.maxOutputTokens,
      errorCategory,
      errorMessage
    }
  });
}

function serializePrompt(messages: ChatMessage[]): string {
  return messages.map((message) => `${message.role}: ${message.content}`).join("\n\n");
}

function toPrismaJson(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined) {
    return undefined;
  }

  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
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
