/**
 * Tests for agent API routes — per-agent trading endpoints.
 *
 * Uses supertest to exercise the full Express stack with AgentManager
 * and AgentTradeEngine wired into AppState. Database is in-memory.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import supertest from "supertest";
import type { Database } from "../src/db/database.js";
import { openDatabase, closeDatabase } from "../src/db/database.js";
import { DecisionStore } from "../src/decision/decision-store.js";
import { SimulatedExchange } from "../src/executor/simulated.js";
import { TradeEngine } from "../src/engine/trade-engine.js";
import { AgentTradeEngine } from "../src/engine/agent-trade-engine.js";
import { Portfolio } from "../src/portfolio/portfolio.js";
import { AgentManager } from "../src/agent/agent-manager.js";
import { AgentTradingPipeline } from "../src/agent/trading-pipeline.js";
import { MomentumRotationStrategy } from "../src/themes/strategies/momentum-rotation.js";
import { CongressFollowerStrategy } from "../src/themes/strategies/congress-follower.js";
import { AgentDrivenStrategy } from "../src/themes/strategies/agent-driven.js";
import { createApiRouter, type AppState } from "../src/api/routes.js";
import type { Config } from "../src/config.js";

// ── Test app factory ────────────────────────────────────────────

function createTestApp(db: Database) {
  const prices = new Map<string, number>();
  prices.set("AAPL", 185.0);
  prices.set("BTC/USDT", 50000);
  prices.set("ETH/USDT", 3000);

  const priceProvider = (symbol: string) => prices.get(symbol) ?? null;

  const decisionStore = new DecisionStore(db);
  const executor = new SimulatedExchange(db, {
    initialCash: 100_000,
    feeRate: 0.001,
    getCurrentPrice: priceProvider,
  });

  const mockConfig = {
    tradeMode: "sim" as const,
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

  const agentManager = new AgentManager(db, {
    defaultStartingBalance: 100,
    feeRate: 0.001,
    getCurrentPrice: priceProvider,
  });

  const agentTradeEngine = new AgentTradeEngine(db, agentManager, mockConfig);

  // Build strategy registry for the pipeline
  const agentStrategies = new Map<string, import("../src/themes/strategy.js").ThemeStrategy>();
  agentStrategies.set("momentum-rotation", new MomentumRotationStrategy());
  agentStrategies.set("congress-follower", new CongressFollowerStrategy());
  agentStrategies.set("agent-driven", new AgentDrivenStrategy());

  // Mock market data service for the pipeline
  const mockMarketData: import("../src/market/market.js").MarketDataService = {
    getQuote: async (symbol: string) => {
      const price = prices.get(symbol) ?? 100;
      return { symbol, price, timestamp: new Date().toISOString(), source: "ccxt" as const };
    },
    getBars: async (_symbol: string) => [],
    getSnapshot: async (symbols: string[]) =>
      symbols.map((s) => ({ symbol: s, price: prices.get(s) ?? 100, timestamp: new Date().toISOString(), source: "ccxt" as const })),
  };

  const agentPipeline = new AgentTradingPipeline({
    agentManager,
    marketData: mockMarketData,
    db,
    strategies: agentStrategies,
    defaultUniverse: ["BTC/USDT", "ETH/USDT"],
  });

  const state: AppState = {
    decisionStore,
    tradeEngine,
    portfolio,
    config: mockConfig as Config,
    currentMode: "sim",
    modeChangedAt: Date.now(),
    db,
    agentManager,
    agentTradeEngine,
    agentPipeline,
  };

  const app = express();
  app.use(express.json());
  app.use("/api", createApiRouter(state));

  return { app, state, agentManager, agentTradeEngine, prices };
}

// ── Tests ──────────────────────────────────────────────────────

describe("Agent API", () => {
  let db: Database;

  beforeEach(async () => {
    db = await openDatabase({ path: ":memory:" });
  });

  afterEach(async () => {
    await closeDatabase(db);
  });

  // ── POST /api/agents ─────────────────────────────────────────

  describe("POST /api/agents", () => {
    it("should register a new agent", async () => {
      const { app } = createTestApp(db);
      const resp = await supertest(app)
        .post("/api/agents")
        .send({
          name: "TestAgent",
          startingBalance: 200,
          strategy: "momentum-rotation",
        });

      expect(resp.status).toBe(201);
      expect(resp.body.agent.name).toBe("TestAgent");
      expect(resp.body.agent.startingBalance).toBe(200);
      expect(resp.body.agent.strategy).toBe("momentum-rotation");
      expect(resp.body.agent.active).toBe(true);
      expect(resp.body.agent.id).toBeTruthy();
    });

    it("should register with defaults", async () => {
      const { app } = createTestApp(db);
      const resp = await supertest(app)
        .post("/api/agents")
        .send({ name: "MinimalAgent" });

      expect(resp.status).toBe(201);
      expect(resp.body.agent.name).toBe("MinimalAgent");
      expect(resp.body.agent.startingBalance).toBe(100); // default
    });

    it("should reject missing name", async () => {
      const { app } = createTestApp(db);
      const resp = await supertest(app)
        .post("/api/agents")
        .send({ startingBalance: 100 });

      expect(resp.status).toBe(400);
    });

    it("should reject empty name", async () => {
      const { app } = createTestApp(db);
      const resp = await supertest(app)
        .post("/api/agents")
        .send({ name: "" });

      expect(resp.status).toBe(400);
    });
  });

  // ── GET /api/agents ──────────────────────────────────────────

  describe("GET /api/agents", () => {
    it("should list all agents with portfolio summaries", async () => {
      const { app, agentManager } = createTestApp(db);
      await agentManager.register("Doom", { startingBalance: 100 });
      await agentManager.register("Kangbot", { startingBalance: 100 });

      const resp = await supertest(app).get("/api/agents");

      expect(resp.status).toBe(200);
      expect(resp.body.agents).toHaveLength(2);
      expect(resp.body.count).toBe(2);
      expect(resp.body.agents[0].name).toBeTruthy();
      expect(resp.body.agents[0].equity).toBe(100);
      expect(resp.body.agents[0].cash).toBe(100);
    });

    it("should return empty list when no agents", async () => {
      const { app } = createTestApp(db);
      const resp = await supertest(app).get("/api/agents");

      expect(resp.status).toBe(200);
      expect(resp.body.agents).toHaveLength(0);
      expect(resp.body.count).toBe(0);
    });
  });

  // ── GET /api/agents/:id ─────────────────────────────────────

  describe("GET /api/agents/:id", () => {
    it("should get agent details by id", async () => {
      const { app, agentManager } = createTestApp(db);
      const agent = await agentManager.register("TestBot", { strategy: "momentum-rotation" });

      const resp = await supertest(app).get(`/api/agents/${agent.id}`);

      expect(resp.status).toBe(200);
      expect(resp.body.agent.name).toBe("TestBot");
      expect(resp.body.agent.strategy).toBe("momentum-rotation");
    });

    it("should return 404 for unknown agent", async () => {
      const { app } = createTestApp(db);
      const resp = await supertest(app).get("/api/agents/nonexistent-id");

      expect(resp.status).toBe(404);
    });
  });

  // ── PATCH /api/agents/:id ────────────────────────────────────

  describe("PATCH /api/agents/:id", () => {
    it("should update agent strategy", async () => {
      const { app, agentManager } = createTestApp(db);
      const agent = await agentManager.register("TestBot", { strategy: "momentum-rotation" });

      const resp = await supertest(app)
        .patch(`/api/agents/${agent.id}`)
        .send({ strategy: "congress-follower" });

      expect(resp.status).toBe(200);
      expect(resp.body.agent.strategy).toBe("congress-follower");
    });

    it("should deactivate agent via active: false", async () => {
      const { app, agentManager } = createTestApp(db);
      const agent = await agentManager.register("TestBot");

      const resp = await supertest(app)
        .patch(`/api/agents/${agent.id}`)
        .send({ active: false });

      expect(resp.status).toBe(200);
      expect(resp.body.agent.active).toBe(false);
    });

    it("should update startingBalance", async () => {
      const { app, agentManager } = createTestApp(db);
      const agent = await agentManager.register("TestBot", { startingBalance: 100 });

      const resp = await supertest(app)
        .patch(`/api/agents/${agent.id}`)
        .send({ startingBalance: 500 });

      expect(resp.status).toBe(200);
      expect(resp.body.agent.startingBalance).toBe(500);
    });

    it("should return 404 for unknown agent", async () => {
      const { app } = createTestApp(db);
      const resp = await supertest(app)
        .patch("/api/agents/nonexistent")
        .send({ strategy: "test" });

      expect(resp.status).toBe(404);
    });
  });

  // ── DELETE /api/agents/:id ───────────────────────────────────

  describe("DELETE /api/agents/:id", () => {
    it("should deactivate an agent", async () => {
      const { app, agentManager } = createTestApp(db);
      const agent = await agentManager.register("TestBot");

      const resp = await supertest(app).delete(`/api/agents/${agent.id}`);

      expect(resp.status).toBe(200);
      expect(resp.body.deactivated).toBe(true);

      const updated = await agentManager.getById(agent.id);
      expect(updated!.active).toBe(false);
    });

    it("should return 404 for unknown agent", async () => {
      const { app } = createTestApp(db);
      const resp = await supertest(app).delete("/api/agents/nonexistent");

      expect(resp.status).toBe(404);
    });
  });

  // ── GET /api/agents/:id/portfolio ────────────────────────────

  describe("GET /api/agents/:id/portfolio", () => {
    it("should return portfolio with equity and cash", async () => {
      const { app, agentManager } = createTestApp(db);
      const agent = await agentManager.register("TestBot", { startingBalance: 100 });

      const resp = await supertest(app).get(`/api/agents/${agent.id}/portfolio`);

      expect(resp.status).toBe(200);
      expect(resp.body.portfolio.cash).toBe(100);
      expect(resp.body.portfolio.equity).toBe(100);
      expect(resp.body.portfolio.initialCash).toBe(100);
      expect(resp.body.portfolio.totalReturnPct).toBe(0);
      expect(resp.body.portfolio.positions).toHaveLength(0);
    });

    it("should return 404 for unknown agent", async () => {
      const { app } = createTestApp(db);
      const resp = await supertest(app).get("/api/agents/nonexistent/portfolio");

      expect(resp.status).toBe(404);
    });
  });

  // ── GET /api/agents/:id/positions ───────────────────────────

  describe("GET /api/agents/:id/positions", () => {
    it("should return empty positions for new agent", async () => {
      const { app, agentManager } = createTestApp(db);
      const agent = await agentManager.register("TestBot");

      const resp = await supertest(app).get(`/api/agents/${agent.id}/positions`);

      expect(resp.status).toBe(200);
      expect(resp.body.positions).toHaveLength(0);
      expect(resp.body.count).toBe(0);
    });

    it("should return positions after a trade", async () => {
      const { app, agentManager } = createTestApp(db);
      const agent = await agentManager.register("TestBot", { startingBalance: 100 });
      const exchange = agentManager.getExchange(agent.id);
      await exchange.placeOrder({
        symbol: "ETH/USDT",
        side: "buy",
        quantity: 1,
        orderType: "limit",
        limitPrice: 50,
      });

      const resp = await supertest(app).get(`/api/agents/${agent.id}/positions`);

      expect(resp.status).toBe(200);
      expect(resp.body.positions).toHaveLength(1);
      expect(resp.body.positions[0].symbol).toBe("ETH/USDT");
      expect(resp.body.positions[0].quantity).toBe(1);
    });

    it("should return 404 for unknown agent", async () => {
      const { app } = createTestApp(db);
      const resp = await supertest(app).get("/api/agents/nonexistent/positions");

      expect(resp.status).toBe(404);
    });
  });

  // ── GET /api/agents/:id/trades ───────────────────────────────

  describe("GET /api/agents/:id/trades", () => {
    it("should return empty trades for new agent", async () => {
      const { app, agentManager } = createTestApp(db);
      const agent = await agentManager.register("TestBot");

      const resp = await supertest(app).get(`/api/agents/${agent.id}/trades`);

      expect(resp.status).toBe(200);
      expect(resp.body.trades).toHaveLength(0);
    });

    it("should return trades after execution", async () => {
      const { app, agentManager } = createTestApp(db);
      const agent = await agentManager.register("TestBot", { startingBalance: 100 });
      const exchange = agentManager.getExchange(agent.id);
      await exchange.placeOrder({
        symbol: "ETH/USDT",
        side: "buy",
        quantity: 1,
        orderType: "limit",
        limitPrice: 50,
      });

      const resp = await supertest(app).get(`/api/agents/${agent.id}/trades`);

      expect(resp.status).toBe(200);
      expect(resp.body.trades).toHaveLength(1);
      expect(resp.body.trades[0].side).toBe("buy");
      expect(resp.body.trades[0].symbol).toBe("ETH/USDT");
    });

    it("should return 404 for unknown agent", async () => {
      const { app } = createTestApp(db);
      const resp = await supertest(app).get("/api/agents/nonexistent/trades");

      expect(resp.status).toBe(404);
    });
  });

  // ── GET /api/agents/:id/analytics ────────────────────────────

  describe("GET /api/agents/:id/analytics", () => {
    it("should return analytics for agent with no trades", async () => {
      const { app, agentManager } = createTestApp(db);
      const agent = await agentManager.register("TestBot");

      const resp = await supertest(app).get(`/api/agents/${agent.id}/analytics`);

      expect(resp.status).toBe(200);
      expect(resp.body.analytics.totalTrades).toBe(0);
      expect(resp.body.analytics.wins).toBe(0);
      expect(resp.body.analytics.losses).toBe(0);
      expect(resp.body.analytics.winRate).toBe(0);
      expect(resp.body.analytics.sharpeRatio).toBe(0);
    });

    it("should return analytics after trades", async () => {
      const { app, agentManager } = createTestApp(db);
      const agent = await agentManager.register("TestBot", { startingBalance: 100 });
      const exchange = agentManager.getExchange(agent.id);

      // Buy then sell for a profit
      await exchange.placeOrder({
        symbol: "ETH/USDT",
        side: "buy",
        quantity: 1,
        orderType: "limit",
        limitPrice: 50,
      });
      await exchange.placeOrder({
        symbol: "ETH/USDT",
        side: "sell",
        quantity: 1,
        orderType: "limit",
        limitPrice: 55,
      });

      const resp = await supertest(app).get(`/api/agents/${agent.id}/analytics`);

      expect(resp.status).toBe(200);
      expect(resp.body.analytics.totalTrades).toBe(2);
      expect(resp.body.analytics.wins).toBe(1);
      expect(resp.body.analytics.losses).toBe(0);
      expect(resp.body.analytics.winRate).toBe(1);
      expect(resp.body.analytics.totalPnl).toBeGreaterThan(0);
    });

    it("should return 404 for unknown agent", async () => {
      const { app } = createTestApp(db);
      const resp = await supertest(app).get("/api/agents/nonexistent/analytics");

      expect(resp.status).toBe(404);
    });
  });

  // ── GET /api/agents/leaderboard ──────────────────────────────

  describe("GET /api/agents/leaderboard", () => {
    it("should return leaderboard ranked by return", async () => {
      const { app, agentManager } = createTestApp(db);
      const doom = await agentManager.register("Doom", { startingBalance: 100 });
      const kangbot = await agentManager.register("Kangbot", { startingBalance: 100 });

      // Give Doom a winning trade
      const doomEx = agentManager.getExchange(doom.id);
      await doomEx.placeOrder({
        symbol: "ETH/USDT",
        side: "buy",
        quantity: 1,
        orderType: "limit",
        limitPrice: 50,
      });
      await doomEx.placeOrder({
        symbol: "ETH/USDT",
        side: "sell",
        quantity: 1,
        orderType: "limit",
        limitPrice: 60,
      });

      const resp = await supertest(app).get("/api/agents/leaderboard");

      expect(resp.status).toBe(200);
      expect(resp.body.leaderboard).toHaveLength(2);
      expect(resp.body.leaderboard[0].rank).toBe(1);
      expect(resp.body.leaderboard[0].name).toBe("Doom");
      expect(resp.body.leaderboard[0].totalReturn).toBeGreaterThan(0);
    });

    it("should return empty leaderboard when no agents", async () => {
      const { app } = createTestApp(db);
      const resp = await supertest(app).get("/api/agents/leaderboard");

      expect(resp.status).toBe(200);
      expect(resp.body.leaderboard).toHaveLength(0);
    });
  });

  // ── POST /api/agents/:id/evaluate ────────────────────────────

  describe("POST /api/agents/:id/evaluate", () => {
    it("should return 404 for unknown agent", async () => {
      const { app } = createTestApp(db);
      const resp = await supertest(app).post("/api/agents/nonexistent/evaluate");
      expect(resp.status).toBe(404);
      expect(resp.body.error).toBe("Agent not found");
    });

    it("should return 409 for agent without strategy", async () => {
      const { app, agentManager } = createTestApp(db);
      const agent = await agentManager.register("NoStrategyBot");
      const resp = await supertest(app).post(`/api/agents/${agent.id}/evaluate`);
      expect(resp.status).toBe(409);
      expect(resp.body.error).toBe("Agent has no strategy assigned");
    });

    it("should return 409 for inactive agent", async () => {
      const { app, agentManager } = createTestApp(db);
      const agent = await agentManager.register("InactiveBot", { strategy: "momentum-rotation" });
      await agentManager.deactivate(agent.id);
      const resp = await supertest(app).post(`/api/agents/${agent.id}/evaluate`);
      expect(resp.status).toBe(409);
      expect(resp.body.error).toBe("Agent is not active");
    });

    it("should evaluate strategy and return result", async () => {
      const { app, agentManager } = createTestApp(db);
      const agent = await agentManager.register("EvalBot", { strategy: "momentum-rotation" });

      const resp = await supertest(app).post(`/api/agents/${agent.id}/evaluate`);

      expect(resp.status).toBe(200);
      expect(resp.body.agentId).toBe(agent.id);
      expect(resp.body.agentName).toBe("EvalBot");
      expect(resp.body.strategy).toBe("momentum-rotation");
      expect(typeof resp.body.equityBefore).toBe("number");
      expect(typeof resp.body.equityAfter).toBe("number");
      expect(typeof resp.body.pnlChange).toBe("number");
      expect(Array.isArray(resp.body.errors)).toBe(true);
    });
  });

  // ── POST /api/admin/reset (agent tables) ────────────────────

  describe("POST /api/admin/reset — agent tables", () => {
    it("should wipe agent trading data but keep agents", async () => {
      const { app, agentManager } = createTestApp(db);
      const agent = await agentManager.register("TestBot", { startingBalance: 100 });
      const exchange = agentManager.getExchange(agent.id);
      await exchange.placeOrder({
        symbol: "ETH/USDT",
        side: "buy",
        quantity: 1,
        orderType: "limit",
        limitPrice: 50,
      });

      // Verify agent has trades and positions
      const tradesBefore = await exchange.getTrades();
      expect(tradesBefore).toHaveLength(1);

      // Reset
      const resp = await supertest(app)
        .post("/api/admin/reset")
        .send({ confirm: "WIPE_ALL_DATA" });

      expect(resp.status).toBe(200);

      // Agent should still exist
      const stillExists = await agentManager.getById(agent.id);
      expect(stillExists).not.toBeNull();

      // But trades and positions should be wiped
      // (Note: exchange cache may still hold data, but DB is wiped)
      const { execGet, convertPlaceholders } = await import("../src/db/database.js");
      const tradeCount = await execGet<{ count: number }>(
        db,
        convertPlaceholders("SELECT COUNT(*) as count FROM agent_orders WHERE agent_id = ?", db.backend),
        [agent.id],
      );
      expect(tradeCount?.count ?? 0).toBe(0);
    });
  });

  // ── Agent name flexibility ───────────────────────────────────

  describe("Agent name flexibility (decisions table constraint)", () => {
    it("should accept decisions with any agent name", async () => {
      const { app } = createTestApp(db);
      const resp = await supertest(app)
        .post("/api/decisions")
        .send({
          agent: "ThanosBot",
          symbol: "AAPL",
          action: "buy",
          quantity: 10,
          priceAtDecision: 185,
          rationale: "Test",
          confidence: 7,
          mode: "sim",
        });

      expect(resp.status).toBe(201);
      expect(resp.body.decision.agent).toBe("ThanosBot");
    });

    it("should accept decisions with custom agent names", async () => {
      const { app } = createTestApp(db);
      const resp = await supertest(app)
        .post("/api/decisions")
        .send({
          agent: "CustomAgent42",
          symbol: "BTC/USDT",
          action: "hold",
          quantity: 1,
          priceAtDecision: 50000,
          rationale: "Waiting for better entry",
          confidence: 5,
          mode: "sim",
        });

      expect(resp.status).toBe(201);
      expect(resp.body.decision.agent).toBe("CustomAgent42");
    });
  });
});