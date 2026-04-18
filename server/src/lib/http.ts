import type { Response } from "express";

export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code = "request_failed"
  ) {
    super(message);
  }
}

export function sendError(res: Response, error: unknown): void {
  if (error instanceof HttpError) {
    res.status(error.statusCode).json({
      error: {
        code: error.code,
        message: error.message
      }
    });
    return;
  }

  const message = error instanceof Error ? error.message : "Unexpected error";
  res.status(500).json({
    error: {
      code: "internal_error",
      message
    }
  });
}
