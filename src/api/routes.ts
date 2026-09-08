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
 *   GET  /api/market/quote?symbol=BTC/USDT
 *   GET  /api/market/bars?symbol=BTC/USDT&timeframe=1Day&range=3m
 *   GET  /api/market/snapshot?symbols=BTC/USDT,ETH/USDT
 *   GET  /api/research/analyze?symbol=BTC/USDT&timeframe=1Day&range=6m
 *   POST /api/mode
 */

import { Router, type Request, type Response, type NextFunction } from "express";
import type { DecisionStore } from "../decision/decision-store.js";
import type { TradeEngine } from "../engine/trade-engine.js";
import type { Portfolio } from "../portfolio/portfolio.js";
import type { Config } from "../config.js";
import type { MarketDataService } from "../market/market.js";
import type { ResearchService } from "../research/research.js";
import type { ThemeRunner } from "../themes/theme-runner.js";
import {
  CreateDecisionBodySchema,
  ListDecisionsQuerySchema,
  ExecuteTradeBodySchema,
  PortfolioHistoryQuerySchema,
  ToggleModeBodySchema,
  ListTradesQuerySchema,
  TradeAnalyticsQuerySchema,
  CreateThemeBodySchema,
  UpdateThemeBodySchema,
  ListThemesQuerySchema,
} from "./schemas.js";
import { z } from "zod";

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
  /** Market data service — optional, may not be available without API keys */
  marketData?: MarketDataService;
  /** Research service for technical analysis */
  research?: ResearchService;
  /** Theme runner for experimental strategies */
  themeRunner?: ThemeRunner;
  /** Database instance for direct access (theme store, etc.) */
  db: import("../db/database.js").Database;
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

  router.post("/decisions", async (req: Request, res: Response) => {
    const parsed = CreateDecisionBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation failed", details: parsed.error.issues });
      return;
    }

    try {
      const decision = await state.decisionStore.create(parsed.data);
      res.status(201).json({ mode: state.currentMode, decision });
    } catch (err) {
      res.status(500).json({ error: "Failed to create decision", message: (err as Error).message });
    }
  });

  router.get("/decisions", async (req: Request, res: Response) => {
    const parsed = ListDecisionsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation failed", details: parsed.error.issues });
      return;
    }

    const decisions = await state.decisionStore.list(parsed.data);
    const total = await state.decisionStore.count(parsed.data);
    res.json({
      mode: state.currentMode,
      decisions,
      total,
      count: decisions.length,
    });
  });

  router.get("/decisions/:id", async (req: Request, res: Response) => {
    const decision = await state.decisionStore.getById(String(req.params.id));
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
      res.status(500).json({ error: "Trade execution failed", message: (err as Error).message });
    }
  });

  // ── Trades ───────────────────────────────────────────────────

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

  // ── Trade analytics ────────────────────────────────────────────

  router.get("/trades/analytics", async (req: Request, res: Response) => {
    const parsed = TradeAnalyticsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation failed", details: parsed.error.issues });
      return;
    }

    const { symbol, startDate, endDate } = parsed.data;

    const conditions: string[] = ["status = 'filled'"];
    const params: (string | number)[] = [];

    if (symbol) {
      conditions.push("symbol = ?");
      params.push(symbol);
    }
    if (startDate) {
      conditions.push("timestamp >= ?");
      params.push(startDate);
    }
    if (endDate) {
      conditions.push("timestamp <= ?");
      params.push(endDate);
    }

    const where = conditions.join(" AND ");

    const db = state.db;
    if (!db) {
      res.status(503).json({ error: "Database not available" });
      return;
    }

    const { execGet, execAll, convertPlaceholders } = await import("../db/database.js");

    try {
      // Aggregate stats from filled trades (all trades)
      const agg = await execGet<{
        total: number;
        total_pnl: number;
        avg_pnl: number;
      }>(
        db,
        convertPlaceholders(
          `SELECT
             COUNT(*) as total,
             COALESCE(SUM(realized_pnl), 0) as total_pnl,
             COALESCE(AVG(realized_pnl), 0) as avg_pnl
           FROM trades WHERE ${where}`,
          db.backend,
        ),
        params,
      );

      // Win/loss stats from sell trades only (closed positions)
      const sellConditions = [...conditions, "side = 'sell'"];
      const sellParams = [...params];
      const sellWhere = sellConditions.join(" AND ");

      const winLossAgg = await execGet<{ wins: number; losses: number }>(
        db,
        convertPlaceholders(
          `SELECT
             COUNT(CASE WHEN realized_pnl > 0 THEN 1 END) as wins,
             COUNT(CASE WHEN realized_pnl < 0 THEN 1 END) as losses
           FROM trades WHERE ${sellWhere}`,
          db.backend,
        ),
        sellParams,
      );

      const total = agg?.total ?? 0;
      const wins = winLossAgg?.wins ?? 0;
      const losses = winLossAgg?.losses ?? 0;
      const totalPnl = agg?.total_pnl ?? 0;
      const avgPnl = agg?.avg_pnl ?? 0;
      const closedTrades = wins + losses;
      const winRate = closedTrades > 0 ? wins / closedTrades : 0;

      // Per-trade returns for Sharpe ratio calculation (sell trades only)
      const tradeRows = await execAll<{ realized_pnl: number }>(
        db,
        convertPlaceholders(
          `SELECT realized_pnl FROM trades WHERE ${sellWhere} ORDER BY timestamp ASC`,
          db.backend,
        ),
        sellParams,
      );

      const returns = tradeRows.map((r) => r.realized_pnl);
      const avgReturn = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
      const variance = returns.length > 0
        ? returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length
        : 0;
      const stdDev = Math.sqrt(variance);
      // Annualized Sharpe ratio (assuming daily trades, 252 trading days)
      const sharpeRatio = stdDev > 0 ? (avgReturn / stdDev) * Math.sqrt(252) : 0;

      // Max drawdown from portfolio history (equity curve)
      const equityRows = await execAll<{ timestamp: string; equity: number }>(
        db,
        convertPlaceholders(
          `SELECT timestamp, equity FROM portfolio_history
           WHERE 1=1
             ${startDate ? " AND timestamp >= ?" : ""}
             ${endDate ? " AND timestamp <= ?" : ""}
           ORDER BY timestamp ASC`,
          db.backend,
        ),
        [
          ...(startDate ? [startDate] : []),
          ...(endDate ? [endDate] : []),
        ],
      );

      let maxDrawdown = 0;
      let peakEquity = 0;
      for (const row of equityRows) {
        peakEquity = Math.max(peakEquity, row.equity);
        if (peakEquity > 0) {
          const drawdown = ((peakEquity - row.equity) / peakEquity) * 100;
          maxDrawdown = Math.max(maxDrawdown, drawdown);
        }
      }

      res.json({
        mode: state.currentMode,
        analytics: {
          totalTrades: total,
          wins,
          losses,
          winRate,
          avgReturn,
          totalPnl,
          sharpeRatio,
          maxDrawdownPct: maxDrawdown,
        },
      });
    } catch (err) {
      res.status(500).json({ error: "Failed to compute analytics", message: (err as Error).message });
    }
  });

  router.get("/trades/:id", async (req: Request, res: Response) => {
    const trade = await state.tradeEngine.getTrade(String(req.params.id));
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
      res.status(500).json({ error: "Failed to fetch quote", message: (err as Error).message });
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
      const bars = await state.marketData.getBars(parsed.data.symbol, parsed.data.timeframe, parsed.data.range);
      res.json({ mode: state.currentMode, bars, count: bars.length });
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch bars", message: (err as Error).message });
    }
  });

  router.get("/market/snapshot", async (req: Request, res: Response) => {
    if (!state.marketData) {
      res.status(503).json({ error: "Market data service not available" });
      return;
    }
    const symbols = String(req.query.symbols ?? "").split(",").filter(Boolean);
    if (symbols.length === 0) {
      res.status(400).json({ error: "symbols query parameter required (comma-separated)" });
      return;
    }
    try {
      const snapshots = await state.marketData.getSnapshot(symbols);
      res.json({ mode: state.currentMode, snapshots, count: snapshots.length });
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch snapshots", message: (err as Error).message });
    }
  });

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
      const analysis = await state.research.analyze(parsed.data.symbol, parsed.data.timeframe, parsed.data.range);
      res.json({ mode: state.currentMode, analysis });
    } catch (err) {
      res.status(500).json({ error: "Analysis failed", message: (err as Error).message });
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

  // ── Market data ──────────────────────────────────────────────

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
      res.status(502).json({ error: "Failed to fetch quote", message: (err as Error).message, mode: state.currentMode });
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
      const bars = await state.marketData.getBars(symbol, timeframe as "1Min" | "5Min" | "15Min" | "1Hour" | "1Day", range);
      res.json({ mode: state.currentMode, symbol, timeframe, range, bars, count: bars.length });
    } catch (err) {
      res.status(502).json({ error: "Failed to fetch bars", message: (err as Error).message, mode: state.currentMode });
    }
  });

  // ── Themes ────────────────────────────────────────────────────

  router.get("/themes", async (req: Request, res: Response) => {
    if (!state.themeRunner) {
      res.status(503).json({ error: "Theme runner not available" });
      return;
    }
    const parsed = ListThemesQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation failed", details: parsed.error.issues });
      return;
    }

    const { ThemeStore } = await import("../themes/theme-store.js");
    const store = new ThemeStore(state.db);
    const themes = await store.list({
      strategy: parsed.data.strategy,
      enabled: parsed.data.enabled !== undefined ? parsed.data.enabled === "true" : undefined,
    });
    res.json({ mode: state.currentMode, themes, count: themes.length });
  });

  router.post("/themes", async (req: Request, res: Response) => {
    if (!state.themeRunner) {
      res.status(503).json({ error: "Theme runner not available" });
      return;
    }
    const parsed = CreateThemeBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation failed", details: parsed.error.issues });
      return;
    }

    const { ThemeStore } = await import("../themes/theme-store.js");
    const store = new ThemeStore(state.db);
    try {
      const input = {
        ...parsed.data,
        schedule: parsed.data.schedule as any,
      };
      const theme = await store.create(input);
      if (theme.enabled && theme.schedule.type !== "manual") {
        await state.themeRunner.start(theme.id);
      }
      res.status(201).json({ mode: state.currentMode, theme });
    } catch (err) {
      res.status(500).json({ error: "Failed to create theme", message: (err as Error).message });
    }
  });

  router.get("/themes/:id", async (req: Request, res: Response) => {
    if (!state.themeRunner) {
      res.status(503).json({ error: "Theme runner not available" });
      return;
    }
    const { ThemeStore } = await import("../themes/theme-store.js");
    const store = new ThemeStore(state.db);
    const theme = await store.getById(String(req.params.id));
    if (!theme) {
      res.status(404).json({ error: "Theme not found", id: req.params.id });
      return;
    }
    res.json({ mode: state.currentMode, theme });
  });

  router.patch("/themes/:id", async (req: Request, res: Response) => {
    if (!state.themeRunner) {
      res.status(503).json({ error: "Theme runner not available" });
      return;
    }
    const parsed = UpdateThemeBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation failed", details: parsed.error.issues });
      return;
    }

    const { ThemeStore } = await import("../themes/theme-store.js");
    const store = new ThemeStore(state.db);
    const theme = await store.update(String(req.params.id), {
      ...parsed.data,
      schedule: parsed.data.schedule as any,
    });
    if (!theme) {
      res.status(404).json({ error: "Theme not found", id: req.params.id });
      return;
    }
    res.json({ mode: state.currentMode, theme });
  });

  router.delete("/themes/:id", async (req: Request, res: Response) => {
    if (!state.themeRunner) {
      res.status(503).json({ error: "Theme runner not available" });
      return;
    }
    const id = String(req.params.id);
    await state.themeRunner.stop(id);

    const { ThemeStore } = await import("../themes/theme-store.js");
    const store = new ThemeStore(state.db);
    const deleted = await store.delete(id);
    if (!deleted) {
      res.status(404).json({ error: "Theme not found", id });
      return;
    }
    res.json({ mode: state.currentMode, deleted: true, id });
  });

  router.post("/themes/:id/evaluate", async (req: Request, res: Response) => {
    if (!state.themeRunner) {
      res.status(503).json({ error: "Theme runner not available" });
      return;
    }
    try {
      const result = await state.themeRunner.evaluateOnce(String(req.params.id));
      res.json({ mode: state.currentMode, result });
    } catch (err) {
      const status = (err as Error).message.includes("not found") ? 404 : 500;
      res.status(status).json({ error: (err as Error).message });
    }
  });

  router.get("/themes/:id/evaluations", async (req: Request, res: Response) => {
    if (!state.themeRunner) {
      res.status(503).json({ error: "Theme runner not available" });
      return;
    }
    const { ThemeStore } = await import("../themes/theme-store.js");
    const store = new ThemeStore(state.db);
    const limit = parseInt(String(req.query.limit ?? "50"), 10);
    const evaluations = await store.listEvaluations(String(req.params.id), limit);
    res.json({ mode: state.currentMode, evaluations, count: evaluations.length });
  });

  router.get("/themes/:id/performance", async (req: Request, res: Response) => {
    if (!state.themeRunner) {
      res.status(503).json({ error: "Theme runner not available" });
      return;
    }
    try {
      const performance = await state.themeRunner.getPerformance(String(req.params.id));
      res.json({ mode: state.currentMode, performance });
    } catch (err) {
      const status = (err as Error).message.includes("not found") ? 404 : 500;
      res.status(status).json({ error: (err as Error).message });
    }
  });

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
      // Wipe all trade data tables (order matters for FK constraints)
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
        "sim_state",
      ];
      for (const table of tables) {
        await db.exec(`DELETE FROM ${table}`);
      }
      res.json({
        mode: state.currentMode,
        reset: true,
        message: "All sim data wiped. Redeploy to reinitialize with new SIM_STARTING_BALANCE.",
      });
    } catch (err) {
      res.status(500).json({
        error: "Reset failed",
        message: (err as Error).message,
      });
    }
  });

  return router;
}
