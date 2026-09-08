/**
 * Portfolio and positions API routes.
 *
 * GET /api/portfolio
 * GET /api/portfolio/history
 * GET /api/positions
 */

import { Router, type Request, type Response } from "express";
import { type AppState, PortfolioHistoryQuerySchema, errorMessage } from "./types.js";

export function createPortfolioRouter(state: AppState): Router {
  const router = Router();

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
      res.status(500).json({ error: "Failed to get portfolio", message: errorMessage(err) });
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
      res.status(500).json({ error: "Failed to get positions", message: errorMessage(err) });
    }
  });

  return router;
}
