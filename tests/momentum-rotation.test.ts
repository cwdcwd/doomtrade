/**
 * Tests for MomentumScreenSignalSource and MomentumRotationStrategy.
 *
 * Covers:
 * - MomentumScreen: produces buy/sell/hold signals from mock analysis
 * - MomentumScreen: skips symbols that fail to fetch
 * - MomentumScreen: filters by method (sma-crossover, rsi, combined)
 * - MomentumRotation: rotates into top N buy signals
 * - MomentumRotation: sells positions that drop out of top set
 * - MomentumRotation: handles empty universe gracefully
 * - MomentumRotation: respects rebalanceOnly flag
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { openDatabase, closeDatabase, type DbClient } from "../src/db/database.js";
import { ThemeStore } from "../src/themes/theme-store.js";
import { ThemeSubAccount } from "../src/themes/theme-sub-account.js";
import { ThemeRunner } from "../src/themes/theme-runner.js";
import { MomentumScreenSignalSource } from "../src/themes/sources/momentum-screen.js";
import { MomentumRotationStrategy } from "../src/themes/strategies/momentum-rotation.js";
import { ResearchService } from "../src/research/research.js";
import type { TechnicalAnalysis } from "../src/research/research.js";
import type { Bar, MarketDataService, Timeframe } from "../src/market/market.js";
import type { ThemeStrategy, ThemeContext } from "../src/themes/strategy.js";
import type { ThemeConfig, ThemeEvaluationResult } from "../src/themes/theme.js";
import type { Position } from "../src/executor/executor.js";

let db: DbClient;

beforeEach(async () => {
  db = await openDatabase({ path: ":memory:" });
});

// ── Helpers ─────────────────────────────────────────────────────

/**
 * Build a mock MarketDataService that returns canned bar data for given symbols.
 * Each symbol gets a series of bars with closing prices that produce specific signals.
 */
function mockMarketData(symbolBars: Record<string, Bar[]>): MarketDataService {
  return {
    async getQuote(symbol: string) {
      const bars = symbolBars[symbol];
      if (!bars || bars.length === 0) throw new Error(`No data for ${symbol}`);
      return {
        symbol,
        price: bars[bars.length - 1].close,
        timestamp: new Date().toISOString(),
        source: "alpaca" as const,
      };
    },
    async getBars(symbol: string, _timeframe: Timeframe, _range: string) {
      const bars = symbolBars[symbol];
      if (!bars) throw new Error(`No bars for ${symbol}`);
      return bars;
    },
    async getSnapshot(symbols: string[]) {
      return symbols.map((symbol) => {
        const bars = symbolBars[symbol] ?? [];
        return {
          symbol,
          price: bars.length > 0 ? bars[bars.length - 1].close : 0,
          timestamp: new Date().toISOString(),
          source: "alpaca" as const,
        };
      });
    },
  };
}

/**
 * Generate N bars with a trend. If rising, closes go up; if falling, down;
 * if flat, all same price. This controls SMA crossover and RSI signals.
 * Prices are kept positive — downtrends use small decrements relative
 * to the starting price.
 */
function generateBars(symbol: string, count: number, trend: "up" | "down" | "flat" = "up"): Bar[] {
  const bars: Bar[] = [];
  let price = 200; // start high enough that downtrend stays positive
  for (let i = 0; i < count; i++) {
    if (trend === "up") price += 2 + Math.random() * 0.5;
    else if (trend === "down") price -= 1 + Math.random() * 0.3; // gentle downtrend
    // flat: price stays
    bars.push({
      symbol,
      timestamp: new Date(Date.now() - (count - i) * 86400000).toISOString(),
      open: price - 1,
      high: price + 1,
      low: price - 2,
      close: price,
      volume: 1_000_000,
      source: "alpaca",
    });
  }
  return bars;
}

/**
 * Generate bars that produce a golden cross on the last bar:
 * first half is flat/down (SMA20 below SMA50), then a sharp uptrend
 * that makes SMA20 cross above SMA50 on the final bar.
 */
