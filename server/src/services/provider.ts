import { randomUUID } from "node:crypto";
import type {
  GatewayMessage,
  GatewayToolCall,
  GatewayToolDefinition,
  ModelConfigWithProvider
} from "../types.js";

export interface ProviderRequestBase {
  model: ModelConfigWithProvider;
  messages: GatewayMessage[];
  maxOutputTokens: number;
  tools?: GatewayToolDefinition[];
  toolChoice?: "auto" | "none" | { name: string };
}

export interface ProviderCompletionResponse {
  content: string;
  toolCalls?: GatewayToolCall[];
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedTokens?: number;
  reasoningTokens?: number;
  cost?: number;
  rawUsage?: Record<string, unknown>;
  rawModel?: string;
  rawResponse?: Record<string, unknown>;
}

export class ProviderError extends Error {
  constructor(message: string, public readonly causeStatus?: number) {
    super(message);
  }
}

export async function createOpenAIChatCompletion(
  request: ProviderRequestBase
): Promise<ProviderCompletionResponse> {
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
      messages: request.messages.map((message) => toOpenAIMessage(message)),
      tools: request.tools?.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema ?? { type: "object", properties: {} }
        }
      })),
      tool_choice: toOpenAIToolChoice(request.toolChoice),
      max_tokens: request.maxOutputTokens
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new ProviderError(`Provider request failed: ${text || response.statusText}`, response.status);
  }

  const payload = await response.json() as OpenAIProviderPayload;
  const choice = payload.choices?.[0];
  const content = normalizeOpenAIMessageContent(choice?.message?.content);
  const toolCalls = (choice?.message?.tool_calls ?? []).map((toolCall) => ({
    id: toolCall.id ?? `call_${randomUUID().replaceAll("-", "")}`,
    name: toolCall.function?.name ?? "tool",
    arguments: toolCall.function?.arguments ?? "{}"
  }));

  if (!content && toolCalls.length === 0) {
    throw new ProviderError("Provider returned an empty response");
  }

  return {
    content,
    toolCalls,
    inputTokens: payload.usage?.prompt_tokens,
    outputTokens: payload.usage?.completion_tokens,
    totalTokens: payload.usage?.total_tokens,
    cachedTokens: payload.usage?.prompt_tokens_details?.cached_tokens,
    reasoningTokens: payload.usage?.completion_tokens_details?.reasoning_tokens,
    cost: payload.usage?.cost,
    rawUsage: payload.usage,
    rawModel: payload.model,
    rawResponse: payload as Record<string, unknown>
  };
}

export async function createAnthropicMessageCompletion(
  request: ProviderRequestBase
): Promise<ProviderCompletionResponse> {
  const provider = request.model.provider;
  const apiKey = process.env[provider.apiKeyEnvVar];

  if (!provider.active || !request.model.active) {
    throw new ProviderError("Provider or model is disabled");
  }

  if (!apiKey) {
    throw new ProviderError(`Missing provider API key environment variable: ${provider.apiKeyEnvVar}`);
  }

  const systemMessages = request.messages
    .filter((message) => message.role === "system")
    .map((message) => message.content);
  const conversationalMessages = request.messages
    .filter((message) => message.role !== "system")
    .map((message) => toAnthropicMessage(message));

  const response = await fetch(`${provider.baseUrl.replace(/\/$/, "")}/messages`, {
    method: "POST",
    headers: {
      "authorization": `Bearer ${apiKey}`,
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "http-referer": process.env.OPENROUTER_HTTP_REFERER ?? "http://localhost:3000",
      "x-title": process.env.OPENROUTER_APP_TITLE ?? "LLM Gateway"
    },
    body: JSON.stringify({
      model: request.model.modelName,
      system: systemMessages.length ? systemMessages.join("\n\n") : undefined,
      messages: conversationalMessages,
      tools: request.tools?.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema ?? { type: "object", properties: {} }
      })),
      tool_choice: toAnthropicToolChoice(request.toolChoice),
      max_tokens: request.maxOutputTokens
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new ProviderError(`Provider request failed: ${text || response.statusText}`, response.status);
  }

  const payload = await response.json() as AnthropicProviderPayload;
  const content = extractAnthropicText(payload.content);
  const toolCalls = extractAnthropicToolCalls(payload.content);

  if (!content && toolCalls.length === 0) {
    throw new ProviderError("Provider returned an empty response");
  }

  return {
    content,
    toolCalls,
    inputTokens: payload.usage?.input_tokens,
    outputTokens: payload.usage?.output_tokens,
    totalTokens: sumAnthropicUsage(payload.usage),
    cachedTokens: payload.usage?.cache_read_input_tokens,
    cost: payload.usage?.cost,
    rawUsage: payload.usage,
    rawModel: payload.model,
    rawResponse: payload as Record<string, unknown>
  };
}

