import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  CLIENT_DEV_ORIGIN: z.string().url().default("http://localhost:5173"),
  DATABASE_URL: z.string().min(1),
  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_MANAGEMENT_KEY: z.string().optional(),
  OPENROUTER_BASE_URL: z.string().url().default("https://openrouter.ai/api/v1"),
  OPENROUTER_HTTP_REFERER: z.string().url().default("http://localhost:3000"),
  OPENROUTER_APP_TITLE: z.string().default("LLM Gateway"),
  SESSION_SECRET: z.string().min(16).default("dev-session-secret-change-me")
});

export const config = envSchema.parse(process.env);
