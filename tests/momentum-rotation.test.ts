/**
 * Tests for MomentumRotation strategy and MomentumScreenSignalSource.
 *
 * Market data is mocked — no real API calls are made.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { openDatabase, closeDatabase, type DbClient } from "../src/db/database.js";
import { ThemeSubAccount } from "../src/themes/theme-sub-account.js";
import {
  MomentumScreenSignalSource,
  type MomentumScreenConfig,
} from "../src/themes/sources/momentum-screen.js";
import {
  MomentumRotationStrategy,
  type MomentumRotationParams,
} from "../src/themes/strategies/momentum-rotation.js";
import type { ThemeContext } from "../src/themes/strategy.js";
import type { ThemeConfig } from "../src/themes/theme.js";
import type { MarketDataService, Bar, Quote, Timeframe } from "../src/market/market.js";

let db: DbClient;

beforeEach(async () => {
  db = await openDatabase({ path: ":memory:" });
});

afterEach(async () => {
  await closeDatabase(db);
  vi.restoreAllMocks();
});

// ── Helpers ────────────────────────────────────────────────────

/**
 * Create a mock MarketDataService that returns bars based on a
 * per-symbol price series generator.
 */
function createMockMarketData(
  barsBySymbol: Record<string, Bar[]>,
  quotePrices?: Record<string, number>,
): MarketDataService {
  return {
    async getBars(symbol: string, _timeframe: Timeframe, _range: string): Promise<Bar[]> {
      return barsBySymbol[symbol] ?? [];
    },
    async getQuote(symbol: string): Promise<Quote> {
      const price = quotePrices?.[symbol] ?? barsBySymbol[symbol]?.slice(-1)[0]?.close ?? 100;
      return {
        symbol,
        price,
        timestamp: new Date().toISOString(),
        source: "alpaca",
      };
    },
    async getSnapshot(_symbols: string[]) {
      return [];
    },
  };
}

/**
 * Build bar data from an array of closing prices.
 */
function barsFromCloses(closes: number[], symbol: string = "TEST"): Bar[] {
  return closes.map((close, i) => ({
    symbol,
    timestamp: new Date(2026, 0, i + 1).toISOString(),
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 1_000_000,
    source: "alpaca" as const,
  }));
}

/**
 * Build a golden-cross price series: decline then a sharp spike on the
 * last bar to trigger SMA crossover buy signal.
 */
function goldenCrossBars(symbol: string): Bar[] {
  const prices: number[] = [];
  // 55 bars of gentle decline (fast SMA below slow SMA)
  for (let i = 0; i < 55; i++) prices.push(100 - i * 0.1);
  // Last bar: sharp spike to trigger golden cross
  prices.push(prices[prices.length - 1] + 50);
  return barsFromCloses(prices, symbol);
}

/**
 * Build a death-cross price series: uptrend then a sharp drop on the
 * last bar to trigger SMA crossover sell signal.
 */
function deathCrossBars(symbol: string): Bar[] {
  const prices: number[] = [];
  // 55 bars of gentle rise (fast SMA above slow SMA)
  for (let i = 0; i < 55; i++) prices.push(50 + i * 0.1);
  // Last bar: sharp drop to trigger death cross
  prices.push(prices[prices.length - 1] - 50);
  return barsFromCloses(prices, symbol);
}

/**
 * Build an oversold RSI series: long steady decline.
 */
function oversoldBars(symbol: string): Bar[] {
  const prices: number[] = [];
  for (let i = 0; i < 30; i++) prices.push(100 - i);
  return barsFromCloses(prices, symbol);
}

/**
 * Build an overbought RSI series: long steady rise.
 */
function overboughtBars(symbol: string): Bar[] {
  const prices: number[] = [];
  for (let i = 0; i < 30; i++) prices.push(100 + i);
  return barsFromCloses(prices, symbol);
}

/**
 * Build a neutral price series (alternating around a midpoint).
 */
function neutralBars(symbol: string): Bar[] {
  const prices = [50, 50.5, 49.5, 50.2, 49.8, 50.1, 49.9, 50.3, 49.7, 50.0,
    50.2, 49.8, 50.1, 49.9, 50.0, 50.1, 50.0, 49.9, 50.1, 50.0,
    50.2, 49.8, 50.1, 49.9, 50.0, 50.1, 50.0, 49.9, 50.1, 50.0];
  return barsFromCloses(prices, symbol);
}

function buildThemeContext(
  db: DbClient,
  themeId: string,
  marketData: MarketDataService,
): ThemeContext {
  return {
    db,
    marketData,
    decisionStore: {} as any,
    tradeEngine: {} as any,
    portfolio: {} as any,
    themeId,
    getEquity: async () => 50_000,
    getPositions: async () => [],
    getQuote: async () => 100,
  };
}

function buildConfig(
  params: MomentumRotationParams,
  overrides: Partial<ThemeConfig> = {},
): ThemeConfig {
  return {
    id: "test-momentum",
    name: "Momentum Rotation Test",
    strategy: "momentum-rotation",
    mode: "sim",
    schedule: { type: "manual" },
    maxAllocationPct: 20,
    maxTotalAllocationPct: 100,
    maxPositions: 10,
    params: params as unknown as Record<string, unknown>,
    enabled: true,
    allocatedCapital: 50_000,
    ...overrides,
  };
}

// ── MomentumScreenSignalSource Tests ──────────────────────────

describe("MomentumScreenSignalSource", () => {
  it("returns correct signals for sma-crossover (buy and sell)", async () => {
    const barsBySymbol: Record<string, Bar[]> = {
      "AAPL": goldenCrossBars("AAPL"),  // golden cross -> buy
      "TSLA": deathCrossBars("TSLA"),  // death cross -> sell
      "CASH": neutralBars("CASH"),     // no crossover -> neutral (omitted)
    };

    const marketData = createMockMarketData(barsBySymbol);
    const config: MomentumScreenConfig = {
      universe: ["AAPL", "TSLA", "CASH"],
      indicator: {
        type: "sma-crossover",
        periods: { fast: 20, slow: 50 },
      },
    };

    const source = new MomentumScreenSignalSource(marketData, config);
    const signals = await source.fetchSignals();

    // AAPL should have a buy signal
    const aaplSignal = signals.find((s) => s.symbol === "AAPL");
    expect(aaplSignal).toBeDefined();
    expect(aaplSignal!.action).toBe("buy");
    expect(aaplSignal!.priceAtSignal).toBeGreaterThan(0);
    expect(aaplSignal!.metadata).toHaveProperty("indicator", "sma-crossover");

    // TSLA should have a sell signal
    const tslaSignal = signals.find((s) => s.symbol === "TSLA");
    expect(tslaSignal).toBeDefined();
    expect(tslaSignal!.action).toBe("sell");

    // CASH should be omitted (neutral)
    const cashSignal = signals.find((s) => s.symbol === "CASH");
    expect(cashSignal).toBeUndefined();
  });

  it("returns correct signals for RSI (oversold and overbought)", async () => {
    const barsBySymbol: Record<string, Bar[]> = {
      "OVER": oversoldBars("OVER"),    // RSI < 30 -> buy
      "BOUGHT": overboughtBars("BOUGHT"), // RSI > 70 -> sell
      "NEUT": neutralBars("NEUT"),     // 30 <= RSI <= 70 -> neutral (omitted)
    };

    const marketData = createMockMarketData(barsBySymbol);
    const config: MomentumScreenConfig = {
      universe: ["OVER", "BOUGHT", "NEUT"],
      indicator: {
        type: "rsi",
        period: 14,
      },
    };

    const source = new MomentumScreenSignalSource(marketData, config);
    const signals = await source.fetchSignals();

    // OVER should have a buy signal (oversold)
    const overSignal = signals.find((s) => s.symbol === "OVER");
    expect(overSignal).toBeDefined();
    expect(overSignal!.action).toBe("buy");
    expect(overSignal!.metadata).toHaveProperty("indicator", "rsi");

    // BOUGHT should have a sell signal (overbought)
    const boughtSignal = signals.find((s) => s.symbol === "BOUGHT");
    expect(boughtSignal).toBeDefined();
    expect(boughtSignal!.action).toBe("sell");

    // NEUT should be omitted (neutral RSI)
    const neutSignal = signals.find((s) => s.symbol === "NEUT");
    expect(neutSignal).toBeUndefined();
  });

  it("returns hold for combined when indicators disagree", async () => {
    // Golden cross (buy) + overbought RSI (sell) -> disagreement -> hold
    // We need a series that has a golden cross but also overbought RSI
    const prices: number[] = [];
    for (let i = 0; i < 60; i++) prices.push(100 - i * 0.5); // decline
    for (let i = 0; i < 30; i++) prices.push(70 + i * 3); // very sharp uptrend -> both golden cross AND overbought RSI
    const barsBySymbol: Record<string, Bar[]> = {
      "MIX": barsFromCloses(prices, "MIX"),
    };

    const marketData = createMockMarketData(barsBySymbol);
    const config: MomentumScreenConfig = {
      universe: ["MIX"],
      indicator: {
        type: "combined",
        periods: { fast: 20, slow: 50 },
        rsiPeriod: 14,
      },
    };

    const source = new MomentumScreenSignalSource(marketData, config);
    const signals = await source.fetchSignals();

    // Should produce a hold signal due to disagreement (buy from SMA, sell from RSI)
    const mixSignal = signals.find((s) => s.symbol === "MIX");
    expect(mixSignal).toBeDefined();
    expect(mixSignal!.action).toBe("hold");
    expect(mixSignal!.metadata).toHaveProperty("indicator", "combined");
  });

  it("skips symbols that return no bar data", async () => {
    const marketData = createMockMarketData({});
    const config: MomentumScreenConfig = {
      universe: ["NOPE"],
      indicator: { type: "rsi", period: 14 },
    };

    const source = new MomentumScreenSignalSource(marketData, config);
    const signals = await source.fetchSignals();
    expect(signals).toHaveLength(0);
  });
});

