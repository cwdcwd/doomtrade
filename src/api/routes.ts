/**
 * Express API routes for DoomTrade.
 *
 * All routes are mounted under /api. Each route validates its input
 * with Zod schemas before delegating to the appropriate service.
 *
 * Endpoints:
 *   GET  /api/health
 *   POST /api/decisions
 *   GET  /api/decisions
 *   GET  /api/decisions/:id
 *   POST /api/trade
 *   GET  /api/trades
 *   GET  /api/trades/:id
 *   GET  /api/portfolio
 *   GET  /api/portfolio/history
 *   GET  /api/positions
 *   POST /api/mode
 */

import { Router, type Request, type Response, type NextFunction } from "express";
import type { DecisionStore } from "../decision/decision-store.js";
import type { TradeEngine } from "../engine/trade-engine.js";
import type { Portfolio } from "../portfolio/portfolio.js";
import type { Config } from "../config.js";
import {
  CreateDecisionBodySchema,
  ListDecisionsQuerySchema,
  ExecuteTradeBodySchema,
  PortfolioHistoryQuerySchema,
  ToggleModeBodySchema,
  ListTradesQuerySchema,
} from "./schemas.js";

// ── App state container ─────────────────────────────────────────

export interface AppState {
  decisionStore: DecisionStore;
  tradeEngine: TradeEngine;
  portfolio: Portfolio;
  config: Config;
  /** Mutable mode — can be toggled at runtime via POST /api/mode */
  currentMode: "sim" | "live";
  /** Timestamp when mode was last toggled — for cooldown enforcement */
  modeChangedAt: number;
}

// ── Mode toggle cooldown (seconds) ──────────────────────────────

const MODE_COOLDOWN_SECONDS = 60;

// ── Router factory ──────────────────────────────────────────────

export function createApiRouter(state: AppState): Router {
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

  // ── Decisions ────────────────────────────────────────────────

  router.post("/decisions", (req: Request, res: Response) => {
    const parsed = CreateDecisionBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation failed", details: parsed.error.issues });
      return;
    }

    try {
      const decision = state.decisionStore.create(parsed.data);
      res.status(201).json({ mode: state.currentMode, decision });
    } catch (err) {
      res.status(500).json({ error: "Failed to create decision", message: (err as Error).message });
    }
  });

  router.get("/decisions", (req: Request, res: Response) => {
    const parsed = ListDecisionsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation failed", details: parsed.error.issues });
      return;
    }

    const decisions = state.decisionStore.list(parsed.data);
    const total = state.decisionStore.count(parsed.data);
    res.json({
      mode: state.currentMode,
      decisions,
      total,
      count: decisions.length,
    });
  });

  router.get("/decisions/:id", (req: Request, res: Response) => {
    const decision = state.decisionStore.getById(String(req.params.id));
    if (!decision) {
      res.status(404).json({ error: "Decision not found", id: req.params.id });
      return;
    }
    res.json({ mode: state.currentMode, decision });
  });

  // ── Trade execution ──────────────────────────────────────────

  router.post("/trade", async (req: Request, res: Response, next: NextFunction) => {
    const parsed = ExecuteTradeBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation failed", details: parsed.error.issues });
      return;
    }

    const { decisionId, orderType, limitPrice, stopPrice } = parsed.data;

    // Look up the decision
    const decision = state.decisionStore.getById(decisionId);
    if (!decision) {
      res.status(404).json({ error: "Decision not found", decisionId });
      return;
    }

    try {
      const result = await state.tradeEngine.executeDecision({
        decision,
        orderType,
        limitPrice,
        stopPrice,
      });

      // Record a portfolio checkpoint after each trade
      await state.portfolio.recordCheckpoint();

      const status = result.riskPassed
        ? result.orderResult?.status === "filled"
          ? 200
          : result.orderResult?.status === "pending"
            ? 202
            : 200
        : 422;

      res.status(status).json({
        mode: state.currentMode,
        riskPassed: result.riskPassed,
        riskChecks: result.riskChecks,
        orderResult: result.orderResult,
        tradeRecord: result.tradeRecord,
      });
    } catch (err) {
      res.status(500).json({ error: "Trade execution failed", message: (err as Error).message });
    }
  });

  // ── Trades ───────────────────────────────────────────────────

  router.get("/trades", (req: Request, res: Response) => {
    const parsed = ListTradesQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation failed", details: parsed.error.issues });
      return;
    }

    const { symbol, status, decisionId, limit, offset } = parsed.data;
    const trades = state.tradeEngine.listTrades({
      symbol,
      status,
      decisionId,
      limit,
      offset,
    });

    res.json({
      mode: state.currentMode,
      trades,
      count: trades.length,
    });
  });

  router.get("/trades/:id", (req: Request, res: Response) => {
    const trade = state.tradeEngine.getTrade(String(req.params.id));
    if (!trade) {
      res.status(404).json({ error: "Trade not found", id: req.params.id });
      return;
    }
    res.json({ mode: state.currentMode, trade });
  });

  // ── Portfolio ────────────────────────────────────────────────

  router.get("/portfolio", async (_req: Request, res: Response) => {
    try {
      const snapshot = await state.portfolio.getSnapshot();
      const pnl = await state.portfolio.getPnL();
      res.json({
        mode: state.currentMode,
        portfolio: snapshot,
        pnl,
      });
    } catch (err) {
      res.status(500).json({ error: "Failed to get portfolio", message: (err as Error).message });
    }
  });

  router.get("/portfolio/history", async (req: Request, res: Response) => {
    const parsed = PortfolioHistoryQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation failed", details: parsed.error.issues });
      return;
    }

    const history = await state.portfolio.getHistory({
      startDate: parsed.data.startDate,
      endDate: parsed.data.endDate,
      limit: parsed.data.limit,
    });

    res.json({
      mode: state.currentMode,
      history,
      count: history.length,
    });
  });

  // ── Positions ────────────────────────────────────────────────

  router.get("/positions", async (_req: Request, res: Response) => {
    try {
      const positions = await state.portfolio.getPositions();
      res.json({
        mode: state.currentMode,
        positions,
        count: positions.length,
      });
    } catch (err) {
      res.status(500).json({ error: "Failed to get positions", message: (err as Error).message });
    }
  });

  // ── Mode toggle ──────────────────────────────────────────────

  router.post("/mode", (req: Request, res: Response) => {
    const parsed = ToggleModeBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation failed", details: parsed.error.issues });
      return;
    }

    const { mode, confirm } = parsed.data;

    // Enforce cooldown
    const elapsed = (Date.now() - state.modeChangedAt) / 1000;
    if (elapsed < MODE_COOLDOWN_SECONDS) {
      const remaining = Math.ceil(MODE_COOLDOWN_SECONDS - elapsed);
      res.status(429).json({
        error: `Mode change cooldown active. ${remaining}s remaining.`,
        cooldownRemaining: remaining,
      });
      return;
    }

    // Switching to live requires confirmation
    if (mode === "live" && !confirm) {
      res.status(400).json({
        error: "Switching to LIVE mode requires confirm: true",
        mode: state.currentMode,
        requestedMode: mode,
      });
      return;
    }

    const previousMode = state.currentMode;
    state.currentMode = mode;
    state.modeChangedAt = Date.now();

    res.json({
      mode: state.currentMode,
      previousMode,
      message:
        mode === "live"
          ? "⚠️ LIVE mode active — real orders will be placed"
          : "Sim mode active — paper trading",
      timestamp: new Date().toISOString(),
    });
  });

  return router;
}