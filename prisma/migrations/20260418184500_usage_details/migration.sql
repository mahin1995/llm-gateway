ALTER TABLE "RequestLog" ADD COLUMN "providerCachedTokens" INTEGER;
ALTER TABLE "RequestLog" ADD COLUMN "providerReasoningTokens" INTEGER;
ALTER TABLE "RequestLog" ADD COLUMN "providerCost" DECIMAL(12,6);
ALTER TABLE "RequestLog" ADD COLUMN "providerRawUsage" JSONB;
