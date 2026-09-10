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
    const bearerKey = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined;
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

/**
 * The production auth gate (as mounted in src/index.ts):
 * public GETs + /health for humans (read-only dashboard), keyed
 * mutations for machines (fleet crons, A2A). Extracted so tests
 * exercise the exact middleware the server mounts — not a mirror.
 */
export function authGate(apiKey: string) {
  const keyed = apiKeyAuth(apiKey);
  return (req: Request, res: Response, next: NextFunction): void => {
    // No key configured — open access (local dev)
    if (!apiKey) {
      next();
      return;
    }
    // Public: health (Railway healthcheck) + everything a browser reads
    if (req.path === "/health" || req.method === "GET") {
      next();
      return;
    }
    keyed(req, res, next);
  };
}
