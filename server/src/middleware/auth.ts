import { ApiKeyStatus, UserStatus } from "@prisma/client";
import type { NextFunction, Request, Response } from "express";
import { prisma } from "../db.js";
import { hashApiKey } from "../lib/hash.js";
import { HttpError, sendError } from "../lib/http.js";
import { verifySessionToken } from "../lib/session.js";

export async function authenticateGatewayKey(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const header = req.header("authorization");
    const [, bearerToken] = header?.match(/^Bearer\s+(.+)$/i) ?? [];
    const token = bearerToken ?? req.header("x-api-key");

    if (!token) {
      throw new HttpError(401, "Missing bearer API key", "auth_missing");
    }

    const apiKey = await prisma.apiKey.findUnique({
      where: { keyHash: hashApiKey(token) },
      include: {
        user: {
          include: {
            policy: {
              include: {
                l1Model: { include: { provider: true } },
                l2Model: { include: { provider: true } },
                l3Model: { include: { provider: true } }
              }
            }
          }
        }
      }
    });

    if (!apiKey || apiKey.status !== ApiKeyStatus.ACTIVE) {
      throw new HttpError(401, "Invalid API key", "auth_invalid");
    }

    if (apiKey.user.status !== UserStatus.ACTIVE || !apiKey.user.policy) {
      throw new HttpError(403, "User is not allowed to use the gateway", "auth_forbidden");
    }

    await prisma.apiKey.update({
      where: { id: apiKey.id },
      data: { lastUsedAt: new Date() }
    });

    req.gateway = {
      user: apiKey.user,
      policy: apiKey.user.policy,
      apiKeyId: apiKey.id
    };

    next();
  } catch (error) {
    sendError(res, error);
  }
}

export async function authenticateSession(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const header = req.header("authorization");
    const [, token] = header?.match(/^Bearer\s+(.+)$/i) ?? [];

    if (!token) {
      throw new HttpError(401, "Missing session token", "session_missing");
    }

    const payload = verifySessionToken(token);

    if (!payload) {
      throw new HttpError(401, "Invalid or expired session", "session_invalid");
    }

    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      include: {
        policy: {
          include: {
            l1Model: { include: { provider: true } },
            l2Model: { include: { provider: true } },
            l3Model: { include: { provider: true } }
          }
        }
      }
    });

    if (!user || user.status !== UserStatus.ACTIVE || !user.policy) {
      throw new HttpError(403, "User is not allowed to use the dashboard", "session_forbidden");
    }

    req.gateway = {
      user,
      policy: user.policy
    };

    next();
  } catch (error) {
    sendError(res, error);
  }
}