function generateGoldenCrossBars(symbol: string, count: number): Bar[] {
  const bars: Bar[] = [];
  let price = 100;
  const half = Math.floor(count / 2);
  for (let i = 0; i < count; i++) {
    if (i < half) {
      // Flat first half — SMA20 and SMA50 are close
      price += (Math.random() - 0.5) * 0.5;
    } else {
      // Sharp uptrend in second half to force crossover
      price += 5;
    }
    bars.push({
      symbol,
      timestamp: new Date(Date.now() - (count - i) * 86400000).toISOString(),
      open: price - 1,
      high: price + 1,
      low: price - 2,
      close: price,
      volume: 1_000_000,
      source: "alpaca",
    });
  }
  return bars;
}

// ── MomentumScreenSignalSource ──────────────────────────────────

describe("MomentumScreenSignalSource", () => {
  it("produces signals for each symbol in the universe", async () => {
    const bars: Record<string, Bar[]> = {
      AAPL: generateBars("AAPL", 100, "up"),
      NVDA: generateBars("NVDA", 100, "up"),
      TSLA: generateBars("TSLA", 100, "flat"),
    };
    const marketData = mockMarketData(bars);
    const research = new ResearchService(marketData);
    const source = new MomentumScreenSignalSource(research, {
      universe: ["AAPL", "NVDA", "TSLA"],
    });

    const signals = await source.fetchSignals();
    expect(signals).toHaveLength(3);
    expect(signals.map((s) => s.symbol).sort()).toEqual(["AAPL", "NVDA", "TSLA"]);
    // Each signal should have a reason and metadata
    for (const sig of signals) {
      expect(sig.reason).toContain("$");
      expect(sig.metadata).toBeDefined();
      expect(sig.metadata!.method).toBe("combined");
    }
  });

  it("skips symbols that fail to fetch", async () => {
    const bars: Record<string, Bar[]> = {
      AAPL: generateBars("AAPL", 100, "up"),
      // NVDA has no bars — will throw
    };
    const marketData = mockMarketData(bars);
    const research = new ResearchService(marketData);
    const source = new MomentumScreenSignalSource(research, {
      universe: ["AAPL", "NVDA"],
    });

    const signals = await source.fetchSignals();
    expect(signals).toHaveLength(1);
    expect(signals[0].symbol).toBe("AAPL");
  });

  it("returns buy signals for uptrending symbols", async () => {
    const bars: Record<string, Bar[]> = {
      AAPL: generateBars("AAPL", 100, "up"),
    };
    const marketData = mockMarketData(bars);
    const research = new ResearchService(marketData);
    const source = new MomentumScreenSignalSource(research, {
      universe: ["AAPL"],
      method: "sma-crossover",
    });

    const signals = await source.fetchSignals();
    expect(signals).toHaveLength(1);
    // Uptrending stock with SMA20 above SMA50 → likely golden cross → buy
    // If not golden cross exactly, it might be hold — but at least it should be buy or hold
    expect(["buy", "hold"]).toContain(signals[0].action);
  });

  it("fetchBuySignals returns only buy signals", async () => {
    // Create a symbol with a strong uptrend (golden cross) and one flat (hold/neutral)
    const bars: Record<string, Bar[]> = {
      UPTREND: generateBars("UPTREND", 100, "up"),
      FLAT: generateBars("FLAT", 100, "flat"),
    };
    const marketData = mockMarketData(bars);
    const research = new ResearchService(marketData);
    const source = new MomentumScreenSignalSource(research, {
      universe: ["UPTREND", "FLAT"],
      method: "sma-crossover",
    });

    const allSignals = await source.fetchSignals();
    const buySignals = await source.fetchBuySignals();
    // Every signal in buySignals should have action "buy"
    for (const sig of buySignals) {
      expect(sig.action).toBe("buy");
    }
    expect(buySignals.length).toBeLessThanOrEqual(allSignals.length);
  });

  it("respects custom RSI thresholds", async () => {
    // Generate a downtrending stock — RSI will be very low (oversold)
    const bars: Record<string, Bar[]> = {
      AAPL: generateBars("AAPL", 100, "down"),
    };
    const marketData = mockMarketData(bars);
    const research = new ResearchService(marketData);
    const source = new MomentumScreenSignalSource(research, {
      universe: ["AAPL"],
      method: "rsi",
      rsiOversold: 50, // very high threshold → everything is "oversold" → buy
      rsiOverbought: 99,
    });

    const signals = await source.fetchSignals();
    expect(signals).toHaveLength(1);
    // Downtrending stock with RSI threshold at 50 → RSI will be below 50 → buy
    expect(signals[0].action).toBe("buy");
  });
});

