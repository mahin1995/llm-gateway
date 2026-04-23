import { Tier, UserStatus } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { hashPassword } from "../lib/password.js";
import { HttpError, sendError } from "../lib/http.js";
import { buildUsageSummary } from "../services/usage-summary.js";
import {
  getOpenRouterKey,
  listOpenRouterKeys,
  listOpenRouterModels,
  syncOpenRouterModels
} from "../services/openrouter-management.js";

export const adminRouter = Router();

const packageAliasSchema = z.object({
  alias: z.string().trim().min(1).max(80),
  modelConfigId: z.string().min(1),
  enableOpenAI: z.boolean().default(true),
  enableAnthropic: z.boolean().default(true),
  active: z.boolean().default(true)
});

const packageTokenLimitSchema = z.number().int().nonnegative().nullable().transform((value) => value ?? 0);

const packageSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(240).optional().nullable(),
  maxTier: z.nativeEnum(Tier),
  maxInputTokens: packageTokenLimitSchema,
  maxOutputTokens: packageTokenLimitSchema,
  maxRagTokens: packageTokenLimitSchema,
  truncateInput: z.boolean().default(false),
  cacheEnabled: z.boolean().default(false),
  ragEnabled: z.boolean().default(false),
  active: z.boolean().default(true),
  l1ModelId: z.string().min(1),
  l2ModelId: z.string().min(1).optional().nullable(),
  l3ModelId: z.string().min(1).optional().nullable(),
  aliases: z.array(packageAliasSchema).default([])
});

const createUserSchema = z.object({
  email: z.string().email(),
  name: z.string().trim().min(1).max(120),
  password: z.string().min(8),
  isAdmin: z.boolean().default(false),
  packageId: z.string().min(1)
});

const updateUserSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  password: z.string().min(8).optional(),
  isAdmin: z.boolean().optional(),
  status: z.nativeEnum(UserStatus).optional(),
  packageId: z.string().min(1).optional()
});

const modelSchema = z.object({
  providerId: z.string().min(1),
  displayName: z.string().trim().min(1).max(120),
  modelName: z.string().trim().min(1).max(160),
  tier: z.nativeEnum(Tier),
  maxContextTokens: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
  inputCostPer1M: z.number().nonnegative().optional().nullable(),
  outputCostPer1M: z.number().nonnegative().optional().nullable(),
  supportsOpenAIChat: z.boolean().default(true),
  supportsAnthropicMessages: z.boolean().default(true),
  supportsTools: z.boolean().default(true),
  supportsStreaming: z.boolean().default(true),
  active: z.boolean().default(true)
});

const updateModelSchema = modelSchema.partial();

adminRouter.get("/dashboard", async (_req, res) => {
  try {
    const [users, providers, packages, requestLogs] = await Promise.all([
      prisma.user.findMany({
        include: {
          package: true,
          policy: {
            include: {
              l1Model: { include: { provider: true } },
              l2Model: { include: { provider: true } },
              l3Model: { include: { provider: true } }
            }
          },
          apiKeys: {
            select: {
              id: true,
              name: true,
              status: true,
              lastUsedAt: true,
              createdAt: true
            }
          }
        },
        orderBy: { createdAt: "desc" }
      }),
      prisma.provider.findMany({
        include: { models: { orderBy: [{ displayName: "asc" }] } },
        orderBy: { name: "asc" }
      }),
      prisma.package.findMany({
        include: {
          l1Model: true,
          l2Model: true,
          l3Model: true,
          aliases: {
            include: { modelConfig: true },
            orderBy: { alias: "asc" }
          },
          _count: { select: { users: true } }
        },
        orderBy: { createdAt: "desc" }
      }),
      prisma.requestLog.findMany({
        take: 25,
        orderBy: { createdAt: "desc" },
        include: {
          user: { select: { id: true, email: true, name: true } }
        }
      })
    ]);

    res.json({
      data: {
        users: users.map((user) => ({
          id: user.id,
          email: user.email,
          name: user.name,
          isAdmin: user.isAdmin,
          status: user.status,
          packageId: user.packageId,
          packageName: user.package?.name ?? null,
          apiKeys: user.apiKeys,
          policy: user.policy ? summarizePolicy(user.policy) : null
        })),
        providers: providers.map((provider) => ({
          id: provider.id,
          name: provider.name,
          baseUrl: provider.baseUrl,
          apiKeyEnvVar: provider.apiKeyEnvVar,
          active: provider.active,
          models: provider.models.map((model) => ({
            id: model.id,
            providerId: model.providerId,
            displayName: model.displayName,
            modelName: model.modelName,
            active: model.active,
            maxContextTokens: model.maxContextTokens,
            maxOutputTokens: model.maxOutputTokens,
            inputCostPer1M: model.inputCostPer1M?.toString() ?? null,
            outputCostPer1M: model.outputCostPer1M?.toString() ?? null,
            supportsOpenAIChat: model.supportsOpenAIChat,
            supportsAnthropicMessages: model.supportsAnthropicMessages,
            supportsTools: model.supportsTools,
            supportsStreaming: model.supportsStreaming
          }))
        })),
        packages: packages.map((pkg) => ({
          id: pkg.id,
          name: pkg.name,
          description: pkg.description,
          maxTier: pkg.maxTier,
          maxInputTokens: pkg.maxInputTokens,
          maxOutputTokens: pkg.maxOutputTokens,
          maxRagTokens: pkg.maxRagTokens,
          truncateInput: pkg.truncateInput,
          cacheEnabled: pkg.cacheEnabled,
          ragEnabled: pkg.ragEnabled,
          active: pkg.active,
          l1ModelId: pkg.l1ModelId,
          l2ModelId: pkg.l2ModelId,
          l3ModelId: pkg.l3ModelId,
          models: {
            L1: pkg.l1Model.displayName,
            L2: pkg.l2Model?.displayName ?? null,
            L3: pkg.l3Model?.displayName ?? null
          },
          aliases: pkg.aliases.map((alias) => serializePackageAlias(alias)),
          userCount: pkg._count.users
        })),
        requestLogs
      }
    });
  } catch (error) {
    sendError(res, error);
  }
});

