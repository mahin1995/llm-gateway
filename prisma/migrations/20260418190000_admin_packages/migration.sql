CREATE TABLE "Package" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "maxTier" "Tier" NOT NULL DEFAULT 'L1',
    "maxInputTokens" INTEGER NOT NULL,
    "maxOutputTokens" INTEGER NOT NULL,
    "maxRagTokens" INTEGER NOT NULL,
    "truncateInput" BOOLEAN NOT NULL DEFAULT false,
    "cacheEnabled" BOOLEAN NOT NULL DEFAULT false,
    "ragEnabled" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "l1ModelId" TEXT NOT NULL,
    "l2ModelId" TEXT,
    "l3ModelId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Package_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "User" ADD COLUMN "packageId" TEXT;

CREATE UNIQUE INDEX "Package_name_key" ON "Package"("name");

ALTER TABLE "Package" ADD CONSTRAINT "Package_l1ModelId_fkey" FOREIGN KEY ("l1ModelId") REFERENCES "ModelConfig"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Package" ADD CONSTRAINT "Package_l2ModelId_fkey" FOREIGN KEY ("l2ModelId") REFERENCES "ModelConfig"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Package" ADD CONSTRAINT "Package_l3ModelId_fkey" FOREIGN KEY ("l3ModelId") REFERENCES "ModelConfig"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "User" ADD CONSTRAINT "User_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "Package"("id") ON DELETE SET NULL ON UPDATE CASCADE;
