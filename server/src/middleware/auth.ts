import { ApiKeyStatus, Tier, UserStatus } from "@prisma/client";
import type { User } from "@prisma/client";
import type { NextFunction, Request, Response } from "express";
import { prisma } from "../db.js";
import { hashApiKey } from "../lib/hash.js";
import { HttpError, sendError } from "../lib/http.js";
import { verifySessionToken } from "../lib/session.js";
import type { GatewayPolicy, PackageModelAliasWithModel } from "../types.js";

export async function authenticateGatewayKey(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const header = req.header("authorization");
    const [, bearerToken] = header?.match(/^Bearer\s+(.+)$/i) ?? [];
    const token = bearerToken ?? req.header("x-api-key");

    if (!token) {
      throw new HttpError(401, "Missing bearer API key", "auth_missing");
    }

    const apiKey = await prisma.apiKey.findUnique({
      where: { keyHash: hashApiKey(token) },
      include: {
        user: true
      }
    });

    if (!apiKey || apiKey.status !== ApiKeyStatus.ACTIVE) {
      throw new HttpError(401, "Invalid API key", "auth_invalid");
    }

    const context = await loadEffectiveGatewayContext(apiKey.user.id);

    if (!context) {
      throw new HttpError(403, "User is not allowed to use the gateway", "auth_forbidden");
    }

    await prisma.apiKey.update({
      where: { id: apiKey.id },
      data: { lastUsedAt: new Date() }
    });

    req.gateway = {
      user: context.user,
      policy: context.policy,
      aliases: context.aliases,
      apiKeyId: apiKey.id
    };

    next();
  } catch (error) {
    sendError(res, error);
  }
}

export async function authenticateSession(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const header = req.header("authorization");
    const [, token] = header?.match(/^Bearer\s+(.+)$/i) ?? [];

    if (!token) {
      throw new HttpError(401, "Missing session token", "session_missing");
    }

    const payload = verifySessionToken(token);

    if (!payload) {
      throw new HttpError(401, "Invalid or expired session", "session_invalid");
    }

    const context = await loadEffectiveGatewayContext(payload.sub);

    if (!context) {
      throw new HttpError(403, "User is not allowed to use the dashboard", "session_forbidden");
    }

    req.gateway = {
      user: context.user,
      policy: context.policy,
      aliases: context.aliases
    };

    next();
  } catch (error) {
    sendError(res, error);
  }
}

async function loadEffectiveGatewayContext(userId: string): Promise<{ user: User; policy: GatewayPolicy; aliases: PackageModelAliasWithModel[] } | null> {
  const loaded = await loadUserWithRelations(userId);

  if (!loaded.user || loaded.user.status !== UserStatus.ACTIVE) {
    return null;
  }

  if (loaded.user.package && loaded.user.package.active && needsPolicySync(loaded.user.policy, loaded.user.package)) {
    await prisma.userModelPolicy.upsert({
      where: { userId: loaded.user.id },
      create: {
        userId: loaded.user.id,
        ...packagePolicyData(loaded.user.package)
      },
      update: packagePolicyData(loaded.user.package)
    });

    const refreshed = await loadUserWithRelations(userId);

    if (!refreshed.user?.policy) {
      return null;
    }

    return {
      user: refreshed.user,
      policy: refreshed.user.policy,
      aliases: refreshed.user.package?.aliases ?? []
    };
  }

  if (!loaded.user.policy) {
    return null;
  }

  return {
    user: loaded.user,
    policy: loaded.user.policy,
    aliases: loaded.user.package?.aliases ?? []
  };
}

async function loadUserWithRelations(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      package: {
        include: {
          l1Model: { include: { provider: true } },
          l2Model: { include: { provider: true } },
          l3Model: { include: { provider: true } },
          aliases: {
            include: {
              modelConfig: { include: { provider: true } }
            },
            orderBy: { alias: "asc" }
          }
        }
      },
      policy: {
        include: {
          l1Model: { include: { provider: true } },
          l2Model: { include: { provider: true } },
          l3Model: { include: { provider: true } }
        }
      }
    }
  });

  return { user };
}

function needsPolicySync(
  policy: {
    maxTier: Tier;
    maxInputTokens: number;
    maxOutputTokens: number;
    maxRagTokens: number;
    truncateInput: boolean;
    cacheEnabled: boolean;
    ragEnabled: boolean;
    l1ModelId: string;
    l2ModelId: string | null;
    l3ModelId: string | null;
  } | null,
  pkg: {
    maxTier: Tier;
    maxInputTokens: number;
    maxOutputTokens: number;
    maxRagTokens: number;
    truncateInput: boolean;
    cacheEnabled: boolean;
    ragEnabled: boolean;
    l1ModelId: string;
    l2ModelId: string | null;
    l3ModelId: string | null;
  }
): boolean {
  if (!policy) {
    return true;
  }

  return policy.maxTier !== pkg.maxTier
    || policy.maxInputTokens !== pkg.maxInputTokens
    || policy.maxOutputTokens !== pkg.maxOutputTokens
    || policy.maxRagTokens !== pkg.maxRagTokens
    || policy.truncateInput !== pkg.truncateInput
    || policy.cacheEnabled !== pkg.cacheEnabled
    || policy.ragEnabled !== pkg.ragEnabled
    || policy.l1ModelId !== pkg.l1ModelId
    || policy.l2ModelId !== pkg.l2ModelId
    || policy.l3ModelId !== pkg.l3ModelId;
}

function packagePolicyData(pkg: {
  maxTier: Tier;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxRagTokens: number;
  truncateInput: boolean;
  cacheEnabled: boolean;
  ragEnabled: boolean;
  l1ModelId: string;
  l2ModelId: string | null;
  l3ModelId: string | null;
}) {
  return {
    maxTier: pkg.maxTier,
    maxInputTokens: pkg.maxInputTokens,
    maxOutputTokens: pkg.maxOutputTokens,
    maxRagTokens: pkg.maxRagTokens,
    truncateInput: pkg.truncateInput,
    cacheEnabled: pkg.cacheEnabled,
    ragEnabled: pkg.ragEnabled,
    l1ModelId: pkg.l1ModelId,
    l2ModelId: pkg.l2ModelId,
    l3ModelId: pkg.l3ModelId
  };
}