adminRouter.get("/usage-summary", async (req, res) => {
  try {
    const summary = await buildUsageSummary({
      range: req.query.range
    });

    res.json({ data: summary });
  } catch (error) {
    sendError(res, error);
  }
});

adminRouter.get("/openrouter-keys", async (_req, res) => {
  try {
    const keys = await listOpenRouterKeys();
    res.json({ data: { keys } });
  } catch (error) {
    sendError(res, error);
  }
});

adminRouter.get("/openrouter-keys/:hash", async (req, res) => {
  try {
    const key = await getOpenRouterKey(req.params.hash);
    res.json({ data: { key } });
  } catch (error) {
    sendError(res, error);
  }
});

adminRouter.get("/openrouter-models", async (_req, res) => {
  try {
    const models = await listOpenRouterModels();
    res.json({ data: { models: models.map(serializeOpenRouterModel) } });
  } catch (error) {
    sendError(res, error);
  }
});

adminRouter.post("/openrouter-models/sync", async (_req, res) => {
  try {
    const models = await syncOpenRouterModels();
    res.json({ data: { models: models.map(serializeOpenRouterModel), count: models.length } });
  } catch (error) {
    sendError(res, error);
  }
});

adminRouter.post("/packages", async (req, res) => {
  try {
    const payload = packageSchema.parse(req.body);
    await validatePackageModels(payload);
    const pkg = await prisma.package.create({
      data: packageWriteData(payload),
      include: {
        aliases: {
          include: { modelConfig: true },
          orderBy: { alias: "asc" }
        }
      }
    });

    res.status(201).json({ data: { package: pkg } });
  } catch (error) {
    handleAdminError(res, error);
  }
});

adminRouter.patch("/packages/:id", async (req, res) => {
  try {
    const payload = packageSchema.partial().parse(req.body);
    const existing = await prisma.package.findUnique({ where: { id: req.params.id } });

    if (!existing) {
      throw new HttpError(404, "Package not found", "package_not_found");
    }

    const merged = {
      ...existing,
      ...payload,
      l2ModelId: payload.l2ModelId === undefined ? existing.l2ModelId : payload.l2ModelId || null,
      l3ModelId: payload.l3ModelId === undefined ? existing.l3ModelId : payload.l3ModelId || null,
      aliases: payload.aliases ?? undefined
    };
    await validatePackageModels(merged);

    const pkg = await prisma.package.update({
      where: { id: req.params.id },
      data: packageUpdateData(payload),
      include: {
        aliases: {
          include: { modelConfig: true },
          orderBy: { alias: "asc" }
        }
      }
    });

    await syncPackagePoliciesForAssignedUsers(pkg);

    res.json({ data: { package: pkg } });
  } catch (error) {
    handleAdminError(res, error);
  }
});

adminRouter.post("/users", async (req, res) => {
  try {
    const payload = createUserSchema.parse(req.body);
    const pkg = await getPackageOrThrow(payload.packageId);

    const user = await prisma.user.create({
      data: {
        email: payload.email,
        name: payload.name,
        passwordHash: await hashPassword(payload.password),
        isAdmin: payload.isAdmin,
        packageId: pkg.id
      }
    });

    await applyPackageToUser(user.id, pkg.id);

    res.status(201).json({ data: { user } });
  } catch (error) {
    handleAdminError(res, error);
  }
});

