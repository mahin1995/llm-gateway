import type { ModelConfig, Provider, Tier, User, UserModelPolicy } from "@prisma/client";

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export type ModelConfigWithProvider = ModelConfig & {
  provider: Provider;
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
  apiKeyId?: string;
}

declare global {
  namespace Express {
    interface Request {
      gateway?: AuthenticatedRequestContext;
    }
  }
}
