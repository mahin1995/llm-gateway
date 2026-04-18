import type { ModelConfigWithProvider, ChatMessage } from "../types.js";

export interface ProviderCompletionRequest {
  model: ModelConfigWithProvider;
  messages: ChatMessage[];
  maxOutputTokens: number;
}

export interface ProviderCompletionResponse {
  content: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedTokens?: number;
  reasoningTokens?: number;
  cost?: number;
  rawUsage?: Record<string, unknown>;
  rawModel?: string;
}

export class ProviderError extends Error {
  constructor(message: string, public readonly causeStatus?: number) {
    super(message);
  }
}

export async function createChatCompletion(request: ProviderCompletionRequest): Promise<ProviderCompletionResponse> {
  const provider = request.model.provider;
  const apiKey = process.env[provider.apiKeyEnvVar];

  if (!provider.active || !request.model.active) {
    throw new ProviderError("Provider or model is disabled");
  }

  if (!apiKey) {
    throw new ProviderError(`Missing provider API key environment variable: ${provider.apiKeyEnvVar}`);
  }

  const response = await fetch(`${provider.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "authorization": `Bearer ${apiKey}`,
      "content-type": "application/json",
      "http-referer": process.env.OPENROUTER_HTTP_REFERER ?? "http://localhost:3000",
      "x-title": process.env.OPENROUTER_APP_TITLE ?? "LLM Gateway"
    },
    body: JSON.stringify({
      model: request.model.modelName,
      messages: request.messages,
      max_tokens: request.maxOutputTokens
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new ProviderError(`Provider request failed: ${text || response.statusText}`, response.status);
  }

  const payload = await response.json() as {
    model?: string;
    choices?: Array<{ message?: { content?: string } }>;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
      cost?: number;
      prompt_tokens_details?: {
        cached_tokens?: number;
        cache_write_tokens?: number;
      };
      completion_tokens_details?: {
        reasoning_tokens?: number;
      };
    };
  };

  const content = payload.choices?.[0]?.message?.content;

  if (!content) {
    throw new ProviderError("Provider returned an empty response");
  }

  return {
    content,
    inputTokens: payload.usage?.prompt_tokens,
    outputTokens: payload.usage?.completion_tokens,
    totalTokens: payload.usage?.total_tokens,
    cachedTokens: payload.usage?.prompt_tokens_details?.cached_tokens,
    reasoningTokens: payload.usage?.completion_tokens_details?.reasoning_tokens,
    cost: payload.usage?.cost,
    rawUsage: payload.usage,
    rawModel: payload.model
  };
}