adminRouter.patch("/users/:id", async (req, res) => {
  try {
    const payload = updateUserSchema.parse(req.body);

    const user = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!user) {
      throw new HttpError(404, "User not found", "user_not_found");
    }

    const data: {
      name?: string;
      passwordHash?: string;
      isAdmin?: boolean;
      status?: UserStatus;
      packageId?: string;
    } = {};

    if (payload.name !== undefined) data.name = payload.name;
    if (payload.password !== undefined) data.passwordHash = await hashPassword(payload.password);
    if (payload.isAdmin !== undefined) data.isAdmin = payload.isAdmin;
    if (payload.status !== undefined) data.status = payload.status;

    if (payload.packageId !== undefined) {
      const pkg = await getPackageOrThrow(payload.packageId);
      data.packageId = pkg.id;
      await applyPackageToUser(user.id, pkg.id);
    }

    const updated = await prisma.user.update({
      where: { id: req.params.id },
      data
    });

    res.json({ data: { user: updated } });
  } catch (error) {
    handleAdminError(res, error);
  }
});

adminRouter.post("/models", async (req, res) => {
  try {
    const payload = modelSchema.parse(req.body);
    const model = await prisma.modelConfig.create({ data: payload });
    res.status(201).json({ data: { model } });
  } catch (error) {
    handleAdminError(res, error);
  }
});

adminRouter.patch("/models/:id", async (req, res) => {
  try {
    const payload = updateModelSchema.parse(req.body);
    const model = await prisma.modelConfig.update({
      where: { id: req.params.id },
      data: payload
    });
    res.json({ data: { model } });
  } catch (error) {
    handleAdminError(res, error);
  }
});

function summarizePolicy(policy: {
  maxTier: Tier;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxRagTokens: number;
  truncateInput: boolean;
  cacheEnabled: boolean;
  ragEnabled: boolean;
  l1Model: { displayName: string };
  l2Model: { displayName: string } | null;
  l3Model: { displayName: string } | null;
}) {
  return {
    maxTier: policy.maxTier,
    maxInputTokens: policy.maxInputTokens,
    maxOutputTokens: policy.maxOutputTokens,
    maxRagTokens: policy.maxRagTokens,
    truncateInput: policy.truncateInput,
    cacheEnabled: policy.cacheEnabled,
    ragEnabled: policy.ragEnabled,
    models: {
      L1: policy.l1Model.displayName,
      L2: policy.l2Model?.displayName ?? null,
      L3: policy.l3Model?.displayName ?? null
    },
    aliases: []
  };
}

function serializeOpenRouterModel(model: {
  id: string;
  modelId: string;
  name: string | null;
  description: string | null;
  contextLength: number | null;
  inputCostPer1M: { toString(): string } | null;
  outputCostPer1M: { toString(): string } | null;
  tokenizer: string | null;
  modality: string | null;
  openRouterCreatedAt: Date | null;
  syncedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: model.id,
    modelId: model.modelId,
    name: model.name,
    description: model.description,
    contextLength: model.contextLength,
    inputCostPer1M: model.inputCostPer1M?.toString() ?? null,
    outputCostPer1M: model.outputCostPer1M?.toString() ?? null,
    tokenizer: model.tokenizer,
    modality: model.modality,
    openRouterCreatedAt: model.openRouterCreatedAt?.toISOString() ?? null,
    syncedAt: model.syncedAt.toISOString(),
    createdAt: model.createdAt.toISOString(),
    updatedAt: model.updatedAt.toISOString()
  };
}

function serializePackageAlias(alias: {
  id: string;
  alias: string;
  modelConfigId: string;
  enableOpenAI: boolean;
  enableAnthropic: boolean;
  active: boolean;
  modelConfig: { displayName: string; modelName: string };
}) {
  return {
    id: alias.id,
    alias: alias.alias,
    modelConfigId: alias.modelConfigId,
    modelDisplayName: alias.modelConfig.displayName,
    modelName: alias.modelConfig.modelName,
    enableOpenAI: alias.enableOpenAI,
    enableAnthropic: alias.enableAnthropic,
    active: alias.active
  };
}

async function getPackageOrThrow(packageId: string) {
  const pkg = await prisma.package.findUnique({ where: { id: packageId } });

  if (!pkg || !pkg.active) {
    throw new HttpError(400, "Active package not found", "package_not_found");
  }

  return pkg;
}

async function applyPackageToUser(userId: string, packageId: string): Promise<void> {
  const pkg = await getPackageOrThrow(packageId);

  await prisma.userModelPolicy.upsert({
    where: { userId },
    create: {
      userId,
      ...packagePolicyData(pkg)
    },
    update: {
      ...packagePolicyData(pkg)
    }
  });
}

async function syncPackagePoliciesForAssignedUsers(pkg: {
  id: string;
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
}): Promise<void> {
  const users = await prisma.user.findMany({
    where: { packageId: pkg.id },
    select: { id: true }
  });

  if (users.length === 0) {
    return;
  }

  const data = packagePolicyData(pkg);

  await prisma.$transaction(
    users.map((user) => prisma.userModelPolicy.upsert({
      where: { userId: user.id },
      create: {
        userId: user.id,
        ...data
      },
      update: data
    }))
  );
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

function packageWriteData(payload: z.infer<typeof packageSchema>) {
  return {
    name: payload.name,
    description: payload.description || null,
    maxTier: payload.maxTier,
    maxInputTokens: payload.maxInputTokens,
    maxOutputTokens: payload.maxOutputTokens,
    maxRagTokens: payload.maxRagTokens,
    truncateInput: payload.truncateInput,
    cacheEnabled: payload.cacheEnabled,
    ragEnabled: payload.ragEnabled,
    active: payload.active,
    l1ModelId: payload.l1ModelId,
    l2ModelId: payload.l2ModelId || null,
    l3ModelId: payload.l3ModelId || null,
    aliases: {
      create: payload.aliases.map((alias) => ({
        alias: alias.alias.trim().toLowerCase(),
        modelConfigId: alias.modelConfigId,
        enableOpenAI: alias.enableOpenAI,
        enableAnthropic: alias.enableAnthropic,
        active: alias.active
      }))
    }
  };
}

function packageUpdateData(payload: Partial<z.infer<typeof packageSchema>>) {
  return {
    name: payload.name,
    description: payload.description === undefined ? undefined : payload.description || null,
    maxTier: payload.maxTier,
    maxInputTokens: payload.maxInputTokens,
    maxOutputTokens: payload.maxOutputTokens,
    maxRagTokens: payload.maxRagTokens,
    truncateInput: payload.truncateInput,
    cacheEnabled: payload.cacheEnabled,
    ragEnabled: payload.ragEnabled,
    active: payload.active,
    l1ModelId: payload.l1ModelId,
    l2ModelId: payload.l2ModelId === undefined ? undefined : payload.l2ModelId || null,
    l3ModelId: payload.l3ModelId === undefined ? undefined : payload.l3ModelId || null,
    aliases: payload.aliases === undefined ? undefined : {
      deleteMany: {},
      create: payload.aliases.map((alias) => ({
        alias: alias.alias.trim().toLowerCase(),
        modelConfigId: alias.modelConfigId,
        enableOpenAI: alias.enableOpenAI,
        enableAnthropic: alias.enableAnthropic,
        active: alias.active
      }))
    }
  };
}

async function validatePackageModels(payload: {
  maxTier: Tier;
  l1ModelId: string;
  l2ModelId?: string | null;
  l3ModelId?: string | null;
  aliases?: Array<z.infer<typeof packageAliasSchema>>;
}): Promise<void> {
  if (payload.maxTier !== Tier.L1 && !payload.l2ModelId) {
    throw new HttpError(400, "L2 model is required for L2/L3 packages", "package_model_required");
  }

  if (payload.maxTier === Tier.L3 && !payload.l3ModelId) {
    throw new HttpError(400, "L3 model is required for L3 packages", "package_model_required");
  }

  const requiredModelIds = [
    payload.l1ModelId,
    payload.l2ModelId ?? null,
    payload.l3ModelId ?? null
  ].filter((modelId): modelId is string => Boolean(modelId));

  const models = await prisma.modelConfig.findMany({
    where: {
      id: { in: requiredModelIds },
      active: true
    },
    select: {
      id: true
    }
  });

  if (models.length !== requiredModelIds.length) {
    throw new HttpError(400, "One or more selected models are inactive or missing", "model_not_found");
  }

  const aliases = payload.aliases ?? [];
  const normalizedAliases = aliases.map((alias) => alias.alias.trim().toLowerCase());
  const uniqueAliases = new Set(normalizedAliases);

  if (uniqueAliases.size !== normalizedAliases.length) {
    throw new HttpError(400, "Package aliases must be unique", "duplicate_model_alias");
  }
}

function handleAdminError(res: Parameters<typeof sendError>[0], error: unknown): void {
  if (error instanceof z.ZodError) {
    sendError(res, new HttpError(400, error.message, "invalid_admin_request"));
    return;
  }

  sendError(res, error);
}
