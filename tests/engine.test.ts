import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import { openDatabase, closeDatabase } from "../src/db/database.js";
import { SimulatedExchange } from "../src/executor/simulated.js";
import type {
  Balance,
  Executor,
  OrderRequest,
  OrderResult,
  Position,
} from "../src/executor/executor.js";
import { DecisionStore } from "../src/decision/decision-store.js";
import type { CreateDecisionInput, Decision } from "../src/decision/decision.js";
import {
  TradeEngine,
  RiskCheckError,
  isCrypto,
  type RiskConfig,
} from "../src/engine/trade-engine.js";

// ── Mock executor ──────────────────────────────────────────

interface MockState {
  balance: Balance;
  positions: Position[];
}

function createMockExecutor(
  name: string,
  state: MockState,
): Executor & { lastOrder: OrderRequest | null } {
  const impl: Executor & { lastOrder: OrderRequest | null } = {
    name,
    lastOrder: null,
    async placeOrder(order: OrderRequest): Promise<OrderResult> {
      impl.lastOrder = order;
      return {
        id: crypto.randomUUID(),
        clientOrderId: order.clientOrderId,
        symbol: order.symbol,
        side: order.side,
        orderType: order.orderType,
        quantity: order.quantity,
        fillPrice: order.limitPrice ?? 100,
        status: "filled",
        fee: 0.5,
        realizedPnl: 0,
        timestamp: new Date().toISOString(),
      };
    },
    async cancelOrder(): Promise<boolean> {
      return false;
    },
    async getPositions(): Promise<Position[]> {
      return state.positions;
    },
    async getBalance(): Promise<Balance> {
      return state.balance;
    },
  };
  return impl;
}

function defaultMockBalance(): Balance {
  return {
    cash: 100_000,
    equity: 100_000,
    initialCash: 100_000,
    peakEquity: 100_000,
  };
}

// ── Test setup ─────────────────────────────────────────────

