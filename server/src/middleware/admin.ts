import type { NextFunction, Request, Response } from "express";
import { HttpError, sendError } from "../lib/http.js";

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  try {
    if (!req.gateway?.user.isAdmin) {
      throw new HttpError(403, "Admin access is required", "admin_required");
    }

    next();
  } catch (error) {
    sendError(res, error);
  }
}
