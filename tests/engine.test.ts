import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import type { Database } from "../src/db/database.js";
import {
  openDatabase,
  closeDatabase,
  execAll,
} from "../src/db/database.js";
import {
  SimulatedExchange,
} from "../src/executor/simulated.js";
import { TradeEngine } from "../src/engine/trade-engine.js";
import type { Decision } from "../src/decision/decision.js";
import type { Config } from "../src/config.js";

describe("TradeEngine", () => {
  let db: Database;
  let sim: SimulatedExchange;
  let engine: TradeEngine;

  // Price provider for the simulated exchange
  const prices = new Map<string, number>();
  const priceProvider = (symbol: string) => prices.get(symbol) ?? null;

  // Risk config matching the PLAN.md defaults
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

  beforeEach(async () => {
    db = await openDatabase({ path: ":memory:" });
    prices.clear();
    prices.set("AAPL", 185.0);
    prices.set("BTC/USDT", 65000.0);
    prices.set("MSFT", 420.0);
    sim = new SimulatedExchange(db, {
      getCurrentPrice: priceProvider,
      feeRate: 0.001,
    });
    engine = new TradeEngine(db, sim, riskConfig);
  });

  afterEach(async () => {
    await closeDatabase(db);
  });

  /** Helper: build a Decision object */
  function makeDecision(overrides: Partial<Decision> = {}): Decision {
    return {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      agent: "kangbot",
      symbol: "AAPL",
      action: "buy",
      quantity: 100,
      priceAtDecision: 185.0,
      rationale: "Bullish signal",
      confidence: 8,
      mode: "sim",
      marketContext: undefined,
      ...overrides,
    };
  }

  // ── Basic execution ───────────────────────────────────────────

  describe("executeDecision — happy path", () => {
    it("should execute a market buy decision", async () => {
      const decision = makeDecision({ action: "buy", symbol: "AAPL", quantity: 100 });
      const result = await engine.executeDecision({ decision });

      expect(result.riskPassed).toBe(true);
      expect(result.orderResult).not.toBeNull();
      expect(result.orderResult!.status).toBe("filled");
      expect(result.orderResult!.fillPrice).toBe(185.0);
      expect(result.orderResult!.side).toBe("buy");
    });

    it("should execute a market sell decision", async () => {
      // Buy first to establish a position
      const buyDecision = makeDecision({ action: "buy", symbol: "AAPL", quantity: 100 });
      await engine.executeDecision({ decision: buyDecision });

      // Now sell
      prices.set("AAPL", 195.0);
      const sellDecision = makeDecision({ action: "sell", symbol: "AAPL", quantity: 100, priceAtDecision: 195.0 });
      const result = await engine.executeDecision({ decision: sellDecision });

      expect(result.riskPassed).toBe(true);
      expect(result.orderResult!.status).toBe("filled");
      expect(result.orderResult!.fillPrice).toBe(195.0);
      expect(result.orderResult!.realizedPnl).toBeCloseTo(980.5, 1);
    });

    it("should support limit orders via orderType param", async () => {
      const decision = makeDecision({ action: "buy", symbol: "AAPL", quantity: 100 });
      const result = await engine.executeDecision({
        decision,
        orderType: "limit",
        limitPrice: 190.0, // above current 185, should fill immediately
      });

      expect(result.orderResult!.status).toBe("filled");
      expect(result.orderResult!.fillPrice).toBe(190.0);
    });

    it("should hold without trading", async () => {
      const decision = makeDecision({ action: "hold" });
      const result = await engine.executeDecision({ decision });

      expect(result.riskPassed).toBe(true);
      expect(result.orderResult).toBeNull();
      expect(result.tradeRecord).toBeNull();
      expect(result.riskChecks).toHaveLength(0);
    });
  });

  // ── Trade logging ─────────────────────────────────────────────

  describe("trade logging", () => {
    it("should log a filled trade to the trades table", async () => {
      const decision = makeDecision({ action: "buy" });
      const result = await engine.executeDecision({ decision });

      expect(result.tradeRecord).not.toBeNull();
      expect(result.tradeRecord!.decisionId).toBe(decision.id);
      expect(result.tradeRecord!.symbol).toBe("AAPL");
      expect(result.tradeRecord!.side).toBe("buy");
      expect(result.tradeRecord!.status).toBe("filled");
      expect(result.tradeRecord!.mode).toBe("sim");
      expect(result.tradeRecord!.executor).toBe("simulated");
      expect(result.tradeRecord!.fillPrice).toBe(185.0);
      expect(result.tradeRecord!.fee).toBeCloseTo(18.5, 2);
    });

    it("should log a rejected trade with error message", async () => {
      // Insufficient cash: 10 BTC * 65000 = 650,000 > 100,000
      const decision = makeDecision({
        action: "buy",
        symbol: "BTC/USDT",
        quantity: 10,
        priceAtDecision: 65000.0,
      });
      const result = await engine.executeDecision({ decision });

      // Risk checks pass (position size check: 10*65000=650k > 20% of 100k=20k → fails)
      expect(result.riskPassed).toBe(false);
      expect(result.tradeRecord).not.toBeNull();
      expect(result.tradeRecord!.status).toBe("rejected");
      expect(result.tradeRecord!.error).toContain("maxPositionSize");
      expect(result.tradeRecord!.fillPrice).toBeNull();
      expect(result.tradeRecord!.fee).toBe(0);
    });

    it("should retrieve a trade by id", async () => {
      const decision = makeDecision({ action: "buy" });
      const result = await engine.executeDecision({ decision });
      const trade = await engine.getTrade(result.tradeRecord!.id);

      expect(trade).not.toBeNull();
      expect(trade!.id).toBe(result.tradeRecord!.id);
      expect(trade!.symbol).toBe("AAPL");
    });

    it("should list trades filtered by symbol", async () => {
      await engine.executeDecision({ decision: makeDecision({ action: "buy", symbol: "AAPL" }) });
      await engine.executeDecision({ decision: makeDecision({ action: "buy", symbol: "MSFT" }) });

      const aaplTrades = await engine.listTrades({ symbol: "AAPL" });
      expect(aaplTrades).toHaveLength(1);
      expect(aaplTrades[0].symbol).toBe("AAPL");
    });

    it("should list trades filtered by status", async () => {
      await engine.executeDecision({ decision: makeDecision({ action: "buy", symbol: "AAPL" }) });
      // Create a rejected trade
      await engine.executeDecision({
        decision: makeDecision({ action: "buy", symbol: "BTC/USDT", quantity: 10, priceAtDecision: 65000 }),
      });

      const filled = await engine.listTrades({ status: "filled" });
      const rejected = await engine.listTrades({ status: "rejected" });

      expect(filled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
    });

    it("should get trades for a decision", async () => {
      const decision = makeDecision({ action: "buy" });
      const result = await engine.executeDecision({ decision });

      const trades = await engine.getTradesForDecision(decision.id);
      expect(trades).toHaveLength(1);
      expect(trades[0].id).toBe(result.tradeRecord!.id);
    });
  });

  // ── Risk checks: max open positions ───────────────────────────

  describe("risk check: maxOpenPositions", () => {
    it("should pass when under the limit", async () => {
      const decision = makeDecision({ action: "buy", symbol: "AAPL" });
      const result = await engine.executeDecision({ decision });

      const check = result.riskChecks.find((c) => c.check === "maxOpenPositions");
      expect(check).toBeDefined();
      expect(check!.passed).toBe(true);
    });

    it("should pass when adding to an existing position", async () => {
      // Buy AAPL — first position
      await engine.executeDecision({ decision: makeDecision({ action: "buy", symbol: "AAPL", quantity: 10 }) });

      // Buy more AAPL — should not count as new position
      const result = await engine.executeDecision({
        decision: makeDecision({ action: "buy", symbol: "AAPL", quantity: 10 }),
      });

      const check = result.riskChecks.find((c) => c.check === "maxOpenPositions");
      expect(check!.passed).toBe(true);
    });

    it("should fail when max open positions reached with a new symbol", async () => {
      // Set a tight limit
      const tightEngine = new TradeEngine(db, sim, {
        ...riskConfig,
        maxOpenPositions: 2,
      });

      // Buy 3 different symbols
      await tightEngine.executeDecision({ decision: makeDecision({ action: "buy", symbol: "AAPL", quantity: 10 }) });
      prices.set("GOOGL", 140.0);
      await tightEngine.executeDecision({ decision: makeDecision({ action: "buy", symbol: "GOOGL", quantity: 10, priceAtDecision: 140 }) });

      // Third new symbol should fail
      prices.set("TSLA", 250.0);
      const result = await tightEngine.executeDecision({
        decision: makeDecision({ action: "buy", symbol: "TSLA", quantity: 10, priceAtDecision: 250 }),
      });

      const check = result.riskChecks.find((c) => c.check === "maxOpenPositions");
      expect(check!.passed).toBe(false);
      expect(check!.reason).toContain("Max open positions");
      expect(result.riskPassed).toBe(false);
      expect(result.tradeRecord!.status).toBe("rejected");
    });
  });

  // ── Risk checks: max position size ────────────────────────────

  describe("risk check: maxPositionSize", () => {
    it("should pass when order is within position size limit", async () => {
      // 100 * 185 = 18500, 20% of 100k = 20000 → passes
      const decision = makeDecision({ action: "buy", quantity: 100, priceAtDecision: 185 });
      const result = await engine.executeDecision({ decision });

      const check = result.riskChecks.find((c) => c.check === "maxPositionSize");
      expect(check!.passed).toBe(true);
    });

    it("should fail when order exceeds position size limit", async () => {
      // 200 * 185 = 37000 > 20% of 100k = 20000 → fails
      const decision = makeDecision({ action: "buy", quantity: 200, priceAtDecision: 185 });
      const result = await engine.executeDecision({ decision });

      const check = result.riskChecks.find((c) => c.check === "maxPositionSize");
      expect(check!.passed).toBe(false);
      expect(check!.reason).toContain("exceeds");
      expect(result.riskPassed).toBe(false);
    });

    it("should not apply position size check to sells", async () => {
      // Buy first
      await engine.executeDecision({ decision: makeDecision({ action: "buy", quantity: 100 }) });

      // Sell — should not have maxPositionSize check
      prices.set("AAPL", 195);
      const result = await engine.executeDecision({
        decision: makeDecision({ action: "sell", quantity: 100, priceAtDecision: 195 }),
      });

      const check = result.riskChecks.find((c) => c.check === "maxPositionSize");
      expect(check).toBeUndefined();
    });
  });

  // ── Risk checks: daily trade limit ────────────────────────────

  describe("risk check: dailyTradeLimit", () => {
    it("should pass when under the daily limit", async () => {
      const result = await engine.executeDecision({ decision: makeDecision({ action: "buy", quantity: 10 }) });

      const check = result.riskChecks.find((c) => c.check === "dailyTradeLimit");
      expect(check!.passed).toBe(true);
    });

    it("should fail when daily trade limit is reached", async () => {
      const tightEngine = new TradeEngine(db, sim, {
        ...riskConfig,
        dailyTradeLimit: 2,
      });

      // Make 2 successful trades
      await tightEngine.executeDecision({ decision: makeDecision({ action: "buy", symbol: "AAPL", quantity: 10 }) });
      prices.set("MSFT", 420);
      await tightEngine.executeDecision({ decision: makeDecision({ action: "buy", symbol: "MSFT", quantity: 10, priceAtDecision: 420 }) });

      // Third trade should fail daily limit
      prices.set("GOOGL", 140);
      const result = await tightEngine.executeDecision({
        decision: makeDecision({ action: "buy", symbol: "GOOGL", quantity: 10, priceAtDecision: 140 }),
      });

      const check = result.riskChecks.find((c) => c.check === "dailyTradeLimit");
      expect(check!.passed).toBe(false);
      expect(check!.reason).toContain("Daily trade limit");
    });

    it("should not count rejected trades toward daily limit", async () => {
      const tightEngine = new TradeEngine(db, sim, {
        ...riskConfig,
        dailyTradeLimit: 1,
      });

      // This trade will be rejected by position size (200 * 185 = 37000 > 20000)
      await tightEngine.executeDecision({
        decision: makeDecision({ action: "buy", quantity: 200, priceAtDecision: 185 }),
      });

      // This valid trade should still pass the daily limit
      const result = await tightEngine.executeDecision({
        decision: makeDecision({ action: "buy", symbol: "AAPL", quantity: 10, priceAtDecision: 185 }),
      });

      const check = result.riskChecks.find((c) => c.check === "dailyTradeLimit");
      expect(check!.passed).toBe(true);
    });
  });

  // ── Risk checks: max drawdown ─────────────────────────────────

  describe("risk check: maxDrawdown", () => {
    it("should pass when drawdown is within limit", async () => {
      const result = await engine.executeDecision({ decision: makeDecision({ action: "buy", quantity: 10 }) });
      const check = result.riskChecks.find((c) => c.check === "maxDrawdown");
      expect(check!.passed).toBe(true);
    });

    it("should fail when drawdown exceeds limit", async () => {
      // Buy a large position
      await engine.executeDecision({ decision: makeDecision({ action: "buy", quantity: 100 }) });
      // 100 * 185 = 18500 + fee 18.5 → cash = 81481.5, equity = 100000

      // Price drops hard → big drawdown
      // 100 * 100 = 10000 → equity = 81481.5 + 10000 = 91481.5
      // drawdown = (100000 - 91481.5) / 100000 = 8.5% → under 15%
      prices.set("AAPL", 100.0);

      // Buy another symbol to test — drawdown is under 15%, should pass
      prices.set("MSFT", 420);
      let result = await engine.executeDecision({
        decision: makeDecision({ action: "buy", symbol: "MSFT", quantity: 10, priceAtDecision: 420 }),
      });
      let check = result.riskChecks.find((c) => c.check === "maxDrawdown");
      expect(check!.passed).toBe(true);

      // Now crash AAPL further: 100 * 50 = 5000
      // equity ≈ 81481.5 + 5000 + MSFT position...
      // MSFT: 10 * 420 = 4200, cost was 4200 + 4.2 = 4204.2 → cash ≈ 81481.5 - 4204.2 = 77277.3
      // equity = 77277.3 + 5000 + 4200 = 86477.3
      // drawdown = (100000 - 86477.3) / 100000 = 13.5% → still under 15%
      // Push further
      prices.set("AAPL", 30.0);
      // AAPL value = 100 * 30 = 3000
      // equity = 77277.3 + 3000 + 4200 = 84477.3
      // drawdown = (100000 - 84477.3) / 100000 = 15.5% → exceeds 15%
      prices.set("GOOGL", 140);

      result = await engine.executeDecision({
        decision: makeDecision({ action: "buy", symbol: "GOOGL", quantity: 1, priceAtDecision: 140 }),
      });
      check = result.riskChecks.find((c) => c.check === "maxDrawdown");
      expect(check!.passed).toBe(false);
      expect(check!.reason).toContain("drawdown");
      expect(result.riskPassed).toBe(false);
    });

    it("should pass when no peak equity established (zero)", async () => {
      // Fresh engine with a balance that has 0 peak equity — edge case
      const result = await engine.executeDecision({ decision: makeDecision({ action: "buy", quantity: 1 }) });
      const check = result.riskChecks.find((c) => c.check === "maxDrawdown");
      expect(check!.passed).toBe(true);
    });
  });

  // ── Integration with Decision ─────────────────────────────────

  describe("decision integration", () => {
    it("should use the decision's symbol, action, and quantity", async () => {
      const decision = makeDecision({
        action: "buy",
        symbol: "MSFT",
        quantity: 40,
        priceAtDecision: 420,
      });
      const result = await engine.executeDecision({ decision });

      expect(result.orderResult!.symbol).toBe("MSFT");
      expect(result.orderResult!.side).toBe("buy");
      expect(result.orderResult!.quantity).toBe(40);
      expect(result.tradeRecord!.symbol).toBe("MSFT");
      expect(result.tradeRecord!.side).toBe("buy");
    });

    it("should pass the decision id as clientOrderId", async () => {
      const decision = makeDecision({ action: "buy", quantity: 10 });
      const result = await engine.executeDecision({ decision });

      expect(result.orderResult!.clientOrderId).toBe(decision.id);
    });

    it("should record the decision id on the trade", async () => {
      const decision = makeDecision({ action: "buy", quantity: 10 });
      const result = await engine.executeDecision({ decision });

      expect(result.tradeRecord!.decisionId).toBe(decision.id);
    });
  });

  // ── Mode routing ──────────────────────────────────────────────

  describe("mode logging", () => {
    it("should log sim mode when config is sim", async () => {
      const result = await engine.executeDecision({ decision: makeDecision({ action: "buy", quantity: 10 }) });
      expect(result.tradeRecord!.mode).toBe("sim");
    });

    it("should log live mode when config is live", async () => {
      const liveEngine = new TradeEngine(db, sim, {
        ...riskConfig,
        tradeMode: "live",
      });
      const result = await liveEngine.executeDecision({ decision: makeDecision({ action: "buy", quantity: 10 }) });
      expect(result.tradeRecord!.mode).toBe("live");
    });
  });

  // ── Executor name ─────────────────────────────────────────────

  describe("executor name", () => {
    it("should record the executor name on the trade", async () => {
      const result = await engine.executeDecision({ decision: makeDecision({ action: "buy", quantity: 10 }) });
      expect(result.tradeRecord!.executor).toBe("simulated");
    });
  });

  // ── Daily trade count ─────────────────────────────────────────

  describe("getDailyTradeCount", () => {
    it("should count today's non-rejected trades", async () => {
      expect(await engine.getDailyTradeCount()).toBe(0);

      await engine.executeDecision({ decision: makeDecision({ action: "buy", quantity: 10 }) });
      expect(await engine.getDailyTradeCount()).toBe(1);

      // A rejected trade shouldn't count
      await engine.executeDecision({
        decision: makeDecision({ action: "buy", quantity: 200, priceAtDecision: 185 }),
      });
      expect(await engine.getDailyTradeCount()).toBe(1);

      await engine.executeDecision({
        decision: makeDecision({ action: "buy", symbol: "MSFT", quantity: 10, priceAtDecision: 420 }),
      });
      expect(await engine.getDailyTradeCount()).toBe(2);
    });
  });
});