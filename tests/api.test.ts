/**
 * API integration tests.
 *
 * Uses supertest to exercise the full Express stack — routes,
 * Zod validation, service wiring. Database is in-memory, executor
 * is SimulatedExchange with a mock price provider.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import supertest from "supertest";
import type { Database } from "../src/db/database.js";
import { openDatabase, closeDatabase } from "../src/db/database.js";
import { DecisionStore } from "../src/decision/decision-store.js";
import { SimulatedExchange } from "../src/executor/simulated.js";
import { TradeEngine } from "../src/engine/trade-engine.js";
import { Portfolio } from "../src/portfolio/portfolio.js";
import { createApiRouter, type AppState } from "../src/api/routes.js";
import type { Config } from "../src/config.js";

// ── Test app factory ───────────────────────────────────────────

function createTestApp(db: Database, overrides?: Partial<AppState>) {
  const prices = new Map<string, number>();
  prices.set("AAPL", 185.0);
  prices.set("MSFT", 400.0);

  const priceProvider = (symbol: string) => prices.get(symbol) ?? null;

  const decisionStore = new DecisionStore(db);
  const executor = new SimulatedExchange(db, {
    initialCash: 100_000,
    feeRate: 0.001,
    getCurrentPrice: priceProvider,
  });

  const mockConfig: Pick<
    Config,
    "tradeMode" | "maxOpenPositions" | "maxPositionSizePct" | "dailyTradeLimit" | "maxDrawdownPct"
  > = {
    tradeMode: "sim",
    maxOpenPositions: 10,
    maxPositionSizePct: 20,
    dailyTradeLimit: 20,
    maxDrawdownPct: 15,
  };

  const tradeEngine = new TradeEngine(db, executor, mockConfig);
  const portfolio = new Portfolio(db, executor, {
    mode: "sim",
    initialCapital: 100_000,
  });

  const state: AppState = {
    decisionStore,
    tradeEngine,
    portfolio,
    config: mockConfig as Config,
    currentMode: "sim",
    modeChangedAt: Date.now(),
    db,
    ...overrides,
  };

  const app = express();
  app.use(express.json());
  app.use("/api", createApiRouter(state));

  return { app, state, prices };
}

// ── Tests ──────────────────────────────────────────────────────

describe("API", () => {
  let db: Database;

  beforeEach(async () => {
    db = await openDatabase({ path: ":memory:" });
  });

  afterEach(async () => {
    await closeDatabase(db);
  });

  // ── Health ────────────────────────────────────────────────────

  describe("GET /api/health", () => {
    it("should return 200 with status ok", async () => {
      const { app } = createTestApp(db);
      const resp = await supertest(app).get("/api/health");

      expect(resp.status).toBe(200);
      expect(resp.body.status).toBe("ok");
      expect(resp.body.mode).toBe("sim");
      expect(resp.body.timestamp).toBeTruthy();
      expect(typeof resp.body.uptime).toBe("number");
    });
  });

  // ── Decisions ────────────────────────────────────────────────

  describe("POST /api/decisions", () => {
    it("should create a decision with valid input", async () => {
      const { app } = createTestApp(db);
      const resp = await supertest(app)
        .post("/api/decisions")
        .send({
          agent: "doom",
          symbol: "AAPL",
          action: "buy",
          quantity: 100,
          priceAtDecision: 185.0,
          rationale: "Strong earnings report",
          confidence: 8,
          mode: "sim",
        });

      expect(resp.status).toBe(201);
      expect(resp.body.mode).toBe("sim");
      expect(resp.body.decision.id).toBeTruthy();
      expect(resp.body.decision.symbol).toBe("AAPL");
      expect(resp.body.decision.agent).toBe("doom");
      expect(resp.body.decision.action).toBe("buy");
      expect(resp.body.decision.quantity).toBe(100);
      expect(resp.body.decision.confidence).toBe(8);
    });

    it("should create a decision with market context", async () => {
      const { app } = createTestApp(db);
      const resp = await supertest(app)
        .post("/api/decisions")
        .send({
          agent: "kangbot",
          symbol: "BTC/USDT",
          action: "sell",
          quantity: 0.5,
          priceAtDecision: 65000,
          rationale: "RSI overbought",
          confidence: 6,
          mode: "sim",
          marketContext: {
            price: 65000,
            volume: 1_200_000,
            indicators: { rsi: 72, macd: "bearish" },
            news: ["Bitcoin hits resistance"],
            notes: "Watching for breakout",
          },
        });

      expect(resp.status).toBe(201);
      expect(resp.body.decision.symbol).toBe("BTC/USDT");
      expect(resp.body.decision.marketContext).toBeTruthy();
      expect(resp.body.decision.marketContext.indicators.rsi).toBe(72);
    });

    it("should accept any agent name (per-agent trading)", async () => {
      const { app } = createTestApp(db);
      const resp = await supertest(app)
        .post("/api/decisions")
        .send({
          agent: "ThanosBot",
          symbol: "AAPL",
          action: "buy",
          quantity: 100,
          priceAtDecision: 185,
          rationale: "test",
          confidence: 5,
          mode: "sim",
        });

      expect(resp.status).toBe(201);
      expect(resp.body.decision.agent).toBe("ThanosBot");
    });

    it("should reject negative quantity", async () => {
      const { app } = createTestApp(db);
      const resp = await supertest(app)
        .post("/api/decisions")
        .send({
          agent: "doom",
          symbol: "AAPL",
          action: "buy",
          quantity: -100,
          priceAtDecision: 185,
          rationale: "test",
          confidence: 5,
          mode: "sim",
        });

      expect(resp.status).toBe(400);
    });

    it("should reject confidence out of range", async () => {
      const { app } = createTestApp(db);
      const resp = await supertest(app)
        .post("/api/decisions")
        .send({
          agent: "doom",
          symbol: "AAPL",
          action: "buy",
          quantity: 100,
          priceAtDecision: 185,
          rationale: "test",
          confidence: 15,
          mode: "sim",
        });

      expect(resp.status).toBe(400);
    });

    it("should reject missing rationale", async () => {
      const { app } = createTestApp(db);
      const resp = await supertest(app)
        .post("/api/decisions")
        .send({
          agent: "doom",
          symbol: "AAPL",
          action: "buy",
          quantity: 100,
          priceAtDecision: 185,
          confidence: 5,
          mode: "sim",
        });

      expect(resp.status).toBe(400);
    });
  });

  describe("GET /api/decisions", () => {
    it("should return empty list initially", async () => {
      const { app } = createTestApp(db);
      const resp = await supertest(app).get("/api/decisions");

      expect(resp.status).toBe(200);
      expect(resp.body.decisions).toHaveLength(0);
      expect(resp.body.total).toBe(0);
      expect(resp.body.mode).toBe("sim");
    });

    it("should list created decisions", async () => {
      const { app } = createTestApp(db);

      // Create two decisions
      await supertest(app).post("/api/decisions").send({
        agent: "doom",
        symbol: "AAPL",
        action: "buy",
        quantity: 100,
        priceAtDecision: 185,
        rationale: "Bullish",
        confidence: 8,
        mode: "sim",
      });
      await supertest(app).post("/api/decisions").send({
        agent: "kangbot",
        symbol: "MSFT",
        action: "hold",
        quantity: 50,
        priceAtDecision: 400,
        rationale: "Wait for pullback",
        confidence: 6,
        mode: "sim",
      });

      const resp = await supertest(app).get("/api/decisions");

      expect(resp.status).toBe(200);
      expect(resp.body.decisions).toHaveLength(2);
      expect(resp.body.total).toBe(2);
    });

    it("should filter by agent", async () => {
      const { app } = createTestApp(db);

      await supertest(app).post("/api/decisions").send({
        agent: "doom",
        symbol: "AAPL",
        action: "buy",
        quantity: 100,
        priceAtDecision: 185,
        rationale: "Bullish",
        confidence: 8,
        mode: "sim",
      });
      await supertest(app).post("/api/decisions").send({
        agent: "kangbot",
        symbol: "MSFT",
        action: "hold",
        quantity: 50,
        priceAtDecision: 400,
        rationale: "Wait",
        confidence: 6,
        mode: "sim",
      });

      const resp = await supertest(app).get("/api/decisions?agent=doom");

      expect(resp.status).toBe(200);
      expect(resp.body.decisions).toHaveLength(1);
      expect(resp.body.decisions[0].agent).toBe("doom");
    });

    it("should filter by symbol", async () => {
      const { app } = createTestApp(db);

      await supertest(app).post("/api/decisions").send({
        agent: "doom",
        symbol: "AAPL",
        action: "buy",
        quantity: 100,
        priceAtDecision: 185,
        rationale: "Bullish",
        confidence: 8,
        mode: "sim",
      });
      await supertest(app).post("/api/decisions").send({
        agent: "kangbot",
        symbol: "MSFT",
        action: "hold",
        quantity: 50,
        priceAtDecision: 400,
        rationale: "Wait",
        confidence: 6,
        mode: "sim",
      });

      const resp = await supertest(app).get("/api/decisions?symbol=MSFT");

      expect(resp.body.decisions).toHaveLength(1);
      expect(resp.body.decisions[0].symbol).toBe("MSFT");
    });

    it("should respect limit and offset", async () => {
      const { app } = createTestApp(db);

      for (let i = 0; i < 5; i++) {
        await supertest(app).post("/api/decisions").send({
          agent: "doom",
          symbol: "AAPL",
          action: "buy",
          quantity: 100,
          priceAtDecision: 185 + i,
          rationale: `Reason ${i}`,
          confidence: 5,
          mode: "sim",
        });
      }

      const resp = await supertest(app).get("/api/decisions?limit=2&offset=0");

      expect(resp.body.decisions).toHaveLength(2);
      expect(resp.body.total).toBe(5);
    });
  });

  describe("GET /api/decisions/:id", () => {
    it("should return a decision by id", async () => {
      const { app } = createTestApp(db);

      const createResp = await supertest(app).post("/api/decisions").send({
        agent: "doom",
        symbol: "AAPL",
        action: "buy",
        quantity: 100,
        priceAtDecision: 185,
        rationale: "Bullish",
        confidence: 8,
        mode: "sim",
      });

      const id = createResp.body.decision.id;
      const resp = await supertest(app).get(`/api/decisions/${id}`);

      expect(resp.status).toBe(200);
      expect(resp.body.decision.id).toBe(id);
      expect(resp.body.decision.symbol).toBe("AAPL");
    });

    it("should return 404 for non-existent decision", async () => {
      const { app } = createTestApp(db);
      const resp = await supertest(app).get(
        "/api/decisions/00000000-0000-4000-8000-000000000000",
      );

      expect(resp.status).toBe(404);
      expect(resp.body.error).toBe("Decision not found");
    });
  });

  // ── Trade execution ───────────────────────────────────────────

  describe("POST /api/trade", () => {
    it("should execute a buy decision and return filled", async () => {
      const { app } = createTestApp(db);

      // Create a decision first
      const createResp = await supertest(app).post("/api/decisions").send({
        agent: "doom",
        symbol: "AAPL",
        action: "buy",
        quantity: 100,
        priceAtDecision: 185,
        rationale: "Bullish",
        confidence: 8,
        mode: "sim",
      });

      const decisionId = createResp.body.decision.id;
      const resp = await supertest(app).post("/api/trade").send({
        decisionId,
      });

      expect(resp.status).toBe(200);
      expect(resp.body.mode).toBe("sim");
      expect(resp.body.riskPassed).toBe(true);
      expect(resp.body.orderResult.status).toBe("filled");
      expect(resp.body.orderResult.fillPrice).toBeCloseTo(185, 2);
      expect(resp.body.tradeRecord.status).toBe("filled");
    });

    it("should return 404 for non-existent decision", async () => {
      const { app } = createTestApp(db);
      const resp = await supertest(app).post("/api/trade").send({
        decisionId: "00000000-0000-4000-8000-000000000000",
      });

      expect(resp.status).toBe(404);
      expect(resp.body.error).toBe("Decision not found");
    });

    it("should reject invalid decisionId format", async () => {
      const { app } = createTestApp(db);
      const resp = await supertest(app).post("/api/trade").send({
        decisionId: "not-a-uuid",
      });

      expect(resp.status).toBe(400);
    });

    it("should reject buy exceeding position size limit", async () => {
      const { app } = createTestApp(db);

      // Buy something huge — 20% of 100k = 20k notional max
      const createResp = await supertest(app).post("/api/decisions").send({
        agent: "doom",
        symbol: "AAPL",
        action: "buy",
        quantity: 200, // 200 * 185 = 37,000 > 20% of 100k
        priceAtDecision: 185,
        rationale: "Yolo",
        confidence: 5,
        mode: "sim",
      });

      const decisionId = createResp.body.decision.id;
      const resp = await supertest(app).post("/api/trade").send({
        decisionId,
      });

      expect(resp.body.riskPassed).toBe(false);
      const failedChecks = resp.body.riskChecks.filter((c: { passed: boolean }) => !c.passed);
      expect(failedChecks.length).toBeGreaterThan(0);
      expect(resp.body.tradeRecord.status).toBe("rejected");
      // Should be 422 (risk failed) not 200
      expect(resp.status).toBe(422);
    });

    it("should handle hold decisions (no trade)", async () => {
      const { app } = createTestApp(db);

      const createResp = await supertest(app).post("/api/decisions").send({
        agent: "doom",
        symbol: "AAPL",
        action: "hold",
        quantity: 100,
        priceAtDecision: 185,
        rationale: "Wait and see",
        confidence: 5,
        mode: "sim",
      });

      const decisionId = createResp.body.decision.id;
      const resp = await supertest(app).post("/api/trade").send({
        decisionId,
      });

      expect(resp.status).toBe(200);
      expect(resp.body.riskPassed).toBe(true);
      expect(resp.body.orderResult).toBeNull();
      expect(resp.body.tradeRecord).toBeNull();
    });
  });

  // ── Trades ───────────────────────────────────────────────────

  describe("GET /api/trades", () => {
    it("should return empty list initially", async () => {
      const { app } = createTestApp(db);
      const resp = await supertest(app).get("/api/trades");

      expect(resp.status).toBe(200);
      expect(resp.body.trades).toHaveLength(0);
      expect(resp.body.mode).toBe("sim");
    });

    it("should list trades after execution", async () => {
      const { app } = createTestApp(db);

      // Create + execute a trade
      const createResp = await supertest(app).post("/api/decisions").send({
        agent: "doom",
        symbol: "AAPL",
        action: "buy",
        quantity: 50,
        priceAtDecision: 185,
        rationale: "Bullish",
        confidence: 8,
        mode: "sim",
      });

      await supertest(app).post("/api/trade").send({
        decisionId: createResp.body.decision.id,
      });

      const resp = await supertest(app).get("/api/trades");

      expect(resp.body.trades).toHaveLength(1);
      expect(resp.body.trades[0].symbol).toBe("AAPL");
      expect(resp.body.trades[0].status).toBe("filled");
    });

    it("should filter by symbol", async () => {
      const { app } = createTestApp(db);

      // Trade AAPL
      const aaplResp = await supertest(app).post("/api/decisions").send({
        agent: "doom",
        symbol: "AAPL",
        action: "buy",
        quantity: 50,
        priceAtDecision: 185,
        rationale: "Bullish",
        confidence: 8,
        mode: "sim",
      });
      await supertest(app).post("/api/trade").send({
        decisionId: aaplResp.body.decision.id,
      });

      // Trade MSFT
      const msftResp = await supertest(app).post("/api/decisions").send({
        agent: "doom",
        symbol: "MSFT",
        action: "buy",
        quantity: 10,
        priceAtDecision: 400,
        rationale: "Bullish",
        confidence: 8,
        mode: "sim",
      });
      await supertest(app).post("/api/trade").send({
        decisionId: msftResp.body.decision.id,
      });

      const resp = await supertest(app).get("/api/trades?symbol=AAPL");

      expect(resp.body.trades).toHaveLength(1);
      expect(resp.body.trades[0].symbol).toBe("AAPL");
    });
  });

  describe("GET /api/trades/:id", () => {
    it("should return a trade by id", async () => {
      const { app } = createTestApp(db);

      const createResp = await supertest(app).post("/api/decisions").send({
        agent: "doom",
        symbol: "AAPL",
        action: "buy",
        quantity: 50,
        priceAtDecision: 185,
        rationale: "Bullish",
        confidence: 8,
        mode: "sim",
      });
      const tradeResp = await supertest(app).post("/api/trade").send({
        decisionId: createResp.body.decision.id,
      });

      const tradeId = tradeResp.body.tradeRecord.id;
      const resp = await supertest(app).get(`/api/trades/${tradeId}`);

      expect(resp.status).toBe(200);
      expect(resp.body.trade.id).toBe(tradeId);
    });

    it("should return 404 for non-existent trade", async () => {
      const { app } = createTestApp(db);
      const resp = await supertest(app).get("/api/trades/nonexistent");

      expect(resp.status).toBe(404);
    });
  });

  // ── Trade analytics ─────────────────────────────────────────────

  describe("GET /api/trades/analytics", () => {
    it("should return analytics with zero trades initially", async () => {
      const { app } = createTestApp(db);
      const resp = await supertest(app).get("/api/trades/analytics");

      expect(resp.status).toBe(200);
      expect(resp.body.mode).toBe("sim");
      expect(resp.body.analytics).toBeDefined();
      expect(resp.body.analytics.totalTrades).toBe(0);
      expect(resp.body.analytics.wins).toBe(0);
      expect(resp.body.analytics.losses).toBe(0);
      expect(resp.body.analytics.winRate).toBe(0);
      expect(resp.body.analytics.sharpeRatio).toBe(0);
      expect(resp.body.analytics.maxDrawdownPct).toBe(0);
    });

    it("should compute analytics after trades", async () => {
      const { app, prices } = createTestApp(db);

      // Buy AAPL at 185, then sell at a higher price
      prices.set("AAPL", 185);
      const buyResp = await supertest(app).post("/api/decisions").send({
        agent: "doom",
        symbol: "AAPL",
        action: "buy",
        quantity: 50,
        priceAtDecision: 185,
        rationale: "Bullish",
        confidence: 8,
        mode: "sim",
      });
      await supertest(app).post("/api/trade").send({
        decisionId: buyResp.body.decision.id,
      });

      // Sell at 200 for a profit
      prices.set("AAPL", 200);
      const sellResp = await supertest(app).post("/api/decisions").send({
        agent: "doom",
        symbol: "AAPL",
        action: "sell",
        quantity: 50,
        priceAtDecision: 200,
        rationale: "Taking profit",
        confidence: 7,
        mode: "sim",
      });
      await supertest(app).post("/api/trade").send({
        decisionId: sellResp.body.decision.id,
      });

      const resp = await supertest(app).get("/api/trades/analytics");

      expect(resp.status).toBe(200);
      expect(resp.body.analytics.totalTrades).toBe(2);
      expect(resp.body.analytics.wins).toBe(1);
      expect(resp.body.analytics.losses).toBe(0);
      expect(resp.body.analytics.winRate).toBe(1);
      expect(resp.body.analytics.totalPnl).toBeGreaterThan(0);
      expect(resp.body.analytics.avgReturn).toBeGreaterThan(0);
    });

    it("should filter analytics by symbol", async () => {
      const { app, prices } = createTestApp(db);

      // Trade AAPL
      prices.set("AAPL", 185);
      const aaplResp = await supertest(app).post("/api/decisions").send({
        agent: "doom",
        symbol: "AAPL",
        action: "buy",
        quantity: 50,
        priceAtDecision: 185,
        rationale: "Bullish",
        confidence: 8,
        mode: "sim",
      });
      await supertest(app).post("/api/trade").send({
        decisionId: aaplResp.body.decision.id,
      });

      // Trade MSFT
      prices.set("MSFT", 400);
      const msftResp = await supertest(app).post("/api/decisions").send({
        agent: "doom",
        symbol: "MSFT",
        action: "buy",
        quantity: 10,
        priceAtDecision: 400,
        rationale: "Bullish",
        confidence: 8,
        mode: "sim",
      });
      await supertest(app).post("/api/trade").send({
        decisionId: msftResp.body.decision.id,
      });

      const resp = await supertest(app).get("/api/trades/analytics?symbol=AAPL");

      expect(resp.status).toBe(200);
      expect(resp.body.analytics.totalTrades).toBe(1);
    });
  });

  // ── Date range filtering ────────────────────────────────────────

  describe("GET /api/trades date range filtering", () => {
    it("should filter trades by date range", async () => {
      const { app } = createTestApp(db);

      // Create a trade
      const createResp = await supertest(app).post("/api/decisions").send({
        agent: "doom",
        symbol: "AAPL",
        action: "buy",
        quantity: 50,
        priceAtDecision: 185,
        rationale: "Bullish",
        confidence: 8,
        mode: "sim",
      });
      await supertest(app).post("/api/trade").send({
        decisionId: createResp.body.decision.id,
      });

      // Filter with a start date in the future — should return no trades
      const futureResp = await supertest(app).get("/api/trades?startDate=2099-01-01");
      expect(futureResp.body.trades).toHaveLength(0);

      // Filter with a start date in the past — should return the trade
      const pastResp = await supertest(app).get("/api/trades?startDate=2020-01-01");
      expect(pastResp.body.trades).toHaveLength(1);

      // Filter with end date in the past — should return no trades
      const pastEndResp = await supertest(app).get("/api/trades?endDate=2020-01-01");
      expect(pastEndResp.body.trades).toHaveLength(0);
    });
  });

  // ── Portfolio ────────────────────────────────────────────────

  describe("GET /api/portfolio", () => {
    it("should return initial portfolio with no positions", async () => {
      const { app } = createTestApp(db);
      const resp = await supertest(app).get("/api/portfolio");

      expect(resp.status).toBe(200);
      expect(resp.body.mode).toBe("sim");
      expect(resp.body.portfolio.equity).toBe(100_000);
      expect(resp.body.portfolio.cash).toBe(100_000);
      expect(resp.body.portfolio.positionsValue).toBe(0);
      expect(resp.body.portfolio.positionCount).toBe(0);
      expect(resp.body.pnl.unrealized).toBe(0);
      expect(resp.body.pnl.realized).toBe(0);
    });

    it("should reflect positions after trade", async () => {
      const { app } = createTestApp(db);

      const createResp = await supertest(app).post("/api/decisions").send({
        agent: "doom",
        symbol: "AAPL",
        action: "buy",
        quantity: 50,
        priceAtDecision: 185,
        rationale: "Bullish",
        confidence: 8,
        mode: "sim",
      });
      await supertest(app).post("/api/trade").send({
        decisionId: createResp.body.decision.id,
      });

      const resp = await supertest(app).get("/api/portfolio");

      expect(resp.body.portfolio.positionCount).toBe(1);
      expect(resp.body.portfolio.positions[0].symbol).toBe("AAPL");
      expect(resp.body.portfolio.cash).toBeLessThan(100_000);
    });
  });

  describe("GET /api/portfolio/history", () => {
    it("should return empty history initially", async () => {
      const { app } = createTestApp(db);
      const resp = await supertest(app).get("/api/portfolio/history");

      expect(resp.status).toBe(200);
      expect(resp.body.history).toHaveLength(0);
    });

    it("should return checkpoints after trades", async () => {
      const { app } = createTestApp(db);

      const createResp = await supertest(app).post("/api/decisions").send({
        agent: "doom",
        symbol: "AAPL",
        action: "buy",
        quantity: 50,
        priceAtDecision: 185,
        rationale: "Bullish",
        confidence: 8,
        mode: "sim",
      });
      await supertest(app).post("/api/trade").send({
        decisionId: createResp.body.decision.id,
      });

      const resp = await supertest(app).get("/api/portfolio/history");

      expect(resp.body.history.length).toBeGreaterThanOrEqual(1);
      expect(resp.body.history[0].equity).toBeGreaterThan(0);
    });
  });

  // ── Positions ────────────────────────────────────────────────

  describe("GET /api/positions", () => {
    it("should return empty positions initially", async () => {
      const { app } = createTestApp(db);
      const resp = await supertest(app).get("/api/positions");

      expect(resp.status).toBe(200);
      expect(resp.body.positions).toHaveLength(0);
      expect(resp.body.count).toBe(0);
      expect(resp.body.mode).toBe("sim");
    });

    it("should return positions after trade", async () => {
      const { app } = createTestApp(db);

      const createResp = await supertest(app).post("/api/decisions").send({
        agent: "doom",
        symbol: "AAPL",
        action: "buy",
        quantity: 100,
        priceAtDecision: 185,
        rationale: "Bullish",
        confidence: 8,
        mode: "sim",
      });
      await supertest(app).post("/api/trade").send({
        decisionId: createResp.body.decision.id,
      });

      const resp = await supertest(app).get("/api/positions");

      expect(resp.body.positions).toHaveLength(1);
      expect(resp.body.positions[0].symbol).toBe("AAPL");
      expect(resp.body.positions[0].quantity).toBe(100);
    });
  });

  // ── Mode toggle ──────────────────────────────────────────────

  describe("POST /api/mode", () => {
    it("should switch to sim mode", async () => {
      const { app, state } = createTestApp(db);
      // Set mode to live first to test switching back
      state.currentMode = "live";
      state.modeChangedAt = Date.now() - 70_000; // past cooldown

      const resp = await supertest(app).post("/api/mode").send({
        mode: "sim",
        confirm: true,
      });

      expect(resp.status).toBe(200);
      expect(resp.body.mode).toBe("sim");
      expect(resp.body.previousMode).toBe("live");
    });

    it("should require confirm to switch to live", async () => {
      const { app, state } = createTestApp(db);
      state.modeChangedAt = Date.now() - 70_000; // past cooldown

      const resp = await supertest(app).post("/api/mode").send({
        mode: "live",
        confirm: false,
      });

      expect(resp.status).toBe(400);
      expect(resp.body.error).toContain("confirm");
      expect(resp.body.mode).toBe("sim");
    });

    it("should switch to live with confirm", async () => {
      const { app, state } = createTestApp(db);
      state.modeChangedAt = Date.now() - 70_000;

      const resp = await supertest(app).post("/api/mode").send({
        mode: "live",
        confirm: true,
      });

      expect(resp.status).toBe(200);
      expect(resp.body.mode).toBe("live");
      expect(resp.body.message).toContain("LIVE");
    });

    it("should enforce cooldown", async () => {
      const { app, state } = createTestApp(db);
      state.modeChangedAt = Date.now() - 10_000; // 10s ago, 50s remaining

      const resp = await supertest(app).post("/api/mode").send({
        mode: "sim",
        confirm: true,
      });

      expect(resp.status).toBe(429);
      expect(resp.body.error).toContain("cooldown");
      expect(resp.body.cooldownRemaining).toBeGreaterThan(0);
    });

    it("should reject invalid mode value", async () => {
      const { app } = createTestApp(db);
      const resp = await supertest(app).post("/api/mode").send({
        mode: "paper",
        confirm: true,
      });

      expect(resp.status).toBe(400);
    });
  });
});