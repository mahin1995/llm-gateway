ALTER TABLE "ModelConfig"
  ADD COLUMN "supportsOpenAIChat" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "supportsAnthropicMessages" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "supportsTools" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "supportsStreaming" BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE "PackageModelAlias" (
  "id" TEXT NOT NULL,
  "packageId" TEXT NOT NULL,
  "alias" TEXT NOT NULL,
  "modelConfigId" TEXT NOT NULL,
  "enableOpenAI" BOOLEAN NOT NULL DEFAULT true,
  "enableAnthropic" BOOLEAN NOT NULL DEFAULT true,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PackageModelAlias_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PackageModelAlias_packageId_alias_key" ON "PackageModelAlias"("packageId", "alias");

ALTER TABLE "PackageModelAlias"
  ADD CONSTRAINT "PackageModelAlias_packageId_fkey"
  FOREIGN KEY ("packageId") REFERENCES "Package"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PackageModelAlias"
  ADD CONSTRAINT "PackageModelAlias_modelConfigId_fkey"
  FOREIGN KEY ("modelConfigId") REFERENCES "ModelConfig"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "RequestLog"
  ADD COLUMN "clientProtocol" TEXT,
  ADD COLUMN "requestedModelAlias" TEXT,
  ADD COLUMN "resolvedModelAlias" TEXT,
  ADD COLUMN "resolvedConfiguredModelId" TEXT,
  ADD COLUMN "usedDefaultSlot" BOOLEAN,
  ADD COLUMN "usedTierOverride" BOOLEAN,
  ADD COLUMN "usedAliasOverride" BOOLEAN,
  ADD COLUMN "requestedTools" BOOLEAN,
  ADD COLUMN "streamRequested" BOOLEAN,
  ADD COLUMN "adapterWarnings" JSONB;