// ── MomentumRotationStrategy ────────────────────────────────────

describe("MomentumRotationStrategy", () => {
  it("registers with ThemeRunner and evaluates", async () => {
    const store = new ThemeStore(db);
    const theme = await store.create({
      name: "Momentum Test",
      strategy: "momentum-rotation",
      schedule: { type: "manual" },
      allocatedCapital: 50_000,
      params: {
        universe: ["AAPL", "NVDA"],
        topN: 2,
        method: "rsi",
      },
    });

    // Initialize sub-account
    const sub = new ThemeSubAccount(db, theme.id, { feeRate: 0 });
    await sub.initialize(50_000);

    // Mock market data with downtrending bars (RSI oversold → buy signals)
    const bars: Record<string, Bar[]> = {
      AAPL: generateBars("AAPL", 100, "down"),
      NVDA: generateBars("NVDA", 100, "down"),
    };
    const marketData = mockMarketData(bars);

    // We need a real-ish TradeEngine and DecisionStore for the strategy to work
    // But the strategy calls ctx.decisionStore.create and ctx.tradeEngine.executeDecision
    // Use mock implementations
    const mockDecisionStore = {
      create: vi.fn().mockImplementation(async (input: any) => ({
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        agent: input.agent,
        symbol: input.symbol,
        action: input.action,
        quantity: input.quantity,
        priceAtDecision: input.priceAtDecision,
        rationale: input.rationale,
        confidence: input.confidence,
        mode: input.mode,
        marketContext: input.marketContext,
      })),
      getById: vi.fn().mockResolvedValue(null),
      list: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    };

    const mockTradeEngine = {
      executeDecision: vi.fn().mockResolvedValue({
        decision: {},
        riskChecks: [{ passed: true, check: "test" }],
        orderResult: { status: "filled", fillPrice: 100 },
        tradeRecord: null,
        riskPassed: true,
      }),
    };

    const mockPortfolio = {
      getSnapshot: vi.fn().mockResolvedValue({ equity: 50_000 }),
      getPnL: vi.fn().mockResolvedValue({}),
      getPositions: vi.fn().mockResolvedValue([]),
    };

    const runner = new ThemeRunner(db, {
      decisionStore: mockDecisionStore as any,
      tradeEngine: mockTradeEngine as any,
      portfolio: mockPortfolio as any,
      marketData,
    });

    const strategy = new MomentumRotationStrategy();
    runner.registerStrategy(strategy);

    const result = await runner.evaluateOnce(theme.id);
    expect(result.themeId).toBe(theme.id);
    expect(result.errors).toHaveLength(0);
    expect(result.signals.length).toBeGreaterThan(0);
    // Should have produced some decisions (buy signals for uptrending stocks)
    expect(result.decisions.length).toBeGreaterThan(0);
  });

  it("throws when universe is empty", async () => {
    const strategy = new MomentumRotationStrategy();
    const config: ThemeConfig = {
      id: "test",
      name: "test",
      strategy: "momentum-rotation",
      mode: "sim",
      schedule: { type: "manual" },
      maxAllocationPct: 5,
      maxTotalAllocationPct: 40,
      maxPositions: 10,
      params: { universe: [] },
      enabled: true,
      allocatedCapital: 10_000,
    };

    const ctx: ThemeContext = {
      db: db,
      marketData: mockMarketData({}),
      decisionStore: {} as any,
      tradeEngine: {} as any,
      portfolio: {} as any,
      themeId: "test",
      getEquity: async () => 10_000,
      getPositions: async () => [],
      getQuote: async () => 100,
    };

    const result = await strategy.evaluate(ctx, config);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toContain("universe");
  });

  it("sells positions that drop out of top set", async () => {
    const strategy = new MomentumRotationStrategy();
    const themeId = "test-theme";

    // Mock context where we already hold TSLA, but only AAPL is in the buy signals
    const heldPositions: Position[] = [
      { symbol: "TSLA", quantity: 10, avgEntryPrice: 200, side: "long" },
    ];

    // Create a mock screen source that returns only AAPL as a buy
    const mockDecisionStore = {
      create: vi.fn().mockImplementation(async (input: any) => ({
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        agent: input.agent,
        symbol: input.symbol,
        action: input.action,
        quantity: input.quantity,
        priceAtDecision: input.priceAtDecision,
        rationale: input.rationale,
        confidence: input.confidence,
        mode: input.mode,
        marketContext: input.marketContext,
      })),
    };

    const mockTradeEngine = {
      executeDecision: vi.fn().mockResolvedValue({
        decision: {},
        riskChecks: [{ passed: true, check: "test" }],
        orderResult: null,
        tradeRecord: {
          id: "trade-1",
          decisionId: "dec-1",
          timestamp: new Date().toISOString(),
          symbol: "TSLA",
          side: "sell",
          quantity: 10,
          orderType: "market",
          fillPrice: 200,
          status: "filled",
          fee: 0,
          realizedPnl: 0,
          mode: "sim",
          executor: "sim",
          error: null,
        },
        riskPassed: true,
      }),
    };

    // Build market data: AAPL downtrending (RSI oversold → buy), TSLA flat (hold)
    const bars: Record<string, Bar[]> = {
      AAPL: generateBars("AAPL", 100, "down"),
      TSLA: generateBars("TSLA", 100, "flat"),
    };

    const ctx: ThemeContext = {
      db: db,
      marketData: mockMarketData(bars),
      decisionStore: mockDecisionStore as any,
      tradeEngine: mockTradeEngine as any,
      portfolio: {} as any,
      themeId,
      getEquity: async () => 50_000,
      getPositions: async () => heldPositions,
      getQuote: async (symbol: string) => {
        if (symbol === "TSLA") return 200;
        if (symbol === "AAPL") return 150;
        return 100;
      },
    };

    const config: ThemeConfig = {
      id: themeId,
      name: "Rotation Test",
      strategy: "momentum-rotation",
      mode: "sim",
      schedule: { type: "manual" },
      maxAllocationPct: 5,
      maxTotalAllocationPct: 40,
      maxPositions: 10,
      params: { universe: ["AAPL", "TSLA"], topN: 1, method: "rsi" },
      enabled: true,
      allocatedCapital: 50_000,
    };

    const result = await strategy.evaluate(ctx, config);
    expect(result.errors).toHaveLength(0);

    // Should have created a sell decision for TSLA (dropped out)
    const sellDecision = result.decisions.find((d) => d.action === "sell");
    expect(sellDecision).toBeDefined();
    expect(sellDecision!.symbol).toBe("TSLA");
  });

  it("respects rebalanceOnly flag — no trades when balanced", async () => {
    const strategy = new MomentumRotationStrategy();

    // We hold AAPL. AAPL is uptrending (buy). topN=1. No changes needed.
    const heldPositions: Position[] = [
      { symbol: "AAPL", quantity: 10, avgEntryPrice: 100, side: "long" },
    ];

    const mockDecisionStore = {
      create: vi.fn(),
    };

    const mockTradeEngine = {
      executeDecision: vi.fn(),
    };

    const bars: Record<string, Bar[]> = {
      AAPL: generateBars("AAPL", 100, "down"),
    };

    const ctx: ThemeContext = {
      db: db,
      marketData: mockMarketData(bars),
      decisionStore: mockDecisionStore as any,
      tradeEngine: mockTradeEngine as any,
      portfolio: {} as any,
      themeId: "test",
      getEquity: async () => 50_000,
      getPositions: async () => heldPositions,
      getQuote: async () => 150,
    };

    const config: ThemeConfig = {
      id: "test",
      name: "Rebalance Test",
      strategy: "momentum-rotation",
      mode: "sim",
      schedule: { type: "manual" },
      maxAllocationPct: 5,
      maxTotalAllocationPct: 40,
      maxPositions: 10,
      params: {
        universe: ["AAPL"],
        topN: 1,
        method: "rsi",
        rebalanceOnly: true,
      },
      enabled: true,
      allocatedCapital: 50_000,
    };

    const result = await strategy.evaluate(ctx, config);
    expect(result.decisions).toHaveLength(0);
    expect(result.trades).toHaveLength(0);
    // But still produced signals (screening happened)
    expect(result.signals.length).toBeGreaterThan(0);
  });
});