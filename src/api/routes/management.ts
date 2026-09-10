/**
 * Management API routes — Clerk-gated admin surface.
 *
 *   GET /api/management/me            → session + admin status (see below)
 *   GET /api/management/risk-limits    → current risk limits (admin only)
 *   PUT /api/management/risk-limits    → update risk limits (admin only)
 *
 * Auth semantics (enforced by the guards in src/api/clerk.ts, with
 * clerkMiddleware mounted upstream in src/index.ts):
 *
 *   CLERK_SECRET_KEY unset/malformed (dev-open):
 *     /me   → 200 {authenticated:false} — dashboard hides Management
 *     other → 401
 *
 *   Configured:
 *     /me             → 200 {authenticated:false} for no session;
 *                       200 {authenticated:true, username, isAdmin} for a
 *                       valid session (username via a server-side Clerk
 *                       user lookup)
 *     risk-limits GET/PUT with no session      → 401
 *     risk-limits GET/PUT with non-admin user  → 403 {error:"forbidden"}
 *     risk-limits GET/PUT with the admin user  → 200
 *
 * The PUT route persists limits through the existing storage layer
 * (settings table, migration 009) AND mutates the shared config object
 * in place — both trade engines hold that reference and read the limits
 * on every risk check, so new limits take effect immediately, with no
 * restart; the DB row also overrides env defaults on every boot.
 */

import { Router, type Request, type Response } from "express";
import { type AppState, RiskLimitsSchema, z, errorMessage } from "./types.js";
import {
  clerkEnabled,
  requireClerkUser,
  requireAdmin,
  sessionUserId,
  isAdminUser,
  type ClerkAuthConfig,
} from "../clerk.js";
import { getSetting, setSetting, SETTING_KEYS } from "../../db/settings-store.js";
import type { RiskLimits } from "../schemas.js";

/** The Clerk config slice from the app Config (see src/config.ts). */
function clerkConfig(state: AppState): ClerkAuthConfig {
  return {
    clerkSecretKey: state.config.clerkSecretKey,
    clerkPublishableKey: state.config.clerkPublishableKey,
    adminClerkUserId: state.config.adminClerkUserId,
  };
}

/**
 * Minimal Clerk user-lookup interface — implemented by the real
 * clerkClient and by the test mock. Kept intentionally narrow so tests
 * can stub it without depending on Clerk SDK internals.
 */
export interface ClerkUserLookup {
  getUser(userId: string): Promise<{ username: string | null } | null>;
}

/** Resolve a username for /me; never fails the request. */
async function resolveUsername(
  lookup: ClerkUserLookup | undefined,
  userId: string,
): Promise<string | null> {
  if (!lookup) return null;
  try {
    const user = await lookup.getUser(userId);
    return user?.username ?? null;
  } catch {
    return null;
  }
}

/** Current limits from the shared config object (source of truth at runtime). */
function currentLimits(state: AppState): RiskLimits {
  return {
    maxOpenPositions: state.config.maxOpenPositions,
    maxPositionSizePct: state.config.maxPositionSizePct,
    dailyTradeLimit: state.config.dailyTradeLimit,
    maxDrawdownPct: state.config.maxDrawdownPct,
    simStartingBalance: state.config.simStartingBalance,
    simFeePct: state.config.simFeePct,
  };
}

export function createManagementRouter(state: AppState): Router {
  const router = Router();
  const cfg = clerkConfig(state);

  // ── GET /api/management/me ────────────────────────────────────
  // Always 200 — the status probe the dashboard gates on:
  //   {authenticated:false, clerkConfigured:false}          → hide Management
  //   {authenticated:false, clerkConfigured:true, pk}      → show Sign-in
  //   {authenticated:true, isAdmin:false, username}       → signed-in notice
  //   {authenticated:true, isAdmin:true, username}         → risk-limits form
  // The publishable key is public by design (pk_ is the ONLY Clerk value
  // ever sent to a browser) and the anonymous response needs it so the
  // frontend can load Clerk.js for the sign-in flow. The secret key never
  // leaves the server. 401/403 enforcement lives on the risk-limits routes.
  router.get("/management/me", async (req: Request, res: Response) => {
    if (!clerkEnabled(cfg)) {
      res.json({ authenticated: false, clerkConfigured: false });
      return;
    }
    const userId = sessionUserId(req);
    if (!userId) {
      res.json({
        authenticated: false,
        clerkConfigured: true,
        publishableKey: cfg.clerkPublishableKey,
      });
      return;
    }
    const username = await resolveUsername(state.clerkUserLookup, userId);
    res.json({
      authenticated: true,
      userId,
      username,
      isAdmin: isAdminUser(userId, cfg),
    });
  });

  // ── GET /api/management/risk-limits ──────────────────────────
  const requireAdminMiddleware = requireAdmin(cfg);
  router.get("/management/risk-limits", requireAdminMiddleware, (_req, res) => {
    res.json({ limits: currentLimits(state) });
  });

  // ── PUT /api/management/risk-limits ──────────────────────────
  router.put("/management/risk-limits", requireAdminMiddleware, async (req, res) => {
    const parsed = RiskLimitsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation failed", details: parsed.error.issues });
      return;
    }

    const limits = parsed.data;

    // Persist through the existing storage layer (settings table).
    try {
      await setSetting(state.db, SETTING_KEYS.riskLimits, limits);
    } catch (err) {
      res.status(500).json({ error: "Failed to persist risk limits", message: errorMessage(err) });
      return;
    }

    // Live-update the shared config object — both engines hold this
    // reference and read the limits on every risk check.
    state.config.maxOpenPositions = limits.maxOpenPositions;
    state.config.maxPositionSizePct = limits.maxPositionSizePct;
    state.config.dailyTradeLimit = limits.dailyTradeLimit;
    state.config.maxDrawdownPct = limits.maxDrawdownPct;
    state.config.simStartingBalance = limits.simStartingBalance;
    state.config.simFeePct = limits.simFeePct;

    res.json({ limits: currentLimits(state) });
  });

  return router;
}

// Re-export for tests and future route modules.
export { RiskLimitsSchema };