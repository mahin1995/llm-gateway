import { Router } from "express";
import { HttpError, sendError } from "../lib/http.js";

export const policyRouter = Router();

policyRouter.get("/me/policy", (req, res) => {
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
          },
          aliases: req.gateway.aliases.map((alias) => ({
            id: alias.id,
            alias: alias.alias,
            modelConfigId: alias.modelConfigId,
            modelDisplayName: alias.modelConfig.displayName,
            modelName: alias.modelConfig.modelName,
            enableOpenAI: alias.enableOpenAI,
            enableAnthropic: alias.enableAnthropic,
            active: alias.active
          }))
        }
      }
    });
  } catch (error) {
    sendError(res, error);
  }
});

function summarizeModel(model: {
  id: string;
  displayName: string;
  modelName: string;
  maxContextTokens: number;
  maxOutputTokens: number;
  provider: { name: string; baseUrl: string; active: boolean };
}): object {
  return {
    id: model.id,
    displayName: model.displayName,
    modelName: model.modelName,
    maxContextTokens: model.maxContextTokens,
    maxOutputTokens: model.maxOutputTokens,
    provider: {
      name: model.provider.name,
      baseUrl: model.provider.baseUrl,
      active: model.provider.active
    }
  };
}
