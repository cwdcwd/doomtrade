/**
 * Health and admin API routes.
 *
 * GET  /api/health
 * POST /api/admin/reset
 */

import { Router, type Request, type Response } from "express";
import { type AppState, errorMessage } from "./types.js";

export function createHealthRouter(state: AppState): Router {
  const router = Router();

  // ── Health ────────────────────────────────────────────────────

  router.get("/health", (_req: Request, res: Response) => {
    res.json({
      status: "ok",
      mode: state.currentMode,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    });
  });

  return router;
}

export function createAdminRouter(state: AppState): Router {
  const router = Router();

  // ── Admin: reset sim state ──────────────────────────────────────

  router.post("/admin/reset", async (req: Request, res: Response) => {
    const db = state.db;
    if (!db) {
      res.status(503).json({ error: "Database not available" });
      return;
    }
    const { confirm } = req.body as { confirm?: string };
    if (confirm !== "WIPE_ALL_DATA") {
      res.status(400).json({
        error: "Confirmation required",
        message: "Pass { confirm: 'WIPE_ALL_DATA' } to reset all sim data",
      });
      return;
    }

    try {
      // Wipe all trade data tables (order matters for FK constraints).
      // Use IF EXISTS to handle tables that may not exist yet.
      const tables = [
        "sim_sub_orders",
        "sim_sub_positions",
        "theme_evaluations",
        "theme_signals",
        "theme_subaccounts",
        "themes",
        "trades",
        "decisions",
        "portfolio_history",
        "sim_positions",
        "sim_balance",
        // Agent tables (NOT the agents table itself — just trading data)
        "agent_portfolio_history",
        "agent_orders",
        "agent_positions",
        "agent_balance",
      ];
      for (const table of tables) {
        await db.exec(`DELETE FROM ${table}`);
      }
      // Also reset the migrations table so the app reinitializes on next boot
      // (Not needed — migrations are idempotent with IF NOT EXISTS)
      res.json({
        mode: state.currentMode,
        reset: true,
        message: "All sim data wiped. Redeploy to reinitialize with new SIM_STARTING_BALANCE.",
      });
    } catch (err) {
      res.status(500).json({
        error: "Reset failed",
        message: errorMessage(err),
      });
    }
  });

  return router;
}
