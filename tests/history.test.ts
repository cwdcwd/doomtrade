/**
 * Tests for trade history and performance analytics (Issue #24).
 *
 * Tests the TradeEngine.getAnalytics() method and the enhanced listTrades()
 * with date range filtering, plus the API endpoints.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import express from "express";
import supertest from "supertest";
import type { Database } from "../src/db/database.js";
import {
  openDatabase,
  closeDatabase,
  execRun,
} from "../src/db/database.js";
import {
  SimulatedExchange,
} from "../src/executor/simulated.js";
import { TradeEngine, type TradeAnalytics } from "../src/engine/trade-engine.js";
import { DecisionStore } from "../src/decision/decision-store.js";
import { Portfolio } from "../src/portfolio/portfolio.js";
import { createApiRouter, type AppState } from "../src/api/routes.js";
import type { Decision } from "../src/decision/decision.js";
import type { Config } from "../src/config.js";

describe("Trade History & Performance Analytics (#24)", () => {
  let db: Database;
  let sim: SimulatedExchange;
  let engine: TradeEngine;

  const riskConfig: Pick<
    Config,
    "tradeMode" | "maxOpenPositions" | "maxPositionSizePct" | "dailyTradeLimit" | "maxDrawdownPct"
  > = {
    tradeMode: "sim",
    maxOpenPositions: 10,
    maxPositionSizePct: 20,
    dailyTradeLimit: 20,
    maxDrawdownPct: 15,
  };

  // Price provider for the simulated exchange
  const prices = new Map<string, number>();
  const priceProvider = (symbol: string) => prices.get(symbol) ?? null;

  function makeDecision(overrides: Partial<Decision> = {}): Decision {
    return {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      agent: "kangbot",
      symbol: "BTC/USDT",
      action: "buy",
      quantity: 1,
      priceAtDecision: 50000,
      rationale: "Test decision",
      confidence: 7,
      mode: "sim",
      marketContext: undefined,
      ...overrides,
    };
  }

  function insertTrade(params: {
    symbol?: string;
    side?: "buy" | "sell";
    status?: "pending" | "filled" | "cancelled" | "rejected";
    fillPrice?: number | null;
    fee?: number;
    realizedPnl?: number;
    timestamp?: string;
    decisionId?: string;
  }): void {
    const id = randomUUID();
    const ts = params.timestamp ?? new Date().toISOString();
    execRun(
      db,
      `INSERT INTO trades
         (id, decision_id, timestamp, symbol, side, quantity, order_type,
          fill_price, status, fee, realized_pnl, mode, executor, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        params.decisionId ?? randomUUID(),
        ts,
        params.symbol ?? "BTC/USDT",
        params.side ?? "buy",
        1,
        "market",
        params.fillPrice ?? 50000,
        params.status ?? "filled",
        params.fee ?? 0,
        params.realizedPnl ?? 0,
        "sim",
        "simulated",
        null,
      ],
    );
  }

  function insertEquityPoint(equity: number, timestamp: string): void {
    execRun(
      db,
      `INSERT INTO portfolio_history
         (id, timestamp, equity, cash, positions_value, unrealized_pnl, realized_pnl, mode)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [randomUUID(), timestamp, equity, equity, 0, 0, 0, "sim"],
    );
  }

  beforeEach(async () => {
    db = await openDatabase({ path: ":memory:" });
    sim = new SimulatedExchange(db, { initialCash: 100_000, feeRate: 0.001 });
    engine = new TradeEngine(db, sim, riskConfig, priceProvider);
    prices.set("BTC/USDT", 50000);
    prices.set("ETH/USDT", 3000);
  });

  afterEach(() => {
    closeDatabase(db);
  });

  // ── listTrades with date range ───────────────────────────────

  describe("listTrades with date range filter", () => {
    it("should filter trades by startDate", async () => {
      insertTrade({ timestamp: "2026-09-01T10:00:00Z", realizedPnl: 100 });
      insertTrade({ timestamp: "2026-09-05T10:00:00Z", realizedPnl: 200 });
      insertTrade({ timestamp: "2026-09-06T10:00:00Z", realizedPnl: 300 });

      const trades = await engine.listTrades({ startDate: "2026-09-05" });
      expect(trades).toHaveLength(2);
      expect(trades[0].realizedPnl).toBe(300); // most recent first
      expect(trades[1].realizedPnl).toBe(200);
    });

    it("should filter trades by endDate", async () => {
      insertTrade({ timestamp: "2026-09-01T10:00:00Z" });
      insertTrade({ timestamp: "2026-09-03T10:00:00Z" });
      insertTrade({ timestamp: "2026-09-06T10:00:00Z" });

      const trades = await engine.listTrades({ endDate: "2026-09-03T23:59:59Z" });
      expect(trades).toHaveLength(2);
    });

    it("should filter trades by both startDate and endDate", async () => {
      insertTrade({ timestamp: "2026-09-01T10:00:00Z" });
      insertTrade({ timestamp: "2026-09-03T10:00:00Z" });
      insertTrade({ timestamp: "2026-09-05T10:00:00Z" });
      insertTrade({ timestamp: "2026-09-07T10:00:00Z" });

      const trades = await engine.listTrades({
        startDate: "2026-09-02",
        endDate: "2026-09-06T23:59:59Z",
      });
      expect(trades).toHaveLength(2);
    });
  });

  // ── getAnalytics ──────────────────────────────────────────────

  describe("getAnalytics", () => {
    it("should return zero analytics with no trades", async () => {
      const a = await engine.getAnalytics();
      expect(a.tradeCount).toBe(0);
      expect(a.filledCount).toBe(0);
      expect(a.winLoss.wins).toBe(0);
      expect(a.winLoss.losses).toBe(0);
      expect(a.winLoss.winRate).toBe(0);
      expect(a.pnl.totalRealized).toBe(0);
      expect(a.pnl.netPnl).toBe(0);
      expect(a.equity.startEquity).toBe(0);
      expect(a.equity.drawdownPct).toBe(0);
    });

    it("should count trades by status", async () => {
      insertTrade({ status: "filled" });
      insertTrade({ status: "filled" });
      insertTrade({ status: "pending" });
      insertTrade({ status: "rejected" });
      insertTrade({ status: "cancelled" });

      const a = await engine.getAnalytics();
      expect(a.tradeCount).toBe(5);
      expect(a.filledCount).toBe(2);
      expect(a.pendingCount).toBe(1);
      expect(a.rejectedCount).toBe(1);
      expect(a.cancelledCount).toBe(1);
    });

    it("should compute win/loss ratio correctly", async () => {
      insertTrade({ status: "filled", realizedPnl: 500 });
      insertTrade({ status: "filled", realizedPnl: 200 });
      insertTrade({ status: "filled", realizedPnl: -150 });
      insertTrade({ status: "filled", realizedPnl: -100 });
      insertTrade({ status: "filled", realizedPnl: 0 });

      const a = await engine.getAnalytics();
      expect(a.winLoss.wins).toBe(2);
      expect(a.winLoss.losses).toBe(2);
      expect(a.winLoss.breakeven).toBe(1);
      expect(a.winLoss.totalClosed).toBe(5);
      expect(a.winLoss.winRate).toBeCloseTo(40, 1);
    });

    it("should compute P&L totals correctly", async () => {
      insertTrade({ status: "filled", realizedPnl: 500, fee: 5 });
      insertTrade({ status: "filled", realizedPnl: 300, fee: 3 });
      insertTrade({ status: "filled", realizedPnl: -200, fee: 2 });
      insertTrade({ status: "filled", realizedPnl: -100, fee: 1 });
      insertTrade({ status: "rejected", realizedPnl: 0, fee: 0 });

      const a = await engine.getAnalytics();
      // Only filled trades count for P&L
      expect(a.pnl.totalRealized).toBeCloseTo(500, 1); // 500 + 300 - 200 - 100 = 500
      expect(a.pnl.totalFees).toBeCloseTo(11, 1); // 5 + 3 + 2 + 1 = 11 (rejected excluded)
      expect(a.pnl.netPnl).toBeCloseTo(489, 1); // 500 - 11 = 489
      expect(a.pnl.grossProfit).toBeCloseTo(800, 1); // 500 + 300
      expect(a.pnl.grossLoss).toBeCloseTo(-300, 1); // -200 - 100
      expect(a.pnl.avgWin).toBeCloseTo(400, 1); // 800 / 2
      expect(a.pnl.avgLoss).toBeCloseTo(-150, 1); // -300 / 2
      expect(a.pnl.profitFactor).toBeCloseTo(2.667, 2); // 800 / 300
    });

    it("should handle profit factor with no losses", async () => {
      insertTrade({ status: "filled", realizedPnl: 500 });
      insertTrade({ status: "filled", realizedPnl: 300 });

      const a = await engine.getAnalytics();
      expect(a.pnl.profitFactor).toBe(Infinity);
    });

    it("should compute equity curve summary", async () => {
      insertEquityPoint(100_000, "2026-09-01T10:00:00Z");
      insertEquityPoint(105_000, "2026-09-02T10:00:00Z");
      insertEquityPoint(110_000, "2026-09-03T10:00:00Z");
      insertEquityPoint(95_000, "2026-09-04T10:00:00Z");
      insertEquityPoint(102_000, "2026-09-05T10:00:00Z");

      const a = await engine.getAnalytics();
      expect(a.equity.startEquity).toBe(100_000);
      expect(a.equity.endEquity).toBe(102_000);
      expect(a.equity.maxEquity).toBe(110_000);
      expect(a.equity.minEquity).toBe(95_000);
      // Drawdown = (110000 - 95000) / 110000 * 100 = 13.64%
      expect(a.equity.drawdownPct).toBeCloseTo(13.64, 1);
    });

    it("should filter analytics by symbol", async () => {
      insertTrade({ symbol: "BTC/USDT", status: "filled", realizedPnl: 500 });
      insertTrade({ symbol: "ETH/USDT", status: "filled", realizedPnl: 200 });
      insertTrade({ symbol: "ETH/USDT", status: "filled", realizedPnl: -100 });

      const a = await engine.getAnalytics({ symbol: "ETH/USDT" });
      // Win/loss only counts filled trades for that symbol
      expect(a.winLoss.wins).toBe(1);
      expect(a.winLoss.losses).toBe(1);
      expect(a.pnl.totalRealized).toBeCloseTo(100, 1); // 200 - 100
    });

    it("should filter analytics by date range", async () => {
      insertTrade({ timestamp: "2026-09-01T10:00:00Z", status: "filled", realizedPnl: 500 });
      insertTrade({ timestamp: "2026-09-03T10:00:00Z", status: "filled", realizedPnl: 200 });
      insertTrade({ timestamp: "2026-09-06T10:00:00Z", status: "filled", realizedPnl: -100 });

      const a = await engine.getAnalytics({
        startDate: "2026-09-02",
        endDate: "2026-09-05T23:59:59Z",
      });
      expect(a.winLoss.totalClosed).toBe(1);
      expect(a.winLoss.wins).toBe(1);
      expect(a.pnl.totalRealized).toBeCloseTo(200, 1);
    });
  });

  // ── API endpoints ─────────────────────────────────────────────

  describe("GET /api/trades/analytics", () => {
    function createApp(db: Database) {
      const prices = new Map<string, number>();
      const priceProvider = (symbol: string) => prices.get(symbol) ?? null;
      const decisionStore = new DecisionStore(db);
      const executor = new SimulatedExchange(db, { initialCash: 100_000, feeRate: 0.001, getCurrentPrice: priceProvider });
      const mockConfig: Pick<Config, "tradeMode" | "maxOpenPositions" | "maxPositionSizePct" | "dailyTradeLimit" | "maxDrawdownPct"> = {
        tradeMode: "sim", maxOpenPositions: 10, maxPositionSizePct: 20, dailyTradeLimit: 20, maxDrawdownPct: 15,
      };
      const tradeEngine = new TradeEngine(db, executor, mockConfig);
      const portfolio = new Portfolio(db, executor, { mode: "sim", initialCapital: 100_000 });
      const state: AppState = { decisionStore, tradeEngine, portfolio, config: mockConfig as Config, currentMode: "sim", modeChangedAt: Date.now() };
      const app = express();
      app.use(express.json());
      app.use("/api", createApiRouter(state));
      return { app };
    }

    it("should return analytics with zero trades", async () => {
      const { app } = createApp(db);
      const resp = await supertest(app).get("/api/trades/analytics");
      expect(resp.status).toBe(200);
      expect(resp.body.analytics.tradeCount).toBe(0);
      expect(resp.body.analytics.winLoss.wins).toBe(0);
    });

    it("should return analytics after trades", async () => {
      insertTrade({ status: "filled", realizedPnl: 500, fee: 5 });
      insertTrade({ status: "filled", realizedPnl: -100, fee: 1 });

      const { app } = createApp(db);
      const resp = await supertest(app).get("/api/trades/analytics");
      expect(resp.status).toBe(200);
      expect(resp.body.analytics.tradeCount).toBe(2);
      expect(resp.body.analytics.filledCount).toBe(2);
      expect(resp.body.analytics.winLoss.wins).toBe(1);
      expect(resp.body.analytics.winLoss.losses).toBe(1);
      expect(resp.body.analytics.pnl.totalRealized).toBeCloseTo(400, 1);
    });

    it("should filter analytics by symbol", async () => {
      insertTrade({ symbol: "BTC/USDT", status: "filled", realizedPnl: 500 });
      insertTrade({ symbol: "ETH/USDT", status: "filled", realizedPnl: 200 });

      const { app } = createApp(db);
      const resp = await supertest(app).get("/api/trades/analytics?symbol=ETH/USDT");
      expect(resp.status).toBe(200);
      expect(resp.body.analytics.winLoss.totalClosed).toBe(1);
      expect(resp.body.analytics.winLoss.wins).toBe(1);
    });
  });

  describe("GET /api/trades with date range", () => {
    function createApp(db: Database) {
      const prices = new Map<string, number>();
      const priceProvider = (symbol: string) => prices.get(symbol) ?? null;
      const decisionStore = new DecisionStore(db);
      const executor = new SimulatedExchange(db, { initialCash: 100_000, feeRate: 0.001, getCurrentPrice: priceProvider });
      const mockConfig: Pick<Config, "tradeMode" | "maxOpenPositions" | "maxPositionSizePct" | "dailyTradeLimit" | "maxDrawdownPct"> = {
        tradeMode: "sim", maxOpenPositions: 10, maxPositionSizePct: 20, dailyTradeLimit: 20, maxDrawdownPct: 15,
      };
      const tradeEngine = new TradeEngine(db, executor, mockConfig);
      const portfolio = new Portfolio(db, executor, { mode: "sim", initialCapital: 100_000 });
      const state: AppState = { decisionStore, tradeEngine, portfolio, config: mockConfig as Config, currentMode: "sim", modeChangedAt: Date.now() };
      const app = express();
      app.use(express.json());
      app.use("/api", createApiRouter(state));
      return { app };
    }

    it("should filter trades by startDate via API", async () => {
      insertTrade({ timestamp: "2026-09-01T10:00:00Z" });
      insertTrade({ timestamp: "2026-09-05T10:00:00Z" });

      const { app } = createApp(db);
      const resp = await supertest(app).get("/api/trades?startDate=2026-09-03");
      expect(resp.status).toBe(200);
      expect(resp.body.trades).toHaveLength(1);
    });

    it("should filter trades by date range via API", async () => {
      insertTrade({ timestamp: "2026-09-01T10:00:00Z" });
      insertTrade({ timestamp: "2026-09-03T10:00:00Z" });
      insertTrade({ timestamp: "2026-09-07T10:00:00Z" });

      const { app } = createApp(db);
      const resp = await supertest(app).get("/api/trades?startDate=2026-09-02&endDate=2026-09-05T23:59:59Z");
      expect(resp.status).toBe(200);
      expect(resp.body.trades).toHaveLength(1);
    });
  });
});