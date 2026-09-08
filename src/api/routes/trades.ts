/**
 * Trade execution and listing API routes.
 *
 * POST /api/trade
 * GET  /api/trades
 * GET  /api/trades/analytics
 * GET  /api/trades/:id
 */

import { Router, type Request, type Response, type NextFunction } from "express";
import {
  type AppState,
  ExecuteTradeBodySchema,
  ListTradesQuerySchema,
  z,
  errorMessage,
} from "./types.js";

export function createTradesRouter(state: AppState): Router {
  const router = Router();

  router.post("/trade", async (req: Request, res: Response, _next: NextFunction) => {
    const parsed = ExecuteTradeBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation failed", details: parsed.error.issues });
      return;
    }

    const { decisionId, orderType, limitPrice, stopPrice } = parsed.data;

    // Look up the decision
    const decision = await state.decisionStore.getById(decisionId);
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
      res.status(500).json({ error: "Trade execution failed", message: errorMessage(err) });
    }
  });

  router.get("/trades", async (req: Request, res: Response) => {
    const parsed = ListTradesQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation failed", details: parsed.error.issues });
      return;
    }

    const { symbol, status, decisionId, startDate, endDate, limit, offset } = parsed.data;
    const trades = await state.tradeEngine.listTrades({
      symbol,
      status,
      decisionId,
      startDate,
      endDate,
      limit,
      offset,
    });

    res.json({
      mode: state.currentMode,
      trades,
      count: trades.length,
    });
  });

  // ── Trade analytics ─────────────────────────────────────────

  router.get("/trades/analytics", async (req: Request, res: Response) => {
    const AnalyticsQuerySchema = z.object({
      symbol: z.string().optional(),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
    });
    const parsed = AnalyticsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation failed", details: parsed.error.issues });
      return;
    }

    const analytics = await state.tradeEngine.getAnalytics({
      symbol: parsed.data.symbol,
      startDate: parsed.data.startDate,
      endDate: parsed.data.endDate,
    });

    res.json({
      mode: state.currentMode,
      analytics,
    });
  });

  router.get("/trades/:id", async (req: Request, res: Response) => {
    const trade = await state.tradeEngine.getTrade(String(req.params.id));
    if (!trade) {
      res.status(404).json({ error: "Trade not found", id: req.params.id });
      return;
    }
    res.json({ mode: state.currentMode, trade });
  });

  return router;
}
