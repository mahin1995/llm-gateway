CREATE TABLE "OpenRouterModel" (
    "id" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "name" TEXT,
    "description" TEXT,
    "contextLength" INTEGER,
    "inputCostPer1M" DECIMAL(18,8),
    "outputCostPer1M" DECIMAL(18,8),
    "tokenizer" TEXT,
    "modality" TEXT,
    "openRouterCreatedAt" TIMESTAMP(3),
    "raw" JSONB NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OpenRouterModel_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OpenRouterModel_modelId_key" ON "OpenRouterModel"("modelId");
