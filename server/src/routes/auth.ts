import { Router } from "express";
import { z } from "zod";
import { UserStatus } from "@prisma/client";
import { prisma } from "../db.js";
import { HttpError, sendError } from "../lib/http.js";
import { createSessionToken } from "../lib/session.js";
import { verifyPassword } from "../lib/password.js";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1)
});

export const authRouter = Router();

authRouter.post("/login", async (req, res) => {
  try {
    const payload = loginSchema.parse(req.body);
    const user = await prisma.user.findUnique({
      where: { email: payload.email }
    });

    if (!user || user.status !== UserStatus.ACTIVE || !user.passwordHash) {
      throw new HttpError(401, "Invalid email or password", "login_invalid");
    }

    const valid = await verifyPassword(payload.password, user.passwordHash);

    if (!valid) {
      throw new HttpError(401, "Invalid email or password", "login_invalid");
    }

    res.json({
      data: {
        token: createSessionToken(user.id),
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          isAdmin: user.isAdmin
        }
      }
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      sendError(res, new HttpError(400, error.message, "invalid_login_request"));
      return;
    }

    sendError(res, error);
  }
});