describe("TradeEngine", () => {
  let db: DatabaseType;
  let sim: SimulatedExchange;
  let store: DecisionStore;
  const prices = new Map<string, number>();
  const priceProvider = (symbol: string) => prices.get(symbol) ?? null;

  beforeEach(() => {
    db = openDatabase({ path: ":memory:" });
    prices.clear();
    prices.set("AAPL", 185.0);
    prices.set("BTC/USDT", 65_000.0);
    prices.set("MSFT", 420.0);
    sim = new SimulatedExchange(db, {
      getCurrentPrice: priceProvider,
      feeRate: 0.001,
    });
    store = new DecisionStore(db);
  });

  afterEach(() => {
    closeDatabase(db);
  });

  function makeDecision(overrides: Partial<CreateDecisionInput> = {}): Decision {
    return store.create({
      agent: "kangbot",
      symbol: "AAPL",
      action: "buy",
      quantity: 10,
      priceAtDecision: 185.0,
      rationale: "Bullish signal",
      confidence: 8,
      mode: "sim",
      ...overrides,
    });
  }

  // ── isCrypto helper ─────────────────────────────────────

  describe("isCrypto", () => {
    it("returns true for crypto symbols with slash", () => {
      expect(isCrypto("BTC/USDT")).toBe(true);
      expect(isCrypto("ETH/USDT")).toBe(true);
    });

    it("returns false for stock symbols", () => {
      expect(isCrypto("AAPL")).toBe(false);
      expect(isCrypto("MSFT")).toBe(false);
    });
  });

  // ── Sim routing ─────────────────────────────────────────

  describe("sim routing", () => {
    it("routes to simulated executor in sim mode", async () => {
      const engine = new TradeEngine({
        db,
        mode: "sim",
        executors: { simulated: sim },
      });
      const decision = makeDecision({ symbol: "AAPL", quantity: 10 });
      const result = await engine.execute(decision);

      expect(result.status).toBe("filled");
      expect(result.executor).toBe("simulated");
      expect(result.mode).toBe("sim");
      expect(result.symbol).toBe("AAPL");
      expect(result.side).toBe("buy");
      expect(result.fillPrice).toBe(185.0);
      expect(result.quantity).toBe(10);

      // Verify the sim actually processed it
      const positions = await sim.getPositions();
      expect(positions).toHaveLength(1);
      expect(positions[0].symbol).toBe("AAPL");
    });

    it("routes crypto symbols to simulated executor in sim mode", async () => {
      const engine = new TradeEngine({
        db,
        mode: "sim",
        executors: { simulated: sim },
      });
      const decision = makeDecision({
        symbol: "BTC/USDT",
        quantity: 0.1,
        priceAtDecision: 65_000,
      });
      const result = await engine.execute(decision);

      expect(result.status).toBe("filled");
      expect(result.executor).toBe("simulated");
      expect(result.symbol).toBe("BTC/USDT");
    });
  });

  // ── Live routing ────────────────────────────────────────

  describe("live routing", () => {
    it("routes stocks to alpaca executor in live mode", async () => {
      const alpaca = createMockExecutor("alpaca", {
        balance: defaultMockBalance(),
        positions: [],
      });
      const engine = new TradeEngine({
        db,
        mode: "live",
        executors: { simulated: sim, alpaca },
      });
      const decision = makeDecision({
        symbol: "AAPL",
        mode: "live",
        quantity: 10,
        priceAtDecision: 185.0,
      });
      const result = await engine.execute(decision);

      expect(result.status).toBe("filled");
      expect(result.executor).toBe("alpaca");
      expect(result.mode).toBe("live");
      expect(alpaca.lastOrder).not.toBeNull();
      expect(alpaca.lastOrder!.symbol).toBe("AAPL");
    });

    it("routes crypto to ccxt executor in live mode", async () => {
      const ccxt = createMockExecutor("ccxt", {
        balance: defaultMockBalance(),
        positions: [],
      });
      const engine = new TradeEngine({
        db,
        mode: "live",
        executors: { simulated: sim, ccxt },
      });
      const decision = makeDecision({
        symbol: "BTC/USDT",
        mode: "live",
        quantity: 0.1,
        priceAtDecision: 65_000,
      });
      const result = await engine.execute(decision);

      expect(result.status).toBe("filled");
      expect(result.executor).toBe("ccxt");
      expect(result.mode).toBe("live");
      expect(ccxt.lastOrder).not.toBeNull();
      expect(ccxt.lastOrder!.symbol).toBe("BTC/USDT");
    });

    it("throws when no alpaca executor configured for live stock", async () => {
      const engine = new TradeEngine({
        db,
        mode: "live",
        executors: { simulated: sim },
      });
      const decision = makeDecision({ symbol: "AAPL", mode: "live" });
      await expect(engine.execute(decision)).rejects.toThrow(RiskCheckError);
    });

    it("throws when no ccxt executor configured for live crypto", async () => {
      const engine = new TradeEngine({
        db,
        mode: "live",
        executors: { simulated: sim },
      });
      const decision = makeDecision({
        symbol: "BTC/USDT",
        mode: "live",
      });
      await expect(engine.execute(decision)).rejects.toThrow(RiskCheckError);
    });
  });

  // ── Hold action ─────────────────────────────────────────

  describe("hold action", () => {
    it("returns skipped status for hold action", async () => {
      const engine = new TradeEngine({
        db,
        mode: "sim",
        executors: { simulated: sim },
      });
      const decision = makeDecision({ action: "hold" });
      const result = await engine.execute(decision);

      expect(result.status).toBe("skipped");
      expect(result.fillPrice).toBeNull();
      expect(result.fee).toBe(0);
      expect(result.realizedPnl).toBe(0);

      // No trade recorded
      const trades = engine.getTrades();
      expect(trades).toHaveLength(0);

      // No position created
      const positions = await sim.getPositions();
      expect(positions).toHaveLength(0);
    });
  });

  // ── Risk checks ─────────────────────────────────────────

  describe("risk checks", () => {
    describe("max open positions", () => {
      it("throws when max open positions reached for a new position", async () => {
        const riskConfig: Partial<RiskConfig> = { maxOpenPositions: 2 };
        const engine = new TradeEngine({
          db,
          mode: "sim",
          executors: { simulated: sim },
          riskConfig,
        });

        // Fill 2 positions (the max)
        await engine.execute(
          makeDecision({ symbol: "AAPL", quantity: 10 }),
        );
        await engine.execute(
          makeDecision({ symbol: "MSFT", quantity: 10, priceAtDecision: 420 }),
        );

        // Third new position should fail
        const thirdDecision = makeDecision({
          symbol: "GOOGL",
          quantity: 10,
          priceAtDecision: 150,
        });
        prices.set("GOOGL", 150);
        await expect(engine.execute(thirdDecision)).rejects.toMatchObject({
          check: "max_open_positions",
        });
      });

      it("allows adding to existing position when at max", async () => {
        const riskConfig: Partial<RiskConfig> = {
          maxOpenPositions: 1,
          duplicateOrderWindowMs: 1, // effectively disabled
        };
        const engine = new TradeEngine({
          db,
          mode: "sim",
          executors: { simulated: sim },
          riskConfig,
        });

        // First position
        await engine.execute(
          makeDecision({ symbol: "AAPL", quantity: 10 }),
        );

        // Wait for duplicate window to pass
        await new Promise((r) => setTimeout(r, 10));

        // Adding to the same position should be allowed
        const result = await engine.execute(
          makeDecision({ symbol: "AAPL", quantity: 5 }),
        );
        expect(result.status).toBe("filled");
      });
    });

    describe("max position size", () => {
      it("throws when order notional exceeds max position size pct", async () => {
        const engine = new TradeEngine({
          db,
          mode: "sim",
          executors: { simulated: sim },
          riskConfig: { maxPositionSizePct: 0.1 }, // 10%
        });

        // 10 * 185 = 1850, equity 100000 → 1.85% — under
        // Let's make it over: 100 * 185 = 18500 → 18.5%
        const decision = makeDecision({ quantity: 100, priceAtDecision: 185 });
        await expect(engine.execute(decision)).rejects.toMatchObject({
          check: "max_position_size",
        });
      });

      it("allows order within max position size", async () => {
        const engine = new TradeEngine({
          db,
          mode: "sim",
          executors: { simulated: sim },
          riskConfig: { maxPositionSizePct: 0.2 }, // 20%
        });

        // 10 * 185 = 1850, equity 100000 → 1.85% — under
        const result = await engine.execute(
          makeDecision({ quantity: 10, priceAtDecision: 185 }),
        );
        expect(result.status).toBe("filled");
      });
    });

    describe("daily trade limit", () => {
      it("throws when daily trade limit reached", async () => {
        const engine = new TradeEngine({
          db,
          mode: "sim",
          executors: { simulated: sim },
          riskConfig: { dailyTradeLimit: 2 },
        });

        // Execute 2 trades (fills the limit)
        await engine.execute(
          makeDecision({ symbol: "AAPL", quantity: 10 }),
        );
        await engine.execute(
          makeDecision({
            symbol: "MSFT",
            quantity: 10,
            priceAtDecision: 420,
          }),
        );

        // Third trade should fail
        const decision = makeDecision({
          symbol: "GOOGL",
          quantity: 10,
          priceAtDecision: 150,
        });
        prices.set("GOOGL", 150);
        await expect(engine.execute(decision)).rejects.toMatchObject({
          check: "daily_trade_limit",
        });
      });

      it("getDailyTradeCount returns correct count", async () => {
        const engine = new TradeEngine({
          db,
          mode: "sim",
          executors: { simulated: sim },
        });

        expect(engine.getDailyTradeCount()).toBe(0);
        await engine.execute(
          makeDecision({ symbol: "AAPL", quantity: 10 }),
        );
        expect(engine.getDailyTradeCount()).toBe(1);
        await engine.execute(
          makeDecision({
            symbol: "MSFT",
            quantity: 10,
            priceAtDecision: 420,
          }),
        );
        expect(engine.getDailyTradeCount()).toBe(2);
      });
    });

    describe("max drawdown", () => {
      it("throws when drawdown exceeds max pct", async () => {
        // Use a mock executor with a drawdown already baked in
        const mockSim = createMockExecutor("simulated", {
          balance: {
            cash: 80_000,
            equity: 80_000,
            initialCash: 100_000,
            peakEquity: 100_000,
          },
          positions: [],
        });
        const engine = new TradeEngine({
          db,
          mode: "sim",
          executors: { simulated: mockSim },
          riskConfig: { maxDrawdownPct: 0.15 },
        });

        // Drawdown = (100000 - 80000) / 100000 = 20% > 15%
        const decision = makeDecision({ quantity: 10 });
        await expect(engine.execute(decision)).rejects.toMatchObject({
          check: "max_drawdown",
        });
      });

      it("allows trade when drawdown is within limit", async () => {
        const mockSim = createMockExecutor("simulated", {
          balance: {
            cash: 90_000,
            equity: 90_000,
            initialCash: 100_000,
            peakEquity: 100_000,
          },
          positions: [],
        });
        const engine = new TradeEngine({
          db,
          mode: "sim",
          executors: { simulated: mockSim },
          riskConfig: { maxDrawdownPct: 0.15 },
        });

        // Drawdown = 10% < 15%
        const result = await engine.execute(makeDecision({ quantity: 10 }));
        expect(result.status).toBe("filled");
      });
    });

    describe("duplicate order detection", () => {
      it("throws when same symbol+side traded within window", async () => {
        const engine = new TradeEngine({
          db,
          mode: "sim",
          executors: { simulated: sim },
          riskConfig: { duplicateOrderWindowMs: 60_000 },
        });

        // First trade succeeds
        await engine.execute(
          makeDecision({ symbol: "AAPL", quantity: 10 }),
        );

        // Second trade same symbol+side within window should fail
        await expect(
          engine.execute(
            makeDecision({ symbol: "AAPL", quantity: 10 }),
          ),
        ).rejects.toMatchObject({ check: "duplicate_order" });
      });

      it("allows different symbol within window", async () => {
        const engine = new TradeEngine({
          db,
          mode: "sim",
          executors: { simulated: sim },
          riskConfig: { duplicateOrderWindowMs: 60_000 },
        });

        await engine.execute(
          makeDecision({ symbol: "AAPL", quantity: 10 }),
        );

        // Different symbol should be fine
        const result = await engine.execute(
          makeDecision({
            symbol: "MSFT",
            quantity: 10,
            priceAtDecision: 420,
          }),
        );
        expect(result.status).toBe("filled");
      });

      it("allows opposite side within window", async () => {
        const engine = new TradeEngine({
          db,
          mode: "sim",
          executors: { simulated: sim },
          riskConfig: { duplicateOrderWindowMs: 60_000 },
        });

        // Buy first
        await engine.execute(
          makeDecision({ symbol: "AAPL", quantity: 10 }),
        );

        // Sell same symbol — should be allowed (different side)
        const result = await engine.execute(
          makeDecision({
            symbol: "AAPL",
            action: "sell",
            quantity: 10,
            priceAtDecision: 190,
          }),
        );
        expect(result.status).toBe("filled");
      });

      it("allows trade after window expires", async () => {
        const engine = new TradeEngine({
          db,
          mode: "sim",
          executors: { simulated: sim },
          riskConfig: { duplicateOrderWindowMs: 100 }, // 100ms
        });

        await engine.execute(
          makeDecision({ symbol: "AAPL", quantity: 10 }),
        );

        // Wait for window to expire
        await new Promise((r) => setTimeout(r, 150));

        const result = await engine.execute(
          makeDecision({ symbol: "AAPL", quantity: 5 }),
        );
        expect(result.status).toBe("filled");
      });
    });

    describe("RiskCheckError", () => {
      it("has a check field identifying the failed check", () => {
        const err = new RiskCheckError("max_drawdown", "too much drawdown");
        expect(err.check).toBe("max_drawdown");
        expect(err.message).toBe("too much drawdown");
        expect(err.name).toBe("RiskCheckError");
        expect(err instanceof Error).toBe(true);
      });
    });
  });

  // ── Post-trade logging ──────────────────────────────────

  describe("post-trade logging", () => {
    it("records the trade in SQLite after execution", async () => {
      const engine = new TradeEngine({
        db,
        mode: "sim",
        executors: { simulated: sim },
      });
      const decision = makeDecision({ symbol: "AAPL", quantity: 10 });
      const result = await engine.execute(decision);

      const trades = engine.getTrades();
      expect(trades).toHaveLength(1);

      const trade = trades[0];
      expect(trade.id).toBe(result.tradeId);
      expect(trade.decision_id).toBe(decision.id);
      expect(trade.symbol).toBe("AAPL");
      expect(trade.side).toBe("buy");
      expect(trade.quantity).toBe(10);
      expect(trade.status).toBe("filled");
      expect(trade.mode).toBe("sim");
      expect(trade.executor).toBe("simulated");
      expect(trade.fill_price).toBe(185.0);
    });

    it("does not record a trade for hold actions", async () => {
      const engine = new TradeEngine({
        db,
        mode: "sim",
        executors: { simulated: sim },
      });
      await engine.execute(makeDecision({ action: "hold" }));

      expect(engine.getTrades()).toHaveLength(0);
    });

    it("records rejected orders in trades table", async () => {
      // Use a mock executor that rejects
      const rejectingExecutor: Executor = {
        name: "simulated",
        async placeOrder(order: OrderRequest): Promise<OrderResult> {
          return {
            id: crypto.randomUUID(),
            clientOrderId: order.clientOrderId,
            symbol: order.symbol,
            side: order.side,
            orderType: order.orderType,
            quantity: order.quantity,
            fillPrice: null,
            status: "rejected",
            fee: 0,
            realizedPnl: 0,
            error: "Exchange rejected",
            timestamp: new Date().toISOString(),
          };
        },
        async cancelOrder(): Promise<boolean> {
          return false;
        },
        async getPositions(): Promise<Position[]> {
          return [];
        },
        async getBalance(): Promise<Balance> {
          return defaultMockBalance();
        },
      };

      const engine = new TradeEngine({
        db,
        mode: "sim",
        executors: { simulated: rejectingExecutor },
      });
      const result = await engine.execute(makeDecision({ quantity: 10 }));

      expect(result.status).toBe("rejected");
      expect(result.error).toBe("Exchange rejected");

      const trades = engine.getTrades();
      expect(trades).toHaveLength(1);
      expect(trades[0].status).toBe("rejected");
      expect(trades[0].error).toBe("Exchange rejected");
    });

    it("getTrades filters by symbol", async () => {
      const engine = new TradeEngine({
        db,
        mode: "sim",
        executors: { simulated: sim },
      });
      await engine.execute(makeDecision({ symbol: "AAPL", quantity: 10 }));
      await engine.execute(
        makeDecision({
          symbol: "MSFT",
          quantity: 10,
          priceAtDecision: 420,
        }),
      );

      const aaplTrades = engine.getTrades({ symbol: "AAPL" });
      expect(aaplTrades).toHaveLength(1);
      expect(aaplTrades[0].symbol).toBe("AAPL");
    });
  });

  // ── Portfolio snapshot ──────────────────────────────────

  describe("portfolio snapshot", () => {
    it("includes portfolio snapshot in result", async () => {
      const engine = new TradeEngine({
        db,
        mode: "sim",
        executors: { simulated: sim },
      });
      const decision = makeDecision({ symbol: "AAPL", quantity: 10 });
      const result = await engine.execute(decision);

      expect(result.portfolioSnapshot).toBeDefined();
      expect(result.portfolioSnapshot).toHaveProperty("cash");
      expect(result.portfolioSnapshot).toHaveProperty("equity");
      expect(result.portfolioSnapshot).toHaveProperty("positions");
      expect(Array.isArray(result.portfolioSnapshot.positions)).toBe(true);
    });

    it("includes portfolio snapshot with cash/equity from executor", async () => {
      // We need to enhance the engine to populate the snapshot.
      // The recordTrade method builds a snapshot; let's verify it works
      // by checking the result has numeric cash and equity.
      const engine = new TradeEngine({
        db,
        mode: "sim",
        executors: { simulated: sim },
      });
      const result = await engine.execute(
        makeDecision({ symbol: "AAPL", quantity: 10 }),
      );

      expect(typeof result.portfolioSnapshot.cash).toBe("number");
      expect(typeof result.portfolioSnapshot.equity).toBe("number");
    });
  });

  // ── TradeResult fields ──────────────────────────────────

  describe("trade result", () => {
    it("returns a complete TradeResult object", async () => {
      const engine = new TradeEngine({
        db,
        mode: "sim",
        executors: { simulated: sim },
      });
      const decision = makeDecision({ symbol: "AAPL", quantity: 10 });
      const result = await engine.execute(decision);

      expect(result.tradeId).toBeTruthy();
      expect(result.decisionId).toBe(decision.id);
      expect(result.status).toBe("filled");
      expect(result.symbol).toBe("AAPL");
      expect(result.side).toBe("buy");
      expect(result.quantity).toBe(10);
      expect(result.fillPrice).toBe(185.0);
      expect(typeof result.fee).toBe("number");
      expect(typeof result.realizedPnl).toBe("number");
      expect(result.mode).toBe("sim");
      expect(result.executor).toBe("simulated");
      expect(result.timestamp).toBeTruthy();
    });
  });
});