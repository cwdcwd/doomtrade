/**
 * Research / Technical analysis API routes.
 *
 * GET /api/research/analyze?symbol=BTC/USDT&timeframe=1Day&range=6m
 */

import { Router, type Request, type Response } from "express";
import { type AppState, z, errorMessage } from "./types.js";

export function createResearchRouter(state: AppState): Router {
  const router = Router();

  // ── Research / Technical analysis ─────────────────────────────

  const AnalyzeQuerySchema = z.object({
    symbol: z.string().min(1),
    timeframe: z.enum(["1Min", "5Min", "15Min", "1Hour", "1Day"]).default("1Day"),
    range: z.string().default("6m"),
  });

  router.get("/research/analyze", async (req: Request, res: Response) => {
    if (!state.research) {
      res.status(503).json({ error: "Research service not available" });
      return;
    }
    const parsed = AnalyzeQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation failed", details: parsed.error.issues });
      return;
    }
    try {
      const analysis = await state.research.analyze(
        parsed.data.symbol,
        parsed.data.timeframe,
        parsed.data.range,
      );
      res.json({ mode: state.currentMode, analysis });
    } catch (err) {
      res.status(500).json({ error: "Analysis failed", message: errorMessage(err) });
    }
  });

  return router;
}