interface OpenAIProviderPayload {
  model?: string;
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
      tool_calls?: Array<{
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
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
}

interface AnthropicProviderPayload {
  id?: string;
  model?: string;
  content?: Array<Record<string, unknown>>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    cost?: number;
  };
}

function toOpenAIMessage(message: GatewayMessage): Record<string, unknown> {
  if (message.role === "tool") {
    return {
      role: "tool",
      content: message.content,
      tool_call_id: message.toolCallId
    };
  }

  if (message.role === "assistant" && message.toolCalls?.length) {
    return {
      role: "assistant",
      content: message.content || "",
      tool_calls: message.toolCalls.map((toolCall) => ({
        id: toolCall.id,
        type: "function",
        function: {
          name: toolCall.name,
          arguments: toolCall.arguments
        }
      }))
    };
  }

  return {
    role: message.role,
    content: message.content
  };
}

function toAnthropicMessage(message: GatewayMessage): Record<string, unknown> {
  if (message.role === "tool") {
    return {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: message.toolCallId,
        content: message.content
      }]
    };
  }

  if (message.role === "assistant" && message.toolCalls?.length) {
    return {
      role: "assistant",
      content: [
        ...(message.content ? [{ type: "text", text: message.content }] : []),
        ...message.toolCalls.map((toolCall) => ({
          type: "tool_use",
          id: toolCall.id,
          name: toolCall.name,
          input: safeJsonParse(toolCall.arguments)
        }))
      ]
    };
  }

  return {
    role: message.role,
    content: message.content
  };
}

function toOpenAIToolChoice(
  toolChoice?: "auto" | "none" | { name: string }
): "auto" | "none" | { type: "function"; function: { name: string } } | undefined {
  if (!toolChoice) {
    return undefined;
  }

  if (toolChoice === "auto" || toolChoice === "none") {
    return toolChoice;
  }

  return {
    type: "function",
    function: {
      name: toolChoice.name
    }
  };
}

function toAnthropicToolChoice(
  toolChoice?: "auto" | "none" | { name: string }
): Record<string, unknown> | undefined {
  if (!toolChoice || toolChoice === "auto") {
    return undefined;
  }

  if (toolChoice === "none") {
    return { type: "auto", disable_parallel_tool_use: true };
  }

  return {
    type: "tool",
    name: toolChoice.name
  };
}

function normalizeOpenAIMessageContent(
  content?: string | Array<{ type?: string; text?: string }>
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

function extractAnthropicText(content?: Array<Record<string, unknown>>): string {
  if (!content) {
    return "";
  }

  return content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => String(block.text))
    .join("");
}

function extractAnthropicToolCalls(content?: Array<Record<string, unknown>>): GatewayToolCall[] {
  if (!content) {
    return [];
  }

  return content
    .filter((block) => block.type === "tool_use")
    .map((block) => ({
      id: typeof block.id === "string" ? block.id : `call_${randomUUID().replaceAll("-", "")}`,
      name: typeof block.name === "string" ? block.name : "tool",
      arguments: JSON.stringify(block.input ?? {})
    }));
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function sumAnthropicUsage(usage?: {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}): number | undefined {
  if (!usage) {
    return undefined;
  }

  return (usage.input_tokens ?? 0)
    + (usage.output_tokens ?? 0)
    + (usage.cache_creation_input_tokens ?? 0)
    + (usage.cache_read_input_tokens ?? 0);
}
