import "dotenv/config";
import { PrismaClient, Tier } from "@prisma/client";
import { createGatewayApiKey } from "../server/src/lib/api-key.js";
import { hashApiKey } from "../server/src/lib/hash.js";
import { hashPassword } from "../server/src/lib/password.js";

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const email = process.env.DUMMY_USER_EMAIL ?? `dummy-${Date.now()}@example.local`;
  const name = process.env.DUMMY_USER_NAME ?? "Dummy User";
  const password = process.env.DUMMY_USER_PASSWORD ?? "dummy12345";
  const maxTier = parseTier(process.env.DUMMY_USER_MAX_TIER ?? "L2");
  const apiKeyName = process.env.DUMMY_API_KEY_NAME ?? "Dummy user key";
  const gatewayApiKey = process.env.DUMMY_GATEWAY_API_KEY ?? createGatewayApiKey();
  const packageName = process.env.DUMMY_PACKAGE_NAME ?? "Starter";

  const models = await prisma.modelConfig.findMany({
    where: {
      active: true,
      provider: {
        name: "openrouter",
        active: true
      }
    },
    orderBy: {
      tier: "asc"
    }
  });

  const l1 = models.find((model) => model.tier === Tier.L1);
  const l2 = models.find((model) => model.tier === Tier.L2);
  const l3 = models.find((model) => model.tier === Tier.L3);

  if (!l1) {
    throw new Error("No active L1 model found. Run npm run prisma:seed first.");
  }

  const pkg = await prisma.package.findUnique({
    where: { name: packageName }
  });

  if (!pkg) {
    throw new Error(`Package "${packageName}" was not found. Run npm run prisma:seed first.`);
  }

  const user = await prisma.user.upsert({
    where: { email },
    create: {
      email,
      name,
      passwordHash: await hashPassword(password),
      isAdmin: false,
      packageId: pkg.id
    },
    update: {
      name,
      passwordHash: await hashPassword(password),
      isAdmin: false,
      packageId: pkg.id
    }
  });

  await prisma.userModelPolicy.upsert({
    where: { userId: user.id },
    create: {
      userId: user.id,
      maxTier,
      maxInputTokens: readIntEnv("DUMMY_MAX_INPUT_TOKENS", 12000),
      maxOutputTokens: readIntEnv("DUMMY_MAX_OUTPUT_TOKENS", 1024),
      maxRagTokens: readIntEnv("DUMMY_MAX_RAG_TOKENS", 0),
      truncateInput: readBoolEnv("DUMMY_TRUNCATE_INPUT", false),
      cacheEnabled: false,
      ragEnabled: false,
      l1ModelId: l1.id,
      l2ModelId: l2?.id,
      l3ModelId: l3?.id
    },
    update: {
      maxTier,
      maxInputTokens: readIntEnv("DUMMY_MAX_INPUT_TOKENS", 12000),
      maxOutputTokens: readIntEnv("DUMMY_MAX_OUTPUT_TOKENS", 1024),
      maxRagTokens: readIntEnv("DUMMY_MAX_RAG_TOKENS", 0),
      truncateInput: readBoolEnv("DUMMY_TRUNCATE_INPUT", false),
      cacheEnabled: false,
      ragEnabled: false,
      l1ModelId: l1.id,
      l2ModelId: l2?.id,
      l3ModelId: l3?.id
    }
  });

  const apiKey = await prisma.apiKey.create({
    data: {
      name: apiKeyName,
      keyHash: hashApiKey(gatewayApiKey),
      userId: user.id
    }
  });

  console.log("Dummy user created");
  console.log(`Email: ${email}`);
  console.log(`Password: ${password}`);
  console.log(`Max tier: ${maxTier}`);
  console.log(`Package: ${packageName}`);
  console.log(`Gateway API key name: ${apiKey.name}`);
  console.log(`Gateway API key: ${gatewayApiKey}`);
  console.log("The plaintext gateway API key is shown only in this output.");
}

function parseTier(value: string): Tier {
  if (value === Tier.L1 || value === Tier.L2 || value === Tier.L3) {
    return value;
  }

  throw new Error("DUMMY_USER_MAX_TIER must be L1, L2, or L3.");
}

function readIntEnv(name: string, fallback: number): number {
  const value = process.env[name];

  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);

  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }

  return parsed;
}

function readBoolEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name];

  if (!value) {
    return fallback;
  }

  return value.toLowerCase() === "true" || value === "1";
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
