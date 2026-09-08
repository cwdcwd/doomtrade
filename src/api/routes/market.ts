/**
 * Market data API routes.
 *
 * GET /api/market/quote?symbol=BTC/USDT
 * GET /api/market/bars?symbol=BTC/USDT&timeframe=1Day&range=3m
 * GET /api/market/snapshot?symbols=BTC/USDT,ETH/USDT
 * GET /api/market/quote/:symbol
 * GET /api/market/bars/:symbol
 */

import { Router, type Request, type Response } from "express";
import { type AppState, z, errorMessage } from "./types.js";

export function createMarketRouter(state: AppState): Router {
  const router = Router();

  // ── Market data (public crypto, no API keys needed) ───────────

  const QuoteQuerySchema = z.object({
    symbol: z.string().min(1),
  });

  const BarsQuerySchema = z.object({
    symbol: z.string().min(1),
    timeframe: z.enum(["1Min", "5Min", "15Min", "1Hour", "1Day"]).default("1Day"),
    range: z.string().default("1m"),
  });

  router.get("/market/quote", async (req: Request, res: Response) => {
    if (!state.marketData) {
      res.status(503).json({ error: "Market data service not available" });
      return;
    }
    const parsed = QuoteQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation failed", details: parsed.error.issues });
      return;
    }
    try {
      const quote = await state.marketData.getQuote(parsed.data.symbol);
      res.json({ mode: state.currentMode, quote });
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch quote", message: errorMessage(err) });
    }
  });

  router.get("/market/bars", async (req: Request, res: Response) => {
    if (!state.marketData) {
      res.status(503).json({ error: "Market data service not available" });
      return;
    }
    const parsed = BarsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation failed", details: parsed.error.issues });
      return;
    }
    try {
      const bars = await state.marketData.getBars(
        parsed.data.symbol,
        parsed.data.timeframe,
        parsed.data.range,
      );
      res.json({ mode: state.currentMode, bars, count: bars.length });
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch bars", message: errorMessage(err) });
    }
  });

  router.get("/market/snapshot", async (req: Request, res: Response) => {
    if (!state.marketData) {
      res.status(503).json({ error: "Market data service not available" });
      return;
    }
    const symbols = String(req.query.symbols ?? "")
      .split(",")
      .filter(Boolean);
    if (symbols.length === 0) {
      res.status(400).json({ error: "symbols query parameter required (comma-separated)" });
      return;
    }
    try {
      const snapshots = await state.marketData.getSnapshot(symbols);
      res.json({ mode: state.currentMode, snapshots, count: snapshots.length });
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch snapshots", message: errorMessage(err) });
    }
  });

  // ── Market data (path-param variants) ────────────────────────

  router.get("/market/quote/:symbol", async (req: Request, res: Response) => {
    if (!state.marketData) {
      res.status(503).json({ error: "Market data service unavailable", mode: state.currentMode });
      return;
    }
    try {
      const symbol = String(req.params.symbol);
      const quote = await state.marketData.getQuote(symbol);
      res.json({ mode: state.currentMode, quote });
    } catch (err) {
      res.status(502).json({
        error: "Failed to fetch quote",
        message: errorMessage(err),
        mode: state.currentMode,
      });
    }
  });

  router.get("/market/bars/:symbol", async (req: Request, res: Response) => {
    if (!state.marketData) {
      res.status(503).json({ error: "Market data service unavailable", mode: state.currentMode });
      return;
    }
    try {
      const symbol = String(req.params.symbol);
      const timeframe = (req.query.timeframe as string) ?? "1Day";
      const range = (req.query.range as string) ?? "30d";
      const bars = await state.marketData.getBars(
        symbol,
        timeframe as "1Min" | "5Min" | "15Min" | "1Hour" | "1Day",
        range,
      );
      res.json({ mode: state.currentMode, symbol, timeframe, range, bars, count: bars.length });
    } catch (err) {
      res.status(502).json({
        error: "Failed to fetch bars",
        message: errorMessage(err),
        mode: state.currentMode,
      });
    }
  });

  return router;
}
