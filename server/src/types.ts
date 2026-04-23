import type {
  ModelConfig,
  PackageModelAlias,
  Provider,
  Tier,
  User,
  UserModelPolicy
} from "@prisma/client";

export type ChatRole = "system" | "user" | "assistant";
export type GatewayProtocol = "openai_chat" | "anthropic_messages";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface GatewayToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface GatewayToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface GatewayMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolCalls?: GatewayToolCall[];
}

export type ModelConfigWithProvider = ModelConfig & {
  provider: Provider;
};

export type PackageModelAliasWithModel = PackageModelAlias & {
  modelConfig: ModelConfigWithProvider;
};

export type GatewayPolicy = UserModelPolicy & {
  l1Model: ModelConfigWithProvider;
  l2Model: ModelConfigWithProvider | null;
  l3Model: ModelConfigWithProvider | null;
};

export interface AuthenticatedGatewayUser {
  id: string;
  email: string;
  name: string;
  maxTier: Tier;
  policy: GatewayPolicy;
}

export interface AuthenticatedRequestContext {
  user: User;
  policy: GatewayPolicy;
  aliases: PackageModelAliasWithModel[];
  apiKeyId?: string;
}

export interface GatewayRequestMetadata {
  incomingModel?: string;
  adapterWarnings?: string[];
}

export interface GatewayRequestSelection {
  requestedTier?: Tier;
  requestedModelAlias?: string;
}

export interface GatewayRequest {
  userId: string;
  policy: GatewayPolicy;
  aliases: PackageModelAliasWithModel[];
  clientProtocol: GatewayProtocol;
  messages: GatewayMessage[];
  tools?: GatewayToolDefinition[];
  toolChoice?: "auto" | "none" | { name: string };
  stream?: boolean;
  requestedTier?: Tier;
  requestedModelAlias?: string;
  maxOutputTokens?: number;
  metadata?: GatewayRequestMetadata;
}

export interface GatewayResponse {
  content: string;
  selectedTier: Tier | null;
  selectedModel: string;
  selectedModelId: string;
  resolvedModelAlias?: string;
  inputTokensEstimated: number;
  outputTokensLimit: number;
  providerInputTokens?: number;
  providerOutputTokens?: number;
  providerTotalTokens?: number;
  providerCost?: number;
  escalationAttempts: number;
  toolCalls?: GatewayToolCall[];
  rawProviderResponse?: Record<string, unknown>;
  adapterWarnings?: string[];
  usedDefaultSlot: boolean;
  usedTierOverride: boolean;
  usedAliasOverride: boolean;
}

declare global {
  namespace Express {
    interface Request {
      gateway?: AuthenticatedRequestContext;
    }
  }
}
