import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import { openDatabase, closeDatabase } from "../src/db/database.js";
import {
  SimulatedExchange,
  type SimulatedExchangeConfig,
} from "../src/executor/simulated.js";
import type { OrderRequest } from "../src/executor/executor.js";

describe("SimulatedExchange", () => {
  let db: DatabaseType;
  let sim: SimulatedExchange;

  // Simple price provider: returns a fixed price per symbol
  const prices: Map<string, number> = new Map();
  const priceProvider = (symbol: string) => prices.get(symbol) ?? null;

  beforeEach(() => {
    db = openDatabase({ path: ":memory:" });
    prices.clear();
    prices.set("AAPL", 185.0);
    prices.set("BTC/USDT", 65000.0);
    sim = new SimulatedExchange(db, {
      getCurrentPrice: priceProvider,
      feeRate: 0.001,
    });
  });

  afterEach(() => {
    closeDatabase(db);
  });

  const marketBuy: OrderRequest = {
    symbol: "AAPL",
    side: "buy",
    quantity: 100,
    orderType: "market",
  };

  describe("initial state", () => {
    it("should start with $100,000 cash", async () => {
      const balance = await sim.getBalance();
      expect(balance.cash).toBe(100_000);
      expect(balance.equity).toBe(100_000);
      expect(balance.initialCash).toBe(100_000);
    });

    it("should start with no positions", async () => {
      const positions = await sim.getPositions();
      expect(positions).toHaveLength(0);
    });
  });

  describe("market orders — buy", () => {
    it("should fill a market buy at current price", async () => {
      const result = await sim.placeOrder(marketBuy);

      expect(result.status).toBe("filled");
      expect(result.fillPrice).toBe(185.0);
      expect(result.quantity).toBe(100);
      expect(result.fee).toBeCloseTo(185.0 * 100 * 0.001, 5); // 18.50
    });

    it("should deduct cash for the buy + fee", async () => {
      await sim.placeOrder(marketBuy);
      const balance = await sim.getBalance();

      const expectedCost = 185.0 * 100 + 185.0 * 100 * 0.001;
      expect(balance.cash).toBeCloseTo(100_000 - expectedCost, 2);
    });

    it("should create a long position with correct avg entry price", async () => {
      await sim.placeOrder(marketBuy);
      const positions = await sim.getPositions();

      expect(positions).toHaveLength(1);
      expect(positions[0].symbol).toBe("AAPL");
      expect(positions[0].quantity).toBe(100);
      expect(positions[0].avgEntryPrice).toBe(185.0);
      expect(positions[0].side).toBe("long");
    });

    it("should update avg entry price on additional buys (weighted average)", async () => {
      await sim.placeOrder(marketBuy); // 100 @ 185
      prices.set("AAPL", 190.0);
      await sim.placeOrder({ ...marketBuy, quantity: 100 }); // 100 @ 190

      const positions = await sim.getPositions();
      // avg = (100*185 + 100*190) / 200 = 187.5
      expect(positions[0].quantity).toBe(200);
      expect(positions[0].avgEntryPrice).toBe(187.5);
    });

    it("should reject buy with insufficient cash", async () => {
      const result = await sim.placeOrder({
        symbol: "BTC/USDT",
        side: "buy",
        quantity: 10, // 10 * 65000 = 650,000 > 100,000
        orderType: "market",
      });

      expect(result.status).toBe("rejected");
      expect(result.error).toContain("Insufficient cash");
    });

    it("should reject buy with zero quantity", async () => {
      const result = await sim.placeOrder({
        ...marketBuy,
        quantity: 0,
      });

      expect(result.status).toBe("rejected");
      expect(result.error).toContain("Quantity must be positive");
    });
  });

  describe("market orders — sell", () => {
    it("should fill a market sell and compute realized P&L", async () => {
      // Buy first
      await sim.placeOrder(marketBuy); // 100 @ 185
      // Price goes up
      prices.set("AAPL", 195.0);

      const sellResult = await sim.placeOrder({
        symbol: "AAPL",
        side: "sell",
        quantity: 100,
        orderType: "market",
      });

      expect(sellResult.status).toBe("filled");
      expect(sellResult.fillPrice).toBe(195.0);
      // PnL = (195 - 185) * 100 - fee(195*100*0.001) = 1000 - 19.5 = 980.5
      expect(sellResult.realizedPnl).toBeCloseTo(980.5, 1);
    });

    it("should reject sell without existing position", async () => {
      const result = await sim.placeOrder({
        symbol: "AAPL",
        side: "sell",
        quantity: 10,
        orderType: "market",
      });

      expect(result.status).toBe("rejected");
      expect(result.error).toContain("Insufficient position");
    });

    it("should reject sell exceeding position quantity", async () => {
      await sim.placeOrder({ ...marketBuy, quantity: 50 });

      const result = await sim.placeOrder({
        symbol: "AAPL",
        side: "sell",
        quantity: 100,
        orderType: "market",
      });

      expect(result.status).toBe("rejected");
      expect(result.error).toContain("Insufficient position");
    });

    it("should handle partial close correctly", async () => {
      await sim.placeOrder({ ...marketBuy, quantity: 100 }); // 100 @ 185
      prices.set("AAPL", 195.0);

      // Sell 40 of 100
      await sim.placeOrder({
        symbol: "AAPL",
        side: "sell",
        quantity: 40,
        orderType: "market",
      });

      const positions = await sim.getPositions();
      expect(positions).toHaveLength(1);
      expect(positions[0].quantity).toBe(60);
      // Avg entry unchanged for remaining position
      expect(positions[0].avgEntryPrice).toBe(185.0);
    });

    it("should remove position when fully closed", async () => {
      await sim.placeOrder({ ...marketBuy, quantity: 100 });
      prices.set("AAPL", 190.0);

      await sim.placeOrder({
        symbol: "AAPL",
        side: "sell",
        quantity: 100,
        orderType: "market",
      });

      const positions = await sim.getPositions();
      expect(positions).toHaveLength(0);
    });
  });

  describe("fees", () => {
    it("should deduct 0.1% fee by default", async () => {
      const result = await sim.placeOrder(marketBuy);
      expect(result.fee).toBeCloseTo(18.5, 2); // 185 * 100 * 0.001
    });

    it("should support custom fee rate", async () => {
      // Clear balance first (already initialized by previous sim)
      db.prepare("DELETE FROM sim_balance WHERE id = 1").run();
      db.prepare("DELETE FROM sim_positions").run();
      let customSim = new SimulatedExchange(db, {
        getCurrentPrice: priceProvider,
        feeRate: 0.005,
      });

      const result = await customSim.placeOrder(marketBuy);
      expect(result.fee).toBeCloseTo(92.5, 2); // 185 * 100 * 0.005
    });
  });

  describe("limit orders", () => {
    it("should store a limit buy as pending when price is above limit", async () => {
      const result = await sim.placeOrder({
        symbol: "AAPL",
        side: "buy",
        quantity: 100,
        orderType: "limit",
        limitPrice: 180.0, // current is 185, so won't fill
      });

      expect(result.status).toBe("pending");
      expect(result.fillPrice).toBeNull();
      expect(result.fee).toBe(0);
    });

    it("should fill a limit buy immediately when limit is at or above market", async () => {
      const result = await sim.placeOrder({
        symbol: "AAPL",
        side: "buy",
        quantity: 100,
        orderType: "limit",
        limitPrice: 190.0, // current is 185, so fills at 190? No — fills at limit price
      });

      expect(result.status).toBe("filled");
      expect(result.fillPrice).toBe(190.0);
    });

    it("should fill a limit sell immediately when limit is at or below market", async () => {
      // Buy first
      await sim.placeOrder(marketBuy); // 100 @ 185

      const result = await sim.placeOrder({
        symbol: "AAPL",
        side: "sell",
        quantity: 100,
        orderType: "limit",
        limitPrice: 180.0, // current is 185, fills
      });

      expect(result.status).toBe("filled");
      expect(result.fillPrice).toBe(180.0);
    });

    it("should reject limit order without limitPrice", async () => {
      const result = await sim.placeOrder({
        symbol: "AAPL",
        side: "buy",
        quantity: 100,
        orderType: "limit",
      });

      expect(result.status).toBe("rejected");
      expect(result.error).toContain("limitPrice");
    });

    it("should fill pending limit order when price crosses", async () => {
      // Place a limit buy at 180, current is 185 → pending
      await sim.placeOrder({
        symbol: "AAPL",
        side: "buy",
        quantity: 100,
        orderType: "limit",
        limitPrice: 180.0,
      });

      // Price drops to 180
      prices.set("AAPL", 180.0);
      const filled = await sim.checkPendingOrders();

      expect(filled).toHaveLength(1);
      expect(filled[0].status).toBe("filled");
      expect(filled[0].fillPrice).toBe(180.0);
    });
  });

  describe("cancel order", () => {
    it("should cancel a pending limit order", async () => {
      const result = await sim.placeOrder({
        symbol: "AAPL",
        side: "buy",
        quantity: 100,
        orderType: "limit",
        limitPrice: 180.0,
      });

      const cancelled = await sim.cancelOrder(result.id);
      expect(cancelled).toBe(true);
    });

    it("should return false for non-existent or non-pending order", async () => {
      // Filled order can't be cancelled
      const result = await sim.placeOrder(marketBuy);
      const cancelled = await sim.cancelOrder(result.id);
      expect(cancelled).toBe(false);
    });
  });

  describe("unrealized P&L", () => {
    it("should compute unrealized P&L for open positions", async () => {
      await sim.placeOrder(marketBuy); // 100 @ 185
      prices.set("AAPL", 195.0);

      const positions = await sim.getPositions();
      expect(positions[0].unrealizedPnl).toBeCloseTo(1000.0, 2); // (195-185)*100
    });

    it("should show negative unrealized P&L when price drops", async () => {
      await sim.placeOrder(marketBuy); // 100 @ 185
      prices.set("AAPL", 175.0);

      const positions = await sim.getPositions();
      expect(positions[0].unrealizedPnl).toBeCloseTo(-1000.0, 2); // (175-185)*100
    });
  });

  describe("equity calculation", () => {
    it("should compute equity = cash + positions value", async () => {
      await sim.placeOrder({ ...marketBuy, quantity: 100 }); // 100 @ 185 = $18,500 + fee
      prices.set("AAPL", 190.0);

      const positions = await sim.getPositions();
      const balance = await sim.getBalance();
      // Cash = 100000 - (185*100) - 18.5 = 81481.5
      // Position value = 100 * 190 = 19000
      // Equity = 81481.5 + 19000 = 100481.5
      expect(balance.cash).toBeCloseTo(100_000 - 18500 - 18.5, 2);
      expect(balance.equity).toBeCloseTo(81481.5 + 19000, 1);
    });
  });

  describe("persistence", () => {
    it("should persist state to SQLite and restore on new instance", async () => {
      // Use a file-based DB
      const fs = await import("node:fs");
      const dbPath = `/tmp/doomtrade-test-${Date.now()}.db`;

      try {
        const fileDb = openDatabase({ path: dbPath });
        const sim1 = new SimulatedExchange(fileDb, {
          getCurrentPrice: priceProvider,
        });

        await sim1.placeOrder(marketBuy); // Buy 100 AAPL @ 185
        closeDatabase(fileDb);

        // Reopen with a new instance — state should persist
        const fileDb2 = openDatabase({ path: dbPath });
        const sim2 = new SimulatedExchange(fileDb2, {
          getCurrentPrice: priceProvider,
        });

        const positions = await sim2.getPositions();
        expect(positions).toHaveLength(1);
        expect(positions[0].symbol).toBe("AAPL");
        expect(positions[0].quantity).toBe(100);
        expect(positions[0].avgEntryPrice).toBe(185.0);

        const balance = await sim2.getBalance();
        expect(balance.cash).toBeCloseTo(100_000 - 18500 - 18.5, 2);

        closeDatabase(fileDb2);
      } finally {
        if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
      }
    });
  });

  describe("slippage", () => {
    it("should apply slippage to fills", async () => {
      db.prepare("DELETE FROM sim_balance WHERE id = 1").run();
      db.prepare("DELETE FROM sim_positions").run();
      let slipSim = new SimulatedExchange(db, {
        getCurrentPrice: priceProvider,
        slippageRate: 0.001, // 0.1%
      });

      const result = await slipSim.placeOrder(marketBuy);
      // Fill = 185 * (1 + 0.001) = 185.185
      expect(result.fillPrice).toBeCloseTo(185.185, 2);
    });
  });
});