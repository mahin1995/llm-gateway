import "dotenv/config";
import { PrismaClient, Tier } from "@prisma/client";
import { hashApiKey } from "../server/src/lib/hash.js";
import { hashPassword } from "../server/src/lib/password.js";

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const provider = await prisma.provider.upsert({
    where: { name: "openrouter" },
    create: {
      name: "openrouter",
      baseUrl: process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
      apiKeyEnvVar: "OPENROUTER_API_KEY",
      active: true
    },
    update: {
      baseUrl: process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
      apiKeyEnvVar: "OPENROUTER_API_KEY",
      active: true
    }
  });

  const l1 = await upsertModel(provider.id, {
    displayName: "OpenRouter L1 Small",
    modelName: "openai/gpt-4o-mini",
    tier: Tier.L1,
    maxContextTokens: 128000,
    maxOutputTokens: 4096,
    inputCostPer1M: "0.1500",
    outputCostPer1M: "0.6000"
  });

  const l2 = await upsertModel(provider.id, {
    displayName: "OpenRouter L2 Balanced",
    modelName: "anthropic/claude-3.5-sonnet",
    tier: Tier.L2,
    maxContextTokens: 200000,
    maxOutputTokens: 8192,
    inputCostPer1M: "3.0000",
    outputCostPer1M: "15.0000"
  });

  const l3 = await upsertModel(provider.id, {
    displayName: "OpenRouter L3 Large",
    modelName: "openai/gpt-4o",
    tier: Tier.L3,
    maxContextTokens: 128000,
    maxOutputTokens: 8192,
    inputCostPer1M: "2.5000",
    outputCostPer1M: "10.0000"
  });

  const user = await prisma.user.upsert({
    where: { email: "admin@example.local" },
    create: {
      email: "admin@example.local",
      name: "Local Admin",
      passwordHash: await hashPassword(process.env.DEV_ADMIN_PASSWORD ?? "admin12345"),
      isAdmin: true
    },
    update: {
      name: "Local Admin",
      passwordHash: await hashPassword(process.env.DEV_ADMIN_PASSWORD ?? "admin12345"),
      isAdmin: true
    }
  });

  const adminPackage = await prisma.package.upsert({
    where: { name: "Admin Full Access" },
    create: {
      name: "Admin Full Access",
      description: "Full local development package with L1, L2, and L3 enabled.",
      maxTier: Tier.L3,
      maxInputTokens: 24000,
      maxOutputTokens: 2048,
      maxRagTokens: 0,
      truncateInput: false,
      cacheEnabled: false,
      ragEnabled: false,
      l1ModelId: l1.id,
      l2ModelId: l2.id,
      l3ModelId: l3.id
    },
    update: {
      description: "Full local development package with L1, L2, and L3 enabled.",
      maxTier: Tier.L3,
      maxInputTokens: 24000,
      maxOutputTokens: 2048,
      maxRagTokens: 0,
      truncateInput: false,
      cacheEnabled: false,
      ragEnabled: false,
      active: true,
      l1ModelId: l1.id,
      l2ModelId: l2.id,
      l3ModelId: l3.id
    }
  });

  await prisma.package.upsert({
    where: { name: "Starter" },
    create: {
      name: "Starter",
      description: "Starter package with L1 and L2 enabled.",
      maxTier: Tier.L2,
      maxInputTokens: 12000,
      maxOutputTokens: 1024,
      maxRagTokens: 0,
      truncateInput: false,
      cacheEnabled: false,
      ragEnabled: false,
      l1ModelId: l1.id,
      l2ModelId: l2.id
    },
    update: {
      description: "Starter package with L1 and L2 enabled.",
      maxTier: Tier.L2,
      maxInputTokens: 12000,
      maxOutputTokens: 1024,
      maxRagTokens: 0,
      truncateInput: false,
      cacheEnabled: false,
      ragEnabled: false,
      active: true,
      l1ModelId: l1.id,
      l2ModelId: l2.id,
      l3ModelId: null
    }
  });

  await prisma.userModelPolicy.upsert({
    where: { userId: user.id },
    create: {
      userId: user.id,
      maxTier: Tier.L3,
      maxInputTokens: 24000,
      maxOutputTokens: 2048,
      maxRagTokens: 0,
      truncateInput: false,
      cacheEnabled: false,
      ragEnabled: false,
      l1ModelId: l1.id,
      l2ModelId: l2.id,
      l3ModelId: l3.id
    },
    update: {
      maxTier: Tier.L3,
      maxInputTokens: 24000,
      maxOutputTokens: 2048,
      maxRagTokens: 0,
      truncateInput: false,
      cacheEnabled: false,
      ragEnabled: false,
      l1ModelId: l1.id,
      l2ModelId: l2.id,
      l3ModelId: l3.id
    }
  });

  await prisma.user.update({
    where: { id: user.id },
    data: { packageId: adminPackage.id }
  });

  const gatewayApiKey = process.env.DEV_GATEWAY_API_KEY ?? "lgw_dev_key";

  await prisma.apiKey.upsert({
    where: { keyHash: hashApiKey(gatewayApiKey) },
    create: {
      name: "Local development key",
      keyHash: hashApiKey(gatewayApiKey),
      userId: user.id
    },
    update: {
      name: "Local development key",
      userId: user.id
    }
  });

  console.log("Seed complete");
  console.log("Dashboard login: admin@example.local");
  console.log(`Dashboard password: ${process.env.DEV_ADMIN_PASSWORD ?? "admin12345"}`);
  console.log(`Local gateway API key: ${gatewayApiKey}`);
}

async function upsertModel(
  providerId: string,
  data: {
    displayName: string;
    modelName: string;
    tier: Tier;
    maxContextTokens: number;
    maxOutputTokens: number;
    inputCostPer1M: string;
    outputCostPer1M: string;
  }
) {
  return prisma.modelConfig.upsert({
    where: {
      providerId_modelName: {
        providerId,
        modelName: data.modelName
      }
    },
    create: {
      providerId,
      ...data,
      active: true
    },
    update: {
      ...data,
      active: true
    }
  });
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
