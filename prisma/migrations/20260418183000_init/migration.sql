-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Tier" AS ENUM ('L1', 'L2', 'L3');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "ApiKeyStatus" AS ENUM ('ACTIVE', 'REVOKED');

-- CreateEnum
CREATE TYPE "RequestStatus" AS ENUM ('SUCCESS', 'REJECTED', 'FAILED');

-- CreateEnum
CREATE TYPE "ErrorCategory" AS ENUM ('NONE', 'AUTH', 'POLICY', 'TOKEN_LIMIT', 'PROVIDER', 'INVALID_OUTPUT', 'QUALITY');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT,
    "isAdmin" BOOLEAN NOT NULL DEFAULT false,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiKey" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "status" "ApiKeyStatus" NOT NULL DEFAULT 'ACTIVE',
    "userId" TEXT NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Provider" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "apiKeyEnvVar" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Provider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModelConfig" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "modelName" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "tier" "Tier" NOT NULL,
    "maxContextTokens" INTEGER NOT NULL,
    "maxOutputTokens" INTEGER NOT NULL,
    "inputCostPer1M" DECIMAL(10,4),
    "outputCostPer1M" DECIMAL(10,4),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ModelConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserModelPolicy" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "maxTier" "Tier" NOT NULL DEFAULT 'L1',
    "maxInputTokens" INTEGER NOT NULL,
    "maxOutputTokens" INTEGER NOT NULL,
    "maxRagTokens" INTEGER NOT NULL,
    "truncateInput" BOOLEAN NOT NULL DEFAULT false,
    "cacheEnabled" BOOLEAN NOT NULL DEFAULT false,
    "ragEnabled" BOOLEAN NOT NULL DEFAULT false,
    "l1ModelId" TEXT NOT NULL,
    "l2ModelId" TEXT,
    "l3ModelId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserModelPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RequestLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "modelConfigId" TEXT,
    "status" "RequestStatus" NOT NULL,
    "requestedTier" "Tier",
    "selectedTier" "Tier",
    "selectedModel" TEXT,
    "promptText" TEXT,
    "promptPreview" TEXT,
    "inputTokensEstimated" INTEGER NOT NULL DEFAULT 0,
    "outputTokensLimit" INTEGER NOT NULL DEFAULT 0,
    "providerInputTokens" INTEGER,
    "providerOutputTokens" INTEGER,
    "providerTotalTokens" INTEGER,
    "escalationAttempts" INTEGER NOT NULL DEFAULT 0,
    "errorCategory" "ErrorCategory" NOT NULL DEFAULT 'NONE',
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RequestLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_keyHash_key" ON "ApiKey"("keyHash");

-- CreateIndex
CREATE UNIQUE INDEX "Provider_name_key" ON "Provider"("name");

-- CreateIndex
CREATE UNIQUE INDEX "ModelConfig_providerId_modelName_key" ON "ModelConfig"("providerId", "modelName");

-- CreateIndex
CREATE UNIQUE INDEX "UserModelPolicy_userId_key" ON "UserModelPolicy"("userId");

-- AddForeignKey
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModelConfig" ADD CONSTRAINT "ModelConfig_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserModelPolicy" ADD CONSTRAINT "UserModelPolicy_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserModelPolicy" ADD CONSTRAINT "UserModelPolicy_l1ModelId_fkey" FOREIGN KEY ("l1ModelId") REFERENCES "ModelConfig"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserModelPolicy" ADD CONSTRAINT "UserModelPolicy_l2ModelId_fkey" FOREIGN KEY ("l2ModelId") REFERENCES "ModelConfig"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserModelPolicy" ADD CONSTRAINT "UserModelPolicy_l3ModelId_fkey" FOREIGN KEY ("l3ModelId") REFERENCES "ModelConfig"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RequestLog" ADD CONSTRAINT "RequestLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RequestLog" ADD CONSTRAINT "RequestLog_modelConfigId_fkey" FOREIGN KEY ("modelConfigId") REFERENCES "ModelConfig"("id") ON DELETE SET NULL ON UPDATE CASCADE;
