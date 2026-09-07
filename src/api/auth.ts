/**
 * API key authentication middleware.
 *
 * If DOOMTRADE_API_KEY is set, all requests must include either:
 *   Authorization: Bearer <key>
 *   X-API-Key: <key>
 *
 * If the env var is not set, auth is disabled (local dev mode).
 * Health endpoint is always public (Railway healthcheck needs it).
 */

import type { Request, Response, NextFunction } from "express";

export function apiKeyAuth(apiKey: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // No key configured — open access (local dev)
    if (!apiKey) {
      next();
      return;
    }

    // Extract from Authorization: Bearer *** or X-API-Key header
    const authHeader = req.headers.authorization;
    const bearerKey = authHeader?.startsWith("Bearer ")
      ? authHeader.slice(7)
      : undefined;
    const headerKey = req.headers["x-api-key"] as string | undefined;
    const providedKey = bearerKey ?? headerKey;

    if (!providedKey || providedKey !== apiKey) {
      res.status(401).json({
        error: "Unauthorized",
        message: "Valid API key required. Set Authorization: Bearer <key> or X-API-Key: <key>",
      });
      return;
    }

    next();
  };
}