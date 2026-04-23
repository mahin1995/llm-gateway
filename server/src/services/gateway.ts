import { ErrorCategory, RequestStatus, Tier } from "@prisma/client";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { HttpError } from "../lib/http.js";
import { logError, logInfo, logWarn } from "../lib/logger.js";
import { estimateTextTokens } from "../lib/tokens.js";
import { isTierAllowed, tierSequence } from "../lib/tiers.js";
import {
  createAnthropicMessageCompletion,
  createOpenAIChatCompletion,
  ProviderError
} from "./provider.js";
import type {
  GatewayRequest,
  GatewayResponse,
  GatewayProtocol,
  ModelConfigWithProvider,
  PackageModelAliasWithModel
} from "../types.js";

function modelForTier(request: GatewayRequest, tier: Tier): ModelConfigWithProvider | null {
  if (tier === Tier.L1) return request.policy.l1Model;
  if (tier === Tier.L2) return request.policy.l2Model;
  return request.policy.l3Model;
}

function shouldEscalate(error: unknown): boolean {
  return error instanceof ProviderError;
}

function normalizePositiveLimit(limit: number | null | undefined): number | null {
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) {
    return null;
  }

  return limit;
}

function resolveLoggedOutputTokensLimit(request: GatewayRequest): number {
  return normalizePositiveLimit(request.maxOutputTokens)
    ?? normalizePositiveLimit(request.policy.maxOutputTokens)
    ?? 0;
}

function resolveAttemptOutputTokensLimit(request: GatewayRequest, model: ModelConfigWithProvider): number {
  const limits = [
    normalizePositiveLimit(request.maxOutputTokens),
    normalizePositiveLimit(request.policy.maxOutputTokens),
    normalizePositiveLimit(model.maxOutputTokens)
  ].filter((limit): limit is number => limit !== null);

  const resolvedLimit = Math.min(...limits);

  if (!Number.isFinite(resolvedLimit) || resolvedLimit < 1) {
    throw new HttpError(400, "Output token limit must be positive", "invalid_output_limit");
  }

  return resolvedLimit;
}

export async function executeGatewayRequest(request: GatewayRequest): Promise<GatewayResponse> {
  if (request.policy.cacheEnabled) {
    throw new HttpError(501, "Cache is enabled in policy but cache service is not configured", "cache_not_configured");
  }

  if (request.policy.ragEnabled) {
    throw new HttpError(501, "RAG is enabled in policy but RAG service is not configured", "rag_not_configured");
  }

  const promptText = serializePrompt(request);
  const promptPreview = promptText.slice(0, 300);
  const inputTokensEstimated = estimateTextTokens(promptText);
  const adapterWarnings = request.metadata?.adapterWarnings ?? [];
  const requestedTools = Boolean(request.tools?.length);
  const streamRequested = Boolean(request.stream);
  const inputTokensLimit = normalizePositiveLimit(request.policy.maxInputTokens);
  let outputTokensLimit = resolveLoggedOutputTokensLimit(request);

  if (inputTokensLimit !== null && inputTokensEstimated > inputTokensLimit) {
    await logRejectedRequest(request, {
      inputTokensEstimated,
      outputTokensLimit,
      errorCategory: ErrorCategory.TOKEN_LIMIT,
      errorMessage: "Input token limit exceeded"
    });
    throw new HttpError(413, "Input token limit exceeded", "input_token_limit");
  }

  const aliasMatch = request.requestedModelAlias
    ? resolveAlias(request.aliases, request.requestedModelAlias, request.clientProtocol)
    : null;

  const directModelMatch = request.requestedModelAlias
    ? resolvePackageSlotModel(request, request.requestedModelAlias)
    : null;

  if (request.requestedModelAlias && !aliasMatch && !directModelMatch) {
    throw new HttpError(400, "Unknown or unsupported model alias", "unknown_model_override");
  }

  const resolvedAlias = aliasMatch;

  const requestedTier = request.requestedTier;
  const startTier = requestedTier ?? Tier.L1;
  const usedExplicitModelOverride = Boolean(aliasMatch || directModelMatch);
  const usedAliasOverride = Boolean(aliasMatch);
  const usedTierOverride = !usedExplicitModelOverride && Boolean(requestedTier);
  const usedDefaultSlot = !usedExplicitModelOverride && !usedTierOverride;

  logInfo("gateway", "request received", {
    userId: request.userId,
    protocol: request.clientProtocol,
    incomingModel: request.metadata?.incomingModel,
    requestedTier,
    requestedAlias: request.requestedModelAlias,
    maxTier: request.policy.maxTier,
    requestedTools,
    streamRequested
  });

  if (!usedExplicitModelOverride && !isTierAllowed(startTier, request.policy.maxTier)) {
    throw new HttpError(403, `Requested tier ${startTier} exceeds allowed tier ${request.policy.maxTier}`, "tier_not_allowed");
  }

  const attemptModels = aliasMatch
    ? [{
        tier: inferSelectedTier(request, resolvedAlias!.modelConfig.id),
        alias: resolvedAlias!.alias,
        model: resolvedAlias!.modelConfig
      }]
    : directModelMatch
      ? [{
          tier: inferSelectedTier(request, directModelMatch.id),
          alias: undefined,
          model: directModelMatch
        }]
    : tierSequence(startTier, request.policy.maxTier).map((tier) => ({
        tier,
        alias: undefined,
        model: modelForTier(request, tier)
      }));

  let lastError: unknown;
  let escalationAttempts = 0;

  for (const attempt of attemptModels) {
    const model = attempt.model;

    if (!model) {
      escalationAttempts += 1;
      continue;
    }

    validateModelCapabilities({
      model,
      protocol: request.clientProtocol,
      requestedTools,
      streamRequested
    });

    outputTokensLimit = resolveAttemptOutputTokensLimit(request, model);

    if (inputTokensEstimated + outputTokensLimit > model.maxContextTokens) {
      lastError = new ProviderError(`Context limit exceeded for model ${model.displayName}`);
      escalationAttempts += 1;
      continue;
    }

    logInfo("gateway", "attempting model", {
      userId: request.userId,
      protocol: request.clientProtocol,
      tier: attempt.tier,
      alias: attempt.alias,
      model: model.modelName,
      requestedTools,
      streamRequested
    });

    try {
      const completion = await executeProviderRequest(request, model, outputTokensLimit);
      const providerCost = completion.cost ?? estimateProviderCost({
        model,
        inputTokens: completion.inputTokens ?? inputTokensEstimated,
        outputTokens: completion.outputTokens ?? 0
      });

      await prisma.requestLog.create({
        data: {
          userId: request.userId,
          modelConfigId: model.id,
          status: RequestStatus.SUCCESS,
          requestedTier,
          selectedTier: attempt.tier,
          selectedModel: model.modelName,
          clientProtocol: request.clientProtocol,
          requestedModelAlias: request.requestedModelAlias,
          resolvedModelAlias: attempt.alias,
          resolvedConfiguredModelId: model.id,
          usedDefaultSlot,
          usedTierOverride,
          usedAliasOverride,
          requestedTools,
          streamRequested,
          adapterWarnings: toPrismaJson(adapterWarnings),
          promptText,
          promptPreview,
          inputTokensEstimated,
          outputTokensLimit,
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

      logInfo("gateway", "request completed", {
        userId: request.userId,
        protocol: request.clientProtocol,
        alias: attempt.alias,
        selectedTier: attempt.tier,
        selectedModel: completion.rawModel ?? model.modelName,
        requestedTools,
        streamRequested,
        providerCost
      });

      return {
        content: completion.content,
        selectedTier: attempt.tier ?? null,
        selectedModel: completion.rawModel ?? model.modelName,
        selectedModelId: model.id,
        resolvedModelAlias: attempt.alias,
        inputTokensEstimated,
        outputTokensLimit,
        providerInputTokens: completion.inputTokens,
        providerOutputTokens: completion.outputTokens,
        providerTotalTokens: completion.totalTokens,
        providerCost,
        escalationAttempts,
        toolCalls: completion.toolCalls,
        rawProviderResponse: completion.rawResponse,
        adapterWarnings,
        usedDefaultSlot,
        usedTierOverride,
        usedAliasOverride
      };
    } catch (error) {
      lastError = error;
      if (!shouldEscalate(error) || usedExplicitModelOverride) {
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
      requestedTier,
      clientProtocol: request.clientProtocol,
      requestedModelAlias: request.requestedModelAlias,
      usedDefaultSlot,
      usedTierOverride,
      usedAliasOverride,
      requestedTools,
      streamRequested,
      adapterWarnings: toPrismaJson(adapterWarnings),
      promptText,
      promptPreview,
      inputTokensEstimated,
      outputTokensLimit,
      escalationAttempts,
      errorCategory: ErrorCategory.PROVIDER,
      errorMessage: message
    }
  });

  logError("gateway", "request failed", {
    userId: request.userId,
    protocol: request.clientProtocol,
    alias: request.requestedModelAlias,
    requestedTier,
    error: message
  });

  throw new HttpError(502, message, "provider_failed");
}

function resolveAlias(
  aliases: PackageModelAliasWithModel[],
  alias: string,
  protocol: GatewayProtocol
): PackageModelAliasWithModel | null {
  const normalizedAlias = alias.trim().toLowerCase();

  return aliases.find((entry) => (
    entry.active
    && (
      entry.alias.toLowerCase() === normalizedAlias
      || entry.modelConfig.modelName.toLowerCase() === normalizedAlias
    )
    && protocolAllowedForAlias(entry, protocol)
  )) ?? null;
}

function protocolAllowedForAlias(alias: PackageModelAliasWithModel, protocol: GatewayProtocol): boolean {
  return protocol === "openai_chat" ? alias.enableOpenAI : alias.enableAnthropic;
}

function resolvePackageSlotModel(
  request: GatewayRequest,
  requestedModelName: string
): ModelConfigWithProvider | null {
  const normalizedModelName = requestedModelName.trim().toLowerCase();

  return tierSequence(Tier.L1, request.policy.maxTier)
    .map((tier) => modelForTier(request, tier))
    .find((model) => model?.modelName.toLowerCase() === normalizedModelName) ?? null;
}

function inferSelectedTier(request: GatewayRequest, modelId: string): Tier | null {
  if (request.policy.l1Model.id === modelId) return Tier.L1;
  if (request.policy.l2Model?.id === modelId) return Tier.L2;
  if (request.policy.l3Model?.id === modelId) return Tier.L3;
  return null;
}

function validateModelCapabilities(input: {
  model: ModelConfigWithProvider;
  protocol: GatewayProtocol;
  requestedTools: boolean;
  streamRequested: boolean;
}): void {
  if (input.protocol === "openai_chat" && !input.model.supportsOpenAIChat) {
    throw new HttpError(400, "Selected model does not support OpenAI chat compatibility", "unsupported_model_capability");
  }

  if (input.protocol === "anthropic_messages" && !input.model.supportsAnthropicMessages) {
    throw new HttpError(400, "Selected model does not support Anthropic messages compatibility", "unsupported_model_capability");
  }

  if (input.requestedTools && !input.model.supportsTools) {
    throw new HttpError(400, "Selected model does not support tools", "unsupported_model_capability");
  }

  if (input.streamRequested && !input.model.supportsStreaming) {
    throw new HttpError(400, "Selected model does not support streaming", "unsupported_model_capability");
  }
}

async function executeProviderRequest(
  request: GatewayRequest,
  model: ModelConfigWithProvider,
  outputTokensLimit: number
) {
  if (request.clientProtocol === "anthropic_messages") {
    return createAnthropicMessageCompletion({
      model,
      messages: request.messages,
      maxOutputTokens: outputTokensLimit,
      tools: request.tools,
      toolChoice: request.toolChoice
    });
  }

  return createOpenAIChatCompletion({
    model,
    messages: request.messages,
    maxOutputTokens: outputTokensLimit,
    tools: request.tools,
    toolChoice: request.toolChoice
  });
}

async function logRejectedRequest(
  request: GatewayRequest,
  input: {
    inputTokensEstimated: number;
    outputTokensLimit: number;
    errorCategory: ErrorCategory;
    errorMessage: string;
  }
): Promise<void> {
  await prisma.requestLog.create({
    data: {
      userId: request.userId,
      status: RequestStatus.REJECTED,
      requestedTier: request.requestedTier,
      clientProtocol: request.clientProtocol,
      requestedModelAlias: request.requestedModelAlias,
      usedDefaultSlot: !request.requestedTier && !request.requestedModelAlias,
      usedTierOverride: Boolean(request.requestedTier),
      usedAliasOverride: Boolean(request.requestedModelAlias),
      requestedTools: Boolean(request.tools?.length),
      streamRequested: Boolean(request.stream),
      adapterWarnings: toPrismaJson(request.metadata?.adapterWarnings ?? []),
      promptText: serializePrompt(request),
      promptPreview: serializePrompt(request).slice(0, 300),
      inputTokensEstimated: input.inputTokensEstimated,
      outputTokensLimit: input.outputTokensLimit,
      errorCategory: input.errorCategory,
      errorMessage: input.errorMessage
    }
  });
}

function serializePrompt(request: GatewayRequest): string {
  return request.messages
    .map((message) => {
      const suffix = message.toolCalls?.length
        ? ` [tool_calls=${message.toolCalls.map((toolCall) => toolCall.name).join(",")}]`
        : "";
      return `${message.role}: ${message.content}${suffix}`;
    })
    .join("\n\n");
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
