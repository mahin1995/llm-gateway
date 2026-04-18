import type { Prisma, RequestLog } from "@prisma/client";
import { prisma } from "../db.js";

export type UsageRange = "24h" | "7d" | "30d" | "90d";

export interface UsageBucket {
  label: string;
  cost: number;
  totalTokens: number;
  outputTokens: number;
}

export interface UsageSummary {
  range: UsageRange;
  from: string;
  to: string;
  totals: {
    cost: number;
    totalTokens: number;
    outputTokens: number;
    requests: number;
  };
  buckets: UsageBucket[];
}

export async function buildUsageSummary(input: {
  range: unknown;
  where?: Prisma.RequestLogWhereInput;
}): Promise<UsageSummary> {
  const range = parseUsageRange(input.range);
  const to = new Date();
  const from = getRangeStart(range, to);
  const buckets = makeBuckets(range, from, to);

  const logs = await prisma.requestLog.findMany({
    where: {
      ...input.where,
      createdAt: {
        gte: from,
        lte: to
      }
    },
    select: {
      createdAt: true,
      inputTokensEstimated: true,
      providerInputTokens: true,
      providerOutputTokens: true,
      providerTotalTokens: true,
      providerCost: true
    }
  });

  const bucketMap = new Map(buckets.map((bucket) => [bucket.label, bucket]));

  for (const log of logs) {
    const label = bucketLabel(range, log.createdAt);
    const bucket = bucketMap.get(label);

    if (!bucket) {
      continue;
    }

    const outputTokens = log.providerOutputTokens ?? 0;
    const totalTokens = totalTokensForLog(log);
    const cost = log.providerCost ? Number(log.providerCost) : 0;

    bucket.outputTokens += outputTokens;
    bucket.totalTokens += totalTokens;
    bucket.cost += Number.isFinite(cost) ? cost : 0;
  }

  return {
    range,
    from: from.toISOString(),
    to: to.toISOString(),
    totals: {
      cost: buckets.reduce((sum, bucket) => sum + bucket.cost, 0),
      totalTokens: buckets.reduce((sum, bucket) => sum + bucket.totalTokens, 0),
      outputTokens: buckets.reduce((sum, bucket) => sum + bucket.outputTokens, 0),
      requests: logs.length
    },
    buckets
  };
}

function parseUsageRange(value: unknown): UsageRange {
  if (value === "24h" || value === "7d" || value === "30d" || value === "90d") {
    return value;
  }

  return "7d";
}

function getRangeStart(range: UsageRange, to: Date): Date {
  const start = new Date(to);
  const days = range === "24h" ? 1 : Number.parseInt(range.replace("d", ""), 10);
  start.setDate(start.getDate() - days + 1);

  if (range !== "24h") {
    start.setHours(0, 0, 0, 0);
  }

  return start;
}

function makeBuckets(range: UsageRange, from: Date, to: Date): UsageBucket[] {
  const buckets: UsageBucket[] = [];
  const cursor = new Date(from);

  if (range === "24h") {
    cursor.setMinutes(0, 0, 0);
    while (cursor <= to) {
      buckets.push(emptyBucket(bucketLabel(range, cursor)));
      cursor.setHours(cursor.getHours() + 1);
    }
    return buckets;
  }

  cursor.setHours(0, 0, 0, 0);
  while (cursor <= to) {
    buckets.push(emptyBucket(bucketLabel(range, cursor)));
    cursor.setDate(cursor.getDate() + 1);
  }

  return buckets;
}

function emptyBucket(label: string): UsageBucket {
  return {
    label,
    cost: 0,
    totalTokens: 0,
    outputTokens: 0
  };
}

function bucketLabel(range: UsageRange, date: Date): string {
  if (range === "24h") {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:00`;
  }

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}

function totalTokensForLog(log: Pick<RequestLog, "inputTokensEstimated" | "providerInputTokens" | "providerOutputTokens" | "providerTotalTokens">): number {
  if (log.providerTotalTokens !== null) {
    return log.providerTotalTokens;
  }

  return (log.providerInputTokens ?? log.inputTokensEstimated) + (log.providerOutputTokens ?? 0);
}
