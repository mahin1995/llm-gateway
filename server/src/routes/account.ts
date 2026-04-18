import { ApiKeyStatus } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { createGatewayApiKey } from "../lib/api-key.js";
import { hashApiKey } from "../lib/hash.js";
import { HttpError, sendError } from "../lib/http.js";
import { buildUsageSummary } from "../services/usage-summary.js";

const createApiKeySchema = z.object({
  name: z.string().trim().min(1).max(80)
});

export const accountRouter = Router();

accountRouter.get("/me", (req, res) => {
  try {
    if (!req.gateway) {
      throw new HttpError(401, "Authentication required", "auth_required");
    }

    res.json({
      data: {
        user: {
          id: req.gateway.user.id,
          email: req.gateway.user.email,
          name: req.gateway.user.name,
          isAdmin: req.gateway.user.isAdmin,
          status: req.gateway.user.status
        }
      }
    });
  } catch (error) {
    sendError(res, error);
  }
});

accountRouter.get("/policy", (req, res) => {
  try {
    if (!req.gateway) {
      throw new HttpError(401, "Authentication required", "auth_required");
    }

    const { user, policy } = req.gateway;

    res.json({
      data: {
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          isAdmin: user.isAdmin,
          status: user.status
        },
        policy: {
          maxTier: policy.maxTier,
          maxInputTokens: policy.maxInputTokens,
          maxOutputTokens: policy.maxOutputTokens,
          maxRagTokens: policy.maxRagTokens,
          truncateInput: policy.truncateInput,
          cacheEnabled: policy.cacheEnabled,
          ragEnabled: policy.ragEnabled,
          models: {
            L1: summarizeModel(policy.l1Model),
            L2: policy.l2Model ? summarizeModel(policy.l2Model) : null,
            L3: policy.l3Model ? summarizeModel(policy.l3Model) : null
          }
        }
      }
    });
  } catch (error) {
    sendError(res, error);
  }
});

accountRouter.get("/api-keys", async (req, res) => {
  try {
    if (!req.gateway) {
      throw new HttpError(401, "Authentication required", "auth_required");
    }

    const apiKeys = await prisma.apiKey.findMany({
      where: { userId: req.gateway.user.id },
      select: {
        id: true,
        name: true,
        status: true,
        lastUsedAt: true,
        createdAt: true
      },
      orderBy: { createdAt: "desc" }
    });

    res.json({ data: { apiKeys } });
  } catch (error) {
    sendError(res, error);
  }
});

accountRouter.post("/api-keys", async (req, res) => {
  try {
    if (!req.gateway) {
      throw new HttpError(401, "Authentication required", "auth_required");
    }

    const payload = createApiKeySchema.parse(req.body);
    const apiKey = createGatewayApiKey();
    const record = await prisma.apiKey.create({
      data: {
        name: payload.name,
        keyHash: hashApiKey(apiKey),
        userId: req.gateway.user.id
      },
      select: {
        id: true,
        name: true,
        status: true,
        lastUsedAt: true,
        createdAt: true
      }
    });

    res.status(201).json({
      data: {
        apiKey,
        record
      }
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      sendError(res, new HttpError(400, error.message, "invalid_api_key_request"));
      return;
    }

    sendError(res, error);
  }
});

accountRouter.delete("/api-keys/:id", async (req, res) => {
  try {
    if (!req.gateway) {
      throw new HttpError(401, "Authentication required", "auth_required");
    }

    await prisma.apiKey.updateMany({
      where: {
        id: req.params.id,
        userId: req.gateway.user.id
      },
      data: {
        status: ApiKeyStatus.REVOKED
      }
    });

    res.status(204).send();
  } catch (error) {
    sendError(res, error);
  }
});

accountRouter.get("/request-logs", async (req, res) => {
  try {
    if (!req.gateway) {
      throw new HttpError(401, "Authentication required", "auth_required");
    }

    const requestLogs = await prisma.requestLog.findMany({
      where: { userId: req.gateway.user.id },
      take: 50,
      orderBy: { createdAt: "desc" }
    });

    res.json({ data: { requestLogs } });
  } catch (error) {
    sendError(res, error);
  }
});

accountRouter.get("/usage-summary", async (req, res) => {
  try {
    if (!req.gateway) {
      throw new HttpError(401, "Authentication required", "auth_required");
    }

    const summary = await buildUsageSummary({
      range: req.query.range,
      where: { userId: req.gateway.user.id }
    });

    res.json({ data: summary });
  } catch (error) {
    sendError(res, error);
  }
});

function summarizeModel(model: {
  id: string;
  displayName: string;
  modelName: string;
  tier: string;
  maxContextTokens: number;
  maxOutputTokens: number;
  provider: { name: string; baseUrl: string; active: boolean };
}): object {
  return {
    id: model.id,
    displayName: model.displayName,
    modelName: model.modelName,
    tier: model.tier,
    maxContextTokens: model.maxContextTokens,
    maxOutputTokens: model.maxOutputTokens,
    provider: {
      name: model.provider.name,
      baseUrl: model.provider.baseUrl,
      active: model.provider.active
    }
  };
}
