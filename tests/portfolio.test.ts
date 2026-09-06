import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Database } from "../src/db/database.js";
import {
  openDatabase,
  closeDatabase,
  execAll,
} from "../src/db/database.js";
import {
  SimulatedExchange,
} from "../src/executor/simulated.js";
import type { Executor, Position, Balance } from "../src/executor/executor.js";
import { Portfolio } from "../src/portfolio/portfolio.js";
import {
  computeUnrealizedPnl,
  computeMarketValue,
  computeExposure,
  aggregateUnrealizedPnl,
  aggregateMarketValue,
  type Position as PortfolioPosition,
} from "../src/portfolio/positions.js";

// ── Mock Executor for unit tests ───────────────────────────────

class MockExecutor implements Executor {
  readonly name = "mock";
  private positions: Position[] = [];
  private balance: Balance;

  constructor(positions: Position[] = [], balance?: Partial<Balance>) {
    this.positions = positions;
    this.balance = {
      cash: balance?.cash ?? 100_000,
      equity: balance?.equity ?? 100_000,
      initialCash: balance?.initialCash ?? 100_000,
      peakEquity: balance?.peakEquity ?? 100_000,
    };
  }

  async placeOrder(): Promise<never> {
    throw new Error("MockExecutor does not support placeOrder");
  }
  async cancelOrder(): Promise<boolean> {
    return false;
  }
  async getPositions(): Promise<Position[]> {
    return [...this.positions];
  }
  async getBalance(): Promise<Balance> {
    return { ...this.balance };
  }

  /** Test helpers */
  setPositions(positions: Position[]): void {
    this.positions = positions;
  }
  setBalance(balance: Partial<Balance>): void {
    this.balance = { ...this.balance, ...balance };
  }
}

// ── Tests ──────────────────────────────────────────────────────

describe("positions helpers", () => {
  describe("computeUnrealizedPnl", () => {
    it("should compute positive P&L for a long position above entry", () => {
      const pnl = computeUnrealizedPnl({
        quantity: 100,
        avgEntryPrice: 150,
        side: "long",
        currentPrice: 175,
      });
      expect(pnl).toBe(2500); // (175 - 150) * 100
    });

    it("should compute negative P&L for a long position below entry", () => {
      const pnl = computeUnrealizedPnl({
        quantity: 100,
        avgEntryPrice: 150,
        side: "long",
        currentPrice: 140,
      });
      expect(pnl).toBe(-1000); // (140 - 150) * 100
    });

    it("should compute P&L for a short position", () => {
      const pnl = computeUnrealizedPnl({
        quantity: 50,
        avgEntryPrice: 200,
        side: "short",
        currentPrice: 180,
      });
      expect(pnl).toBe(1000); // (200 - 180) * 50 — short profits from price drop
    });

    it("should return 0 when currentPrice is null", () => {
      const pnl = computeUnrealizedPnl({
        quantity: 100,
        avgEntryPrice: 150,
        side: "long",
        currentPrice: null,
      });
      expect(pnl).toBe(0);
    });

    it("should return 0 when currentPrice is 0", () => {
      const pnl = computeUnrealizedPnl({
        quantity: 100,
        avgEntryPrice: 150,
        side: "long",
        currentPrice: 0,
      });
      expect(pnl).toBe(0);
    });
  });

  describe("computeMarketValue", () => {
    it("should compute market value as quantity × price", () => {
      const mv = computeMarketValue({ quantity: 100, currentPrice: 185 });
      expect(mv).toBe(18_500);
    });

    it("should return 0 when currentPrice is null", () => {
      const mv = computeMarketValue({ quantity: 100, currentPrice: null });
      expect(mv).toBe(0);
    });
  });

  describe("computeExposure", () => {
    it("should compute exposure as percentage of equity", () => {
      const exposure = computeExposure(50_000, 100_000);
      expect(exposure).toBe(50); // 50%
    });

    it("should handle 0 equity", () => {
      const exposure = computeExposure(50_000, 0);
      expect(exposure).toBe(0);
    });

    it("should handle >100% exposure (leveraged)", () => {
      const exposure = computeExposure(150_000, 100_000);
      expect(exposure).toBe(150);
    });
  });

  describe("aggregateUnrealizedPnl", () => {
    it("should sum P&L across positions", () => {
      const positions: PortfolioPosition[] = [
        { symbol: "AAPL", quantity: 100, avgEntryPrice: 150, side: "long", currentPrice: 175 },
        { symbol: "MSFT", quantity: 50, avgEntryPrice: 400, side: "long", currentPrice: 380 },
      ];
      expect(aggregateUnrealizedPnl(positions)).toBe(1500); // 2500 + (-1000)
    });

    it("should use pre-computed unrealizedPnl if present", () => {
      const positions: PortfolioPosition[] = [
        { symbol: "AAPL", quantity: 100, avgEntryPrice: 150, side: "long", currentPrice: 175, unrealizedPnl: 999 },
      ];
      expect(aggregateUnrealizedPnl(positions)).toBe(999);
    });

    it("should return 0 for empty positions", () => {
      expect(aggregateUnrealizedPnl([])).toBe(0);
    });
  });

  describe("aggregateMarketValue", () => {
    it("should sum market values across positions", () => {
      const positions: PortfolioPosition[] = [
        { symbol: "AAPL", quantity: 100, avgEntryPrice: 150, side: "long", currentPrice: 185 },
        { symbol: "BTC/USDT", quantity: 1, avgEntryPrice: 60_000, side: "long", currentPrice: 65_000 },
      ];
      expect(aggregateMarketValue(positions)).toBe(83_500); // 18500 + 65000
    });

    it("should return 0 for empty positions", () => {
      expect(aggregateMarketValue([])).toBe(0);
    });
  });
});

// ── Portfolio class tests ──────────────────────────────────────

describe("Portfolio", () => {
  let db: Database;
  let mockExecutor: MockExecutor;
  let portfolio: Portfolio;

  beforeEach(async () => {
    db = await openDatabase({ path: ":memory:" });
    mockExecutor = new MockExecutor();
    portfolio = new Portfolio(db, mockExecutor, {
      mode: "sim",
      initialCapital: 100_000,
    });
  });

  afterEach(() => {
    closeDatabase(db);
  });

  describe("getSnapshot", () => {
    it("should return correct snapshot with no positions", async () => {
      const snapshot = await portfolio.getSnapshot();

      expect(snapshot.equity).toBe(100_000);
      expect(snapshot.cash).toBe(100_000);
      expect(snapshot.positionsValue).toBe(0);
      expect(snapshot.positions).toHaveLength(0);
      expect(snapshot.exposurePct).toBe(0);
      expect(snapshot.positionCount).toBe(0);
      expect(snapshot.mode).toBe("sim");
    });

    it("should return correct snapshot with positions", async () => {
      mockExecutor.setPositions([
        { symbol: "AAPL", quantity: 100, avgEntryPrice: 150, side: "long", unrealizedPnl: 2500, marketValue: 18_500 },
        { symbol: "MSFT", quantity: 50, avgEntryPrice: 400, side: "long", unrealizedPnl: -1000, marketValue: 21_000 },
      ]);
      mockExecutor.setBalance({
        cash: 50_000,
        equity: 50_000 + 18_500 + 21_000, // 89_500
        initialCash: 100_000,
      });

      const snapshot = await portfolio.getSnapshot();

      expect(snapshot.cash).toBe(50_000);
      expect(snapshot.equity).toBe(89_500);
      expect(snapshot.positionsValue).toBe(39_500); // 18_500 + 21_000
      expect(snapshot.positions).toHaveLength(2);
      expect(snapshot.exposurePct).toBeCloseTo(39_500 / 89_500 * 100, 2);
      expect(snapshot.positionCount).toBe(2);
    });

    it("should enrich positions with unrealizedPnl and marketValue", async () => {
      mockExecutor.setPositions([
        { symbol: "AAPL", quantity: 100, avgEntryPrice: 150, side: "long" },
      ]);

      const snapshot = await portfolio.getSnapshot();
      const pos = snapshot.positions[0];

      expect(pos.unrealizedPnl).toBe(0); // no currentPrice → 0
      expect(pos.marketValue).toBe(0); // no currentPrice → 0
    });

    it("should use executor-provided unrealizedPnl and marketValue", async () => {
      mockExecutor.setPositions([
        {
          symbol: "AAPL",
          quantity: 100,
          avgEntryPrice: 150,
          side: "long",
          unrealizedPnl: 3500,
          marketValue: 18_500,
        },
      ]);

      const snapshot = await portfolio.getSnapshot();
      const pos = snapshot.positions[0];

      expect(pos.unrealizedPnl).toBe(3500);
      expect(pos.marketValue).toBe(18_500);
    });

    it("should include a valid ISO timestamp", async () => {
      const snapshot = await portfolio.getSnapshot();
      expect(snapshot.timestamp).toBeTruthy();
      expect(new Date(snapshot.timestamp).toISOString()).toBe(snapshot.timestamp);
    });
  });

  describe("getPnL", () => {
    it("should return zero P&L with no positions and no trades", async () => {
      const pnl = await portfolio.getPnL();

      expect(pnl.unrealized).toBe(0);
      expect(pnl.realized).toBe(0);
      expect(pnl.total).toBe(0);
      expect(pnl.totalPct).toBe(0);
      expect(pnl.unrealizedPct).toBe(0);
    });

    it("should compute unrealized P&L from positions", async () => {
      mockExecutor.setPositions([
        {
          symbol: "AAPL",
          quantity: 100,
          avgEntryPrice: 150,
          side: "long",
          unrealizedPnl: 2500,
          marketValue: 18_500,
        },
      ]);

      const pnl = await portfolio.getPnL();

      expect(pnl.unrealized).toBe(2500);
      expect(pnl.total).toBe(2500);
      expect(pnl.totalPct).toBeCloseTo(2.5, 10); // 2500 / 100_000 * 100
    });

    it("should compute realized P&L from trades table", async () => {
      // Insert a filled trade with realized P&L
      db.run(
        `INSERT INTO trades
          (id, decision_id, timestamp, symbol, side, quantity, order_type,
           fill_price, status, fee, realized_pnl, mode, executor, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          "trade-1",
          "dec-1",
          new Date().toISOString(),
          "AAPL",
          "sell",
          100,
          "market",
          185.0,
          "filled",
          18.5,
          3500.0,
          "sim",
          "simulated",
          null,
        ],
      );

      const pnl = await portfolio.getPnL();

      expect(pnl.realized).toBe(3500);
      expect(pnl.total).toBe(3500);
      expect(pnl.totalPct).toBeCloseTo(3.5, 10); // 3500 / 100_000 * 100
    });

    it("should combine unrealized and realized P&L", async () => {
      mockExecutor.setPositions([
        {
          symbol: "AAPL",
          quantity: 100,
          avgEntryPrice: 150,
          side: "long",
          unrealizedPnl: 2500,
        },
      ]);
      db.run(
        `INSERT INTO trades
          (id, decision_id, timestamp, symbol, side, quantity, order_type,
           fill_price, status, fee, realized_pnl, mode, executor, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          "trade-1",
          "dec-1",
          new Date().toISOString(),
          "AAPL",
          "sell",
          50,
          "market",
          185.0,
          "filled",
          18.5,
          1750.0,
          "sim",
          "simulated",
          null,
        ],
      );

      const pnl = await portfolio.getPnL();

      expect(pnl.unrealized).toBe(2500);
      expect(pnl.realized).toBe(1750);
      expect(pnl.total).toBe(4250);
      expect(pnl.totalPct).toBeCloseTo(4.25, 10); // 4250 / 100_000 * 100
    });

    it("should handle negative P&L correctly", async () => {
      mockExecutor.setPositions([
        {
          symbol: "AAPL",
          quantity: 100,
          avgEntryPrice: 200,
          side: "long",
          unrealizedPnl: -3000,
        },
      ]);

      const pnl = await portfolio.getPnL();

      expect(pnl.unrealized).toBe(-3000);
      expect(pnl.total).toBe(-3000);
      expect(pnl.totalPct).toBeCloseTo(-3.0, 10); // -3000 / 100_000 * 100
    });
  });

  describe("recordCheckpoint", () => {
    it("should persist a snapshot to portfolio_history", async () => {
      await portfolio.recordCheckpoint();

      const rows = execAll<{ id: string; equity: number; cash: number }>(
        db,
        "SELECT id, equity, cash FROM portfolio_history",
      );

      expect(rows).toHaveLength(1);
      expect(rows[0].equity).toBe(100_000);
      expect(rows[0].cash).toBe(100_000);
    });

    it("should persist multiple checkpoints", async () => {
      await portfolio.recordCheckpoint();

      mockExecutor.setBalance({ cash: 80_000, equity: 80_000 });
      await portfolio.recordCheckpoint();

      const rows = execAll<{ equity: number }>(
        db,
        "SELECT equity FROM portfolio_history ORDER BY equity ASC",
      );

      expect(rows).toHaveLength(2);
      expect(rows[0].equity).toBe(80_000);
      expect(rows[1].equity).toBe(100_000);
    });

    it("should record P&L values in checkpoint", async () => {
      mockExecutor.setPositions([
        {
          symbol: "AAPL",
          quantity: 100,
          avgEntryPrice: 150,
          side: "long",
          unrealizedPnl: 2500,
        },
      ]);

      await portfolio.recordCheckpoint();

      const row = execAll<{ unrealized_pnl: number; realized_pnl: number }>(
        db,
        "SELECT unrealized_pnl, realized_pnl FROM portfolio_history",
      )[0];

      expect(row.unrealized_pnl).toBe(2500);
      expect(row.realized_pnl).toBe(0);
    });
  });

  describe("getHistory", () => {
    it("should return empty array when no history", async () => {
      const history = await portfolio.getHistory();
      expect(history).toHaveLength(0);
    });

    it("should return equity curve from checkpoints", async () => {
      // Record 3 checkpoints
      await portfolio.recordCheckpoint(); // 100_000

      mockExecutor.setBalance({ cash: 90_000, equity: 90_000 });
      await portfolio.recordCheckpoint();

      mockExecutor.setBalance({ cash: 95_000, equity: 95_000 });
      await portfolio.recordCheckpoint();

      const history = await portfolio.getHistory();

      expect(history).toHaveLength(3);
      expect(history[0].equity).toBe(100_000);
      expect(history[1].equity).toBe(90_000);
      expect(history[2].equity).toBe(95_000);
    });

    it("should filter by date range", async () => {
      await portfolio.recordCheckpoint();
      // Small delay to ensure different timestamps
      await new Promise((r) => setTimeout(r, 50));
      const midTime = new Date().toISOString();
      await new Promise((r) => setTimeout(r, 50));

      mockExecutor.setBalance({ cash: 80_000, equity: 80_000 });
      await portfolio.recordCheckpoint();

      const filtered = await portfolio.getHistory({ startDate: midTime });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].equity).toBe(80_000);
    });

    it("should respect limit", async () => {
      for (let i = 0; i < 5; i++) {
        mockExecutor.setBalance({ cash: 100_000 - i * 1000, equity: 100_000 - i * 1000 });
        await portfolio.recordCheckpoint();
      }

      const history = await portfolio.getHistory({ limit: 3 });
      expect(history).toHaveLength(3);
    });
  });

  describe("getPeakEquity", () => {
    it("should return 0 with no history", () => {
      expect(portfolio.getPeakEquity()).toBe(0);
    });

    it("should return the maximum equity from history", async () => {
      mockExecutor.setBalance({ cash: 120_000, equity: 120_000 });
      await portfolio.recordCheckpoint();

      mockExecutor.setBalance({ cash: 90_000, equity: 90_000 });
      await portfolio.recordCheckpoint();

      mockExecutor.setBalance({ cash: 105_000, equity: 105_000 });
      await portfolio.recordCheckpoint();

      expect(portfolio.getPeakEquity()).toBe(120_000);
    });
  });

  describe("getPositions", () => {
    it("should delegate to executor", async () => {
      mockExecutor.setPositions([
        { symbol: "AAPL", quantity: 100, avgEntryPrice: 150, side: "long" },
        { symbol: "BTC/USDT", quantity: 0.5, avgEntryPrice: 60_000, side: "long" },
      ]);

      const positions = await portfolio.getPositions();
      expect(positions).toHaveLength(2);
      expect(positions[0].symbol).toBe("AAPL");
      expect(positions[1].symbol).toBe("BTC/USDT");
    });
  });
});

// ── Integration tests with SimulatedExchange ──────────────────

describe("Portfolio + SimulatedExchange integration", () => {
  let db: Database;
  let sim: SimulatedExchange;
  let portfolio: Portfolio;

  const prices = new Map<string, number>();
  const priceProvider = (symbol: string) => prices.get(symbol) ?? null;

  beforeEach(async () => {
    db = await openDatabase({ path: ":memory:" });
    prices.clear();
    prices.set("AAPL", 185.0);
    sim = new SimulatedExchange(db, {
      getCurrentPrice: priceProvider,
      feeRate: 0.001,
    });
    portfolio = new Portfolio(db, sim, {
      mode: "sim",
      initialCapital: 100_000,
    });
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it("should reflect initial state with no positions", async () => {
    const snapshot = await portfolio.getSnapshot();

    expect(snapshot.equity).toBe(100_000);
    expect(snapshot.cash).toBe(100_000);
    expect(snapshot.positionsValue).toBe(0);
    expect(snapshot.positions).toHaveLength(0);
    expect(snapshot.mode).toBe("sim");
  });

  it("should reflect positions after buying", async () => {
    await sim.placeOrder({
      symbol: "AAPL",
      side: "buy",
      quantity: 100,
      orderType: "market",
    });

    const snapshot = await portfolio.getSnapshot();

    expect(snapshot.positions).toHaveLength(1);
    expect(snapshot.positions[0].symbol).toBe("AAPL");
    expect(snapshot.positions[0].quantity).toBe(100);
    expect(snapshot.positions[0].avgEntryPrice).toBeCloseTo(185.0, 2);
    // Equity = cash + position value
    const expectedCash = 100_000 - 185 * 100 - 185 * 100 * 0.001;
    expect(snapshot.cash).toBeCloseTo(expectedCash, 2);
    expect(snapshot.positionsValue).toBeCloseTo(185 * 100, 2);
    expect(snapshot.equity).toBeCloseTo(expectedCash + 185 * 100, 2);
  });

  it("should show unrealized P&L when price changes", async () => {
    await sim.placeOrder({
      symbol: "AAPL",
      side: "buy",
      quantity: 100,
      orderType: "market",
    });

    // Price goes up $15
    prices.set("AAPL", 200.0);

    const pnl = await portfolio.getPnL();
    // Unrealized P&L = (200 - 185) * 100 = 1500
    expect(pnl.unrealized).toBeCloseTo(1500, 1);
  });

  it("should record and retrieve checkpoints after trades", async () => {
    await sim.placeOrder({
      symbol: "AAPL",
      side: "buy",
      quantity: 100,
      orderType: "market",
    });
    await portfolio.recordCheckpoint();

    const history = await portfolio.getHistory();
    expect(history).toHaveLength(1);
    expect(history[0].equity).toBeCloseTo(100_000 - 185 * 100 * 0.001, 1);
    // Equity = 100k - fee (cost is deducted from cash, but position value offsets)
    // Actually equity = cash + position_value = (100k - 18500 - 18.5) + 18500 = 100k - 18.5
    expect(history[0].cash).toBeCloseTo(100_000 - 18_500 - 18.5, 1);
  });

  it("should compute exposure after opening positions", async () => {
    await sim.placeOrder({
      symbol: "AAPL",
      side: "buy",
      quantity: 200,
      orderType: "market",
    });

    const snapshot = await portfolio.getSnapshot();
    // Position value = 200 * 185 = 37,000
    // Equity = 100,000 - 37,000 - 37 + 37,000 = 99,963
    // Exposure = 37,000 / 99,963 ≈ 37.01%
    expect(snapshot.exposurePct).toBeGreaterThan(36);
    expect(snapshot.exposurePct).toBeLessThan(38);
  });
});
