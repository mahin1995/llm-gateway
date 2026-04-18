import { Prisma } from "@prisma/client";
import { config } from "../config.js";
import { prisma } from "../db.js";
import { HttpError } from "../lib/http.js";

export interface OpenRouterKeySummary {
  byok_usage: number;
  byok_usage_daily: number;
  byok_usage_monthly: number;
  byok_usage_weekly: number;
  created_at: string;
  creator_user_id: string;
  disabled: boolean;
  hash: string;
  include_byok_in_limit: boolean;
  label: string | null;
  limit: number | null;
  limit_remaining: number | null;
  limit_reset: string | null;
  name: string;
  updated_at: string;
  usage: number;
  usage_daily: number;
  usage_monthly: number;
  usage_weekly: number;
  expires_at: string | null;
}

interface OpenRouterKeysResponse {
  data: OpenRouterKeySummary[];
}

interface OpenRouterKeyResponse {
  data?: OpenRouterKeySummary;
}

interface OpenRouterModelsResponse {
  data: OpenRouterModelApi[];
}

interface OpenRouterModelApi {
  id: string;
  name?: string;
  description?: string;
  created?: number;
  context_length?: number;
  architecture?: {
    tokenizer?: string;
    modality?: string;
    [key: string]: unknown;
  };
  pricing?: {
    prompt?: string | number;
    completion?: string | number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface OpenRouterModelRecord {
  id: string;
  modelId: string;
  name: string | null;
  description: string | null;
  contextLength: number | null;
  inputCostPer1M: Prisma.Decimal | null;
  outputCostPer1M: Prisma.Decimal | null;
  tokenizer: string | null;
  modality: string | null;
  openRouterCreatedAt: Date | null;
  syncedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export async function listOpenRouterKeys(): Promise<OpenRouterKeySummary[]> {
  const payload = await openRouterManagementRequest<OpenRouterKeysResponse>("/keys");
  return payload.data;
}

export async function getOpenRouterKey(hash: string): Promise<OpenRouterKeySummary> {
  const payload = await openRouterManagementRequest<OpenRouterKeyResponse | OpenRouterKeySummary>(`/keys/${encodeURIComponent(hash)}`);

  if ("data" in payload && payload.data) {
    return payload.data;
  }

  return payload as OpenRouterKeySummary;
}

export async function listOpenRouterModels(): Promise<OpenRouterModelRecord[]> {
  return prisma.openRouterModel.findMany({
    orderBy: { modelId: "asc" }
  });
}

export async function syncOpenRouterModels(): Promise<OpenRouterModelRecord[]> {
  const payload = await openRouterManagementRequest<OpenRouterModelsResponse>("/models");
  const syncedAt = new Date();
  const models = payload.data.filter((model) => model.id);

  if (!models.length) {
    return [];
  }

  return prisma.$transaction(
    models.map((model) => prisma.openRouterModel.upsert({
      where: { modelId: model.id },
      create: toOpenRouterModelWrite(model, syncedAt),
      update: toOpenRouterModelWrite(model, syncedAt)
    }))
  );
}

async function openRouterManagementRequest<T>(path: string): Promise<T> {
  const token = config.OPENROUTER_MANAGEMENT_KEY ?? config.OPENROUTER_API_KEY;

  if (!token) {
    throw new HttpError(500, "OPENROUTER_MANAGEMENT_KEY or OPENROUTER_API_KEY is not configured", "openrouter_management_key_missing");
  }

  const response = await fetch(`${config.OPENROUTER_BASE_URL.replace(/\/$/, "")}${path}`, {
    headers: {
      authorization: `Bearer ${token}`
    }
  });

  if (!response.ok) {
    const body = await response.text();
    throw new HttpError(response.status, body || response.statusText, "openrouter_management_failed");
  }

  return response.json() as Promise<T>;
}

function toOpenRouterModelWrite(model: OpenRouterModelApi, syncedAt: Date) {
  return {
    modelId: model.id,
    name: model.name ?? null,
    description: model.description ?? null,
    contextLength: typeof model.context_length === "number" ? model.context_length : null,
    inputCostPer1M: pricePerTokenToPerMillion(model.pricing?.prompt),
    outputCostPer1M: pricePerTokenToPerMillion(model.pricing?.completion),
    tokenizer: model.architecture?.tokenizer ?? null,
    modality: model.architecture?.modality ?? null,
    openRouterCreatedAt: typeof model.created === "number" ? new Date(model.created * 1000) : null,
    raw: toJson(model),
    syncedAt
  };
}

function pricePerTokenToPerMillion(value: string | number | undefined): Prisma.Decimal | null {
  if (value === undefined || value === null) {
    return null;
  }

  const numericValue = Number(value);

  if (!Number.isFinite(numericValue)) {
    return null;
  }

  return new Prisma.Decimal(numericValue).mul(1_000_000);
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