// ── MomentumRotationStrategy Tests ────────────────────────────

describe("MomentumRotationStrategy", () => {
  it("has type = momentum-rotation", () => {
    const strategy = new MomentumRotationStrategy();
    expect(strategy.type).toBe("momentum-rotation");
  });

  it("selects top N symbols with buy signals", async () => {
    // Create bars where AAPL, MSFT, GOOG have golden crosses
    const barsBySymbol: Record<string, Bar[]> = {
      "AAPL": goldenCrossBars("AAPL"),
      "MSFT": goldenCrossBars("MSFT"),
      "GOOG": goldenCrossBars("GOOG"),
      "CASH": neutralBars("CASH"),  // neutral, not selected
    };

    const marketData = createMockMarketData(barsBySymbol, {
      AAPL: 100,
      MSFT: 100,
      GOOG: 100,
    });

    // Initialize sub-account
    const sub = new ThemeSubAccount(db, "test-momentum", {
      feeRate: 0,
      getCurrentPrice: () => 100,
    });
    await sub.initialize(50_000);

    const params: MomentumRotationParams = {
      universe: ["AAPL", "MSFT", "GOOG", "CASH"],
      indicator: { type: "sma-crossover", periods: { fast: 20, slow: 50 } },
      topN: 3,
    };

    const strategy = new MomentumRotationStrategy();
    const config = buildConfig(params);
    const ctx = buildThemeContext(db, "test-momentum", marketData);

    const result = await strategy.evaluate(ctx, config);

    // Should have buy signals for AAPL, MSFT, GOOG
    const buySignals = result.signals.filter((s) => s.action === "buy");
    expect(buySignals.length).toBeGreaterThanOrEqual(3);

    // Should have placed trades for the top 3
    expect(result.trades.length).toBeGreaterThanOrEqual(3);

    // All trades should be buy orders that filled
    const buyTrades = result.trades.filter((t) => (t as any).side === "buy");
    expect(buyTrades.length).toBeGreaterThanOrEqual(3);
    expect(buyTrades.every((t) => (t as any).status === "filled")).toBe(true);

    // Should not have bought CASH (neutral signal)
    const cashTrade = result.trades.find((t) => (t as any).symbol === "CASH");
    expect(cashTrade).toBeUndefined();
  });

  it("sells positions that drop out of top N", async () => {
    // First run: AAPL and MSFT have golden crosses -> both bought
    const barsBySymbol: Record<string, Bar[]> = {
      "AAPL": goldenCrossBars("AAPL"),
      "MSFT": goldenCrossBars("MSFT"),
      "GOOG": neutralBars("GOOG"),
    };

    const marketData = createMockMarketData(barsBySymbol, {
      AAPL: 100,
      MSFT: 100,
      GOOG: 100,
    });

    const sub = new ThemeSubAccount(db, "test-momentum", {
      feeRate: 0,
      getCurrentPrice: () => 100,
    });
    await sub.initialize(50_000);

    const params: MomentumRotationParams = {
      universe: ["AAPL", "MSFT", "GOOG"],
      indicator: { type: "sma-crossover", periods: { fast: 20, slow: 50 } },
      topN: 2,
    };

    const strategy = new MomentumRotationStrategy();
    const config = buildConfig(params);
    const ctx = buildThemeContext(db, "test-momentum", marketData);

    // First evaluation: AAPL and MSFT should be bought
    const result1 = await strategy.evaluate(ctx, config);
    expect(result1.trades.length).toBeGreaterThanOrEqual(2);

    // Verify positions exist
    const positions1 = await sub.getPositions();
    const heldSymbols = positions1.map((p) => p.symbol);
    expect(heldSymbols).toContain("AAPL");
    expect(heldSymbols).toContain("MSFT");

    // Second run: MSFT drops out (now neutral), GOOG gets golden cross
    // We simulate this by changing the bar data for MSFT and GOOG
    const barsBySymbol2: Record<string, Bar[]> = {
      "AAPL": goldenCrossBars("AAPL"),  // still golden cross
      "MSFT": neutralBars("MSFT"),      // now neutral -> drops out
      "GOOG": goldenCrossBars("GOOG"),  // now golden cross -> enters
    };

    const marketData2 = createMockMarketData(barsBySymbol2, {
      AAPL: 100,
      MSFT: 100,
      GOOG: 100,
    });

    const ctx2 = buildThemeContext(db, "test-momentum", marketData2);

    const result2 = await strategy.evaluate(ctx2, config);

    // MSFT should be sold (dropped out of top N)
    const msftSell = result2.trades.find(
      (t) => (t as any).symbol === "MSFT" && (t as any).side === "sell",
    );
    expect(msftSell).toBeDefined();
    expect((msftSell as any).status).toBe("filled");

    // AAPL should not be sold (still in top N)
    const aaplSell = result2.trades.find(
      (t) => (t as any).symbol === "AAPL" && (t as any).side === "sell",
    );
    expect(aaplSell).toBeUndefined();
  });

  it("handles empty universe", async () => {
    const marketData = createMockMarketData({});
    const sub = new ThemeSubAccount(db, "test-momentum", {
      feeRate: 0,
      getCurrentPrice: () => 100,
    });
    await sub.initialize(50_000);

    const params: MomentumRotationParams = {
      universe: [],
      indicator: { type: "sma-crossover", periods: { fast: 20, slow: 50 } },
      topN: 3,
    };

    const strategy = new MomentumRotationStrategy();
    const config = buildConfig(params);
    const ctx = buildThemeContext(db, "test-momentum", marketData);

    const result = await strategy.evaluate(ctx, config);

    expect(result.signals).toHaveLength(0);
    expect(result.trades).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it("returns error when indicator param is missing", async () => {
    const marketData = createMockMarketData({});
    const sub = new ThemeSubAccount(db, "test-momentum", {
      feeRate: 0,
      getCurrentPrice: () => 100,
    });
    await sub.initialize(50_000);

    const params = {
      universe: ["AAPL"],
      // indicator missing
    } as any as MomentumRotationParams;

    const strategy = new MomentumRotationStrategy();
    const config = buildConfig(params);
    const ctx = buildThemeContext(db, "test-momentum", marketData);

    const result = await strategy.evaluate(ctx, config);
    expect(result.errors).toContain("Missing required param: indicator");
  });

  it("returns empty result when sub-account is not initialized", async () => {
    const barsBySymbol: Record<string, Bar[]> = {
      "AAPL": goldenCrossBars("AAPL"),
    };
    const marketData = createMockMarketData(barsBySymbol, { AAPL: 100 });

    const params: MomentumRotationParams = {
      universe: ["AAPL"],
      indicator: { type: "sma-crossover", periods: { fast: 20, slow: 50 } },
      topN: 3,
    };

    const strategy = new MomentumRotationStrategy();
    const config = buildConfig(params);
    const ctx = buildThemeContext(db, "test-uninit", marketData);

    const result = await strategy.evaluate(ctx, config);

    // Should have signals but no trades
    expect(result.signals.length).toBeGreaterThan(0);
    expect(result.trades).toHaveLength(0);
    expect(result.errors).toContain("Sub-account not initialized — no capital allocated");
  });
});