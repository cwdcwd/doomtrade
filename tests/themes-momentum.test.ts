/**
 * Tests for MomentumScreenSignalSource and MomentumRotationStrategy.
 *
 * Covers:
 * - MomentumScreen signal generation (all scoring methods)
 * - Error handling for symbols with no data
 * - MomentumRotation strategy evaluation (buy top N, sell dropped)
 * - Integration with ThemeSubAccount
 */

import { describe, it, expect, beforeEach } from "vitest";
import { openDatabase, closeDatabase, type DbClient } from "../src/db/database.js";
import { ThemeStore } from "../src/themes/theme-store.js";
import { ThemeSubAccount } from "../src/themes/theme-sub-account.js";
import { ThemeRunner } from "../src/themes/theme-runner.js";
import { MomentumScreenSignalSource } from "../src/themes/sources/momentum-screen.js";
import { MomentumRotationStrategy } from "../src/themes/strategies/momentum-rotation.js";
import { ResearchService } from "../src/research/research.js";
import type { Bar, MarketDataService, Timeframe } from "../src/market/market.js";

let db: DbClient;

beforeEach(async () => {
  db = await openDatabase({ path: ":memory:" });
});

// ── Mock helpers ──────────────────────────────────────────────

function createMockBars(symbol: string, closes: number[]): Bar[] {
  return closes.map((c, i) => ({
    symbol,
    timestamp: new Date(2024, 0, i + 1).toISOString(),
    open: c * 0.99,
    high: c * 1.01,
    low: c * 0.98,
    close: c,
    volume: 1_000_000,
    source: "alpaca" as const,
  }));
}

function createMockMarketData(
  symbolBars: Record<string, number[]>,
): MarketDataService {
  return {
    async getQuote(symbol: string) {
      const bars = symbolBars[symbol];
      if (!bars) throw new Error(`No data for ${symbol}`);
      const price = bars[bars.length - 1];
      return { symbol, price, timestamp: new Date().toISOString(), source: "alpaca" as const };
    },
    async getBars(symbol: string, _timeframe: Timeframe, _range: string) {
      const closes = symbolBars[symbol];
      if (!closes) return [];
      return createMockBars(symbol, closes);
    },
    async getSnapshot(symbols: string[]) {
      return symbols.map((symbol) => ({
        symbol,
        price: symbolBars[symbol]?.[symbolBars[symbol].length - 1] ?? 0,
        timestamp: new Date().toISOString(),
        source: "alpaca" as const,
      }));
    },
  };
}

// Generate bars where SMA20 crosses above SMA50 on the last bar (golden cross)
// SMA20 needs 20 bars, SMA50 needs 50 bars. We need 51+ bars.
// Strategy: flat for 50 bars, then a sharp rise on bar 51 so SMA20 jumps
// above SMA50.
function goldenCrossBars(startPrice: number): number[] {
  const bars: number[] = [];
  // 49 bars at startPrice (SMA20 and SMA50 both = startPrice)
  for (let i = 0; i < 49; i++) bars.push(startPrice);
  // Bar 50: slight dip (makes SMA20 < SMA50 on the previous bar)
  bars.push(startPrice * 0.95);
  // Bar 51 (last): sharp rise — SMA20 jumps above SMA50
  bars.push(startPrice * 1.20);
  return bars;
}

// Generate bars where SMA20 crosses below SMA50 on the last bar (death cross)
function deathCrossBars(startPrice: number): number[] {
  const bars: number[] = [];
  // 49 bars at startPrice
  for (let i = 0; i < 49; i++) bars.push(startPrice);
  // Bar 50: slight rise (makes SMA20 > SMA50 on the previous bar)
  bars.push(startPrice * 1.05);
  // Bar 51 (last): sharp drop — SMA20 drops below SMA50
  bars.push(startPrice * 0.80);
  return bars;
}

// Generate flat bars (neutral signal)
function neutralBars(startPrice: number): number[] {
  return Array(60).fill(startPrice);
}

// ── MomentumScreenSignalSource ────────────────────────────────

describe("MomentumScreenSignalSource", () => {
  it("generates buy signals for bullish symbols (sma-crossover)", async () => {
    const marketData = createMockMarketData({
      AAPL: goldenCrossBars(150),
      TSLA: deathCrossBars(200),
    });
    const research = new ResearchService(marketData);

    const source = new MomentumScreenSignalSource(research, {
      universe: ["AAPL", "TSLA"],
      method: "sma-crossover",
    });

    const signals = await source.fetchSignals();

    const aaplSignal = signals.find((s) => s.symbol === "AAPL");
    const tslaSignal = signals.find((s) => s.symbol === "TSLA");

    expect(aaplSignal).toBeDefined();
    expect(aaplSignal!.action).toBe("buy");

    expect(tslaSignal).toBeDefined();
    expect(tslaSignal!.action).toBe("sell");
  });

  it("generates signals using sma-crossover method", async () => {
    const marketData = createMockMarketData({
      AAPL: goldenCrossBars(150),
      MSFT: neutralBars(300),
    });
    const research = new ResearchService(marketData);

    const source = new MomentumScreenSignalSource(research, {
      universe: ["AAPL", "MSFT"],
      method: "sma-crossover",
    });

    const signals = await source.fetchSignals();

    // AAPL should have a buy signal (golden cross)
    const aapl = signals.find((s) => s.symbol === "AAPL");
    expect(aapl).toBeDefined();
    expect(aapl!.action).toBe("buy");

    // MSFT should be hold (neutral — no crossover)
    const msft = signals.find((s) => s.symbol === "MSFT");
    expect(msft).toBeDefined();
    expect(msft!.action).toBe("hold");
  });

  it("skips symbols with no data", async () => {
    const marketData = createMockMarketData({
      AAPL: goldenCrossBars(150),
    });
    const research = new ResearchService(marketData);

    const source = new MomentumScreenSignalSource(research, {
      universe: ["AAPL", "NOEXIST"],
      method: "combined",
    });

    const signals = await source.fetchSignals();
    // Only AAPL — NOEXIST skipped
    expect(signals).toHaveLength(1);
    expect(signals[0].symbol).toBe("AAPL");
  });

  it("screenAll returns all symbols sorted by score", async () => {
    const marketData = createMockMarketData({
      AAPL: goldenCrossBars(150),
      NVDA: goldenCrossBars(300),
      TSLA: deathCrossBars(200),
    });
    const research = new ResearchService(marketData);

    const source = new MomentumScreenSignalSource(research, {
      universe: ["AAPL", "NVDA", "TSLA"],
      method: "sma-crossover",
    });

    const results = await source.screenAll();

    expect(results).toHaveLength(3);
    // Sorted by score descending (buys=1, holds=0, sells=-1)
    expect(results[0].score).toBeGreaterThanOrEqual(results[1].score);
    expect(results[1].score).toBeGreaterThanOrEqual(results[2].score);
  });

  it("fetchBuySignals returns only buy signals", async () => {
    const marketData = createMockMarketData({
      AAPL: goldenCrossBars(150),
      TSLA: deathCrossBars(200),
    });
    const research = new ResearchService(marketData);

    const source = new MomentumScreenSignalSource(research, {
      universe: ["AAPL", "TSLA"],
      method: "sma-crossover",
    });

    const buySignals = await source.fetchBuySignals();
    expect(buySignals).toHaveLength(1);
    expect(buySignals[0].symbol).toBe("AAPL");
    expect(buySignals[0].action).toBe("buy");
  });

  it("includes metadata in signals", async () => {
    const marketData = createMockMarketData({
      AAPL: goldenCrossBars(150),
    });
    const research = new ResearchService(marketData);

    const source = new MomentumScreenSignalSource(research, {
      universe: ["AAPL"],
      method: "combined",
    });

    const signals = await source.fetchSignals();
    expect(signals).toHaveLength(1);
    expect(signals[0].metadata).toBeDefined();
    expect(signals[0].metadata!.method).toBe("combined");
    expect(signals[0].priceAtSignal).toBeGreaterThan(0);
  });
});

// ── MomentumRotationStrategy ──────────────────────────────────

describe("MomentumRotationStrategy", () => {
  it("can be constructed and has correct type", () => {
    const strategy = new MomentumRotationStrategy();
    expect(strategy.type).toBe("momentum-rotation");
  });

  it("evaluates and produces signals for bullish symbols", async () => {
    const marketData = createMockMarketData({
      AAPL: goldenCrossBars(150),
      NVDA: goldenCrossBars(300),
      TSLA: deathCrossBars(200),
    });

    const store = new ThemeStore(db);
    const theme = await store.create({
      name: "Momentum Test",
      strategy: "momentum-rotation",
      schedule: { type: "manual" },
      allocatedCapital: 100_000,
      maxPositions: 5,
      params: {
        universe: ["AAPL", "NVDA", "TSLA"],
        topN: 2,
        method: "sma-crossover",
      },
    });

    // Initialize sub-account
    const sub = new ThemeSubAccount(db, theme.id, {
      feeRate: 0,
      getCurrentPrice: (sym) => {
        const prices: Record<string, number> = { AAPL: 157.5, NVDA: 315, TSLA: 185 };
        return prices[sym] ?? null;
      },
    });
    await sub.initialize(100_000);

    // Build a runner with the strategy
    const runner = new ThemeRunner(db, {
      decisionStore: {
        create: async (input: any) => ({
          id: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          ...input,
        }),
        getById: async () => null,
        list: async () => [],
        count: async () => 0,
      } as any,
      tradeEngine: {
        executeDecision: async () => ({
          riskPassed: true,
          riskChecks: [],
          orderResult: { status: "filled", fillPrice: 100, fee: 0 },
        }),
      } as any,
      portfolio: {
        getSnapshot: async () => ({}),
        getPnL: async () => ({}),
        getPositions: async () => [],
      } as any,
      marketData: marketData,
      getCurrentPrice: (sym: string) => {
        const prices: Record<string, number> = { AAPL: 157.5, NVDA: 315, TSLA: 185 };
        return prices[sym] ?? null;
      },
    });
    runner.registerStrategy(new MomentumRotationStrategy());

    const result = await runner.evaluateOnce(theme.id);

    // Should have signals (buy signals from AAPL and NVDA, sell from TSLA)
    expect(result.signals.length).toBeGreaterThan(0);

    // Should have at least one buy decision
    const buyDecisions = result.decisions.filter((d) => d.action === "buy");
    expect(buyDecisions.length).toBeGreaterThan(0);
    expect(buyDecisions.length).toBeLessThanOrEqual(2); // topN = 2
  });

  it("handles empty universe gracefully", async () => {
    const marketData = createMockMarketData({});

    const store = new ThemeStore(db);
    const theme = await store.create({
      name: "Empty Universe",
      strategy: "momentum-rotation",
      schedule: { type: "manual" },
      allocatedCapital: 10_000,
      params: {
        universe: [],
        topN: 5,
      },
    });

    const sub = new ThemeSubAccount(db, theme.id, { feeRate: 0 });
    await sub.initialize(10_000);

    const runner = new ThemeRunner(db, {
      decisionStore: {
        create: async (input: any) => ({
          id: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          ...input,
        }),
        getById: async () => null,
        list: async () => [],
        count: async () => 0,
      } as any,
      tradeEngine: { executeDecision: async () => ({}) } as any,
      portfolio: {
        getSnapshot: async () => ({}),
        getPnL: async () => ({}),
        getPositions: async () => [],
      } as any,
      marketData: marketData,
    });
    runner.registerStrategy(new MomentumRotationStrategy());

    const result = await runner.evaluateOnce(theme.id);

    // Empty universe should produce an error in parseParams
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.signals).toHaveLength(0);
  });
});