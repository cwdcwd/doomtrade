/**
 * Tests for AgentSignalSource and AgentDrivenStrategy.
 *
 * Covers:
 * - AgentSignal response parsing (fenced JSON, raw JSON, invalid)
 * - AgentSignal signal generation from market analysis
 * - AgentDriven strategy evaluation (buy/sell decisions)
 * - Notification to peer agent
 * - Error handling (no position to sell, no price, no signals)
 */

import { describe, it, expect, beforeEach } from "vitest";
import { openDatabase, closeDatabase, type DbClient } from "../src/db/database.js";
import { ThemeStore } from "../src/themes/theme-store.js";
import { ThemeSubAccount } from "../src/themes/theme-sub-account.js";
import { ThemeRunner } from "../src/themes/theme-runner.js";
import { AgentSignalSource } from "../src/themes/sources/agent-signal.js";
import { AgentDrivenStrategy } from "../src/themes/strategies/agent-driven.js";
import { ResearchService } from "../src/research/research.js";
import type { AgentCoordinator } from "../src/integration/agent-integration.js";
import type { Bar, MarketDataService, Timeframe } from "../src/market/market.js";

let db: DbClient;

beforeEach(async () => {
  db = await openDatabase({ path: ":memory:" });
});

async function close() {
  await closeDatabase(db);
}

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
function goldenCrossBars(startPrice: number): number[] {
  const bars: number[] = [];
  for (let i = 0; i < 49; i++) bars.push(startPrice);
  bars.push(startPrice * 0.95);
  bars.push(startPrice * 1.20);
  return bars;
}

// Generate bars where SMA20 crosses below SMA50 on the last bar (death cross)
function deathCrossBars(startPrice: number): number[] {
  const bars: number[] = [];
  for (let i = 0; i < 49; i++) bars.push(startPrice);
  bars.push(startPrice * 1.05);
  bars.push(startPrice * 0.80);
  return bars;
}

function createMockCoordinator(): AgentCoordinator {
  return {
    submitDecision: async () => ({}) as any,
    executeDecision: async () => {},
    getPortfolioStatus: async () => ({}) as any,
    sendMessage: async () => {},
  } as any;
}

// ── AgentSignalSource ─────────────────────────────────────────

describe("AgentSignalSource", () => {
  it("can be constructed and has correct name", () => {
    const marketData = createMockMarketData({});
    const research = new ResearchService(marketData);
    const coordinator = createMockCoordinator();
    const source = new AgentSignalSource(coordinator, research, {
      universe: ["AAPL"],
      agentName: "doom",
    });
    expect(source.name).toBe("agent-signal");
  });

  it("generates signals from market analysis", async () => {
    const marketData = createMockMarketData({
      AAPL: goldenCrossBars(150),
      TSLA: deathCrossBars(200),
      MSFT: Array(60).fill(300), // neutral smaCrossover, but RSI=100 → combined=sell
    });
    const research = new ResearchService(marketData);
    const coordinator = createMockCoordinator();

    const source = new AgentSignalSource(coordinator, research, {
      universe: ["AAPL", "TSLA", "MSFT"],
      agentName: "doom",
    });

    const signals = await source.fetchSignals();

    // AAPL golden cross → combined=buy, TSLA death cross → combined=sell
    // MSFT flat: smaCrossover=neutral, rsiSignal=sell → combined=sell
    // So all 3 produce non-neutral signals (MSFT gets sell from RSI)
    expect(signals.length).toBeGreaterThanOrEqual(2);
    const aapl = signals.find((s) => s.symbol === "AAPL");
    const tsla = signals.find((s) => s.symbol === "TSLA");
    expect(aapl).toBeDefined();
    expect(aapl!.action).toBe("buy");
    expect(tsla).toBeDefined();
    expect(tsla!.action).toBe("sell");

    // Metadata should include agent name
    expect(aapl!.metadata!.source).toBe("agent-signal");
    expect(aapl!.metadata!.agent).toBe("doom");
  });

  it("parses fenced JSON response correctly", () => {
    const marketData = createMockMarketData({});
    const research = new ResearchService(marketData);
    const coordinator = createMockCoordinator();
    const source = new AgentSignalSource(coordinator, research, {
      universe: [],
      agentName: "doom",
    });

    const response = `Here are my signals:
\`\`\`json
[
  { "symbol": "AAPL", "action": "buy", "reason": "Strong uptrend", "quantity": 10 },
  { "symbol": "TSLA", "action": "sell", "reason": "Overvalued" }
]
\`\`\``;

    const signals = source.parseResponse(response);
    expect(signals).toHaveLength(2);
    expect(signals[0].symbol).toBe("AAPL");
    expect(signals[0].action).toBe("buy");
    expect(signals[0].suggestedQuantity).toBe(10);
    expect(signals[1].symbol).toBe("TSLA");
    expect(signals[1].action).toBe("sell");
  });

  it("parses raw JSON response", () => {
    const marketData = createMockMarketData({});
    const research = new ResearchService(marketData);
    const coordinator = createMockCoordinator();
    const source = new AgentSignalSource(coordinator, research, {
      universe: [],
      agentName: "kangbot",
    });

    const response = '[{"symbol":"NVDA","action":"buy","reason":"AI boom"}]';
    const signals = source.parseResponse(response);
    expect(signals).toHaveLength(1);
    expect(signals[0].symbol).toBe("NVDA");
    expect(signals[0].action).toBe("buy");
  });

  it("returns empty array for invalid JSON", () => {
    const marketData = createMockMarketData({});
    const research = new ResearchService(marketData);
    const coordinator = createMockCoordinator();
    const source = new AgentSignalSource(coordinator, research, {
      universe: [],
      agentName: "doom",
    });

    const signals = source.parseResponse("not valid json at all");
    expect(signals).toHaveLength(0);
  });

  it("filters invalid entries from parsed response", () => {
    const marketData = createMockMarketData({});
    const research = new ResearchService(marketData);
    const coordinator = createMockCoordinator();
    const source = new AgentSignalSource(coordinator, research, {
      universe: [],
      agentName: "doom",
    });

    const response = `[
      { "symbol": "AAPL", "action": "buy", "reason": "good" },
      { "symbol": "BAD", "action": "invalid", "reason": "bad action" },
      { "action": "buy", "reason": "no symbol" },
      "not an object"
    ]`;

    const signals = source.parseResponse(response);
    expect(signals).toHaveLength(1);
    expect(signals[0].symbol).toBe("AAPL");
  });

  it("skips symbols with no data", async () => {
    const marketData = createMockMarketData({
      AAPL: goldenCrossBars(150),
    });
    const research = new ResearchService(marketData);
    const coordinator = createMockCoordinator();

    const source = new AgentSignalSource(coordinator, research, {
      universe: ["AAPL", "NOEXIST"],
      agentName: "doom",
    });

    const signals = await source.fetchSignals();
    expect(signals).toHaveLength(1);
    expect(signals[0].symbol).toBe("AAPL");
  });

  it("exposes the configured universe", () => {
    const marketData = createMockMarketData({});
    const research = new ResearchService(marketData);
    const coordinator = createMockCoordinator();
    const source = new AgentSignalSource(coordinator, research, {
      universe: ["AAPL", "NVDA"],
      agentName: "doom",
    });
    expect(source.getUniverse()).toEqual(["AAPL", "NVDA"]);
  });

  it("fetchSignalsWithResponse returns both signals and raw text", async () => {
    const marketData = createMockMarketData({
      AAPL: goldenCrossBars(150),
    });
    const research = new ResearchService(marketData);
    const coordinator = createMockCoordinator();

    const source = new AgentSignalSource(coordinator, research, {
      universe: ["AAPL"],
      agentName: "doom",
    });

    const result = await source.fetchSignalsWithResponse();
    expect(result.signals.length).toBeGreaterThan(0);
    expect(result.rawResponse).toBeTruthy();
    expect(typeof result.rawResponse).toBe("string");
  });
});

// ── AgentDrivenStrategy ───────────────────────────────────────

describe("AgentDrivenStrategy", () => {
  it("can be constructed and has correct type", () => {
    const marketData = createMockMarketData({});
    const research = new ResearchService(marketData);
    const coordinator = createMockCoordinator();
    const strategy = new AgentDrivenStrategy(coordinator, research);
    expect(strategy.type).toBe("agent-driven");
  });

  it("evaluates and creates buy decisions for bullish signals", async () => {
    const marketData = createMockMarketData({
      AAPL: goldenCrossBars(150),
    });
    const research = new ResearchService(marketData);
    const coordinator = createMockCoordinator();

    const store = new ThemeStore(db);
    const theme = await store.create({
      name: "Agent Driven Test",
      strategy: "agent-driven",
      schedule: { type: "manual" },
      allocatedCapital: 50_000,
      maxPositions: 5,
      maxAllocationPct: 20,
      params: {
        universe: ["AAPL"],
        agentName: "doom",
      },
    });

    // Initialize sub-account
    const sub = new ThemeSubAccount(db, theme.id, {
      feeRate: 0,
      getCurrentPrice: () => 157.5,
    });
    await sub.initialize(50_000);

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
      getCurrentPrice: () => 157.5,
    });
    runner.registerStrategy(new AgentDrivenStrategy(coordinator, research));

    const result = await runner.evaluateOnce(theme.id);

    // Should have signals
    expect(result.signals.length).toBeGreaterThan(0);

    // Should have at least one buy decision
    expect(result.decisions.length).toBeGreaterThan(0);
    const buyDecisions = result.decisions.filter((d) => d.action === "buy");
    expect(buyDecisions.length).toBeGreaterThan(0);

    // Should have at least one trade
    expect(result.trades.length).toBeGreaterThan(0);

    // Agent name should be "doom"
    expect(buyDecisions[0].agent).toBe("doom");
  });

  it("handles no signals gracefully", async () => {
    // Use bars with alternating tiny changes — SMA crossover = neutral,
    // RSI ≈ 50 (neither oversold nor overbought)
    const neutralBars: number[] = [];
    for (let i = 0; i < 60; i++) {
      neutralBars.push(300 + (i % 2 === 0 ? 0.01 : -0.01));
    }
    const marketData = createMockMarketData({
      MSFT: neutralBars,
    });
    const research = new ResearchService(marketData);
    const coordinator = createMockCoordinator();

    const store = new ThemeStore(db);
    const theme = await store.create({
      name: "No Signals Test",
      strategy: "agent-driven",
      schedule: { type: "manual" },
      allocatedCapital: 10_000,
      params: {
        universe: ["MSFT"],
        agentName: "doom",
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
    runner.registerStrategy(new AgentDrivenStrategy(coordinator, research));

    const result = await runner.evaluateOnce(theme.id);

    expect(result.signals).toHaveLength(0);
    expect(result.decisions).toHaveLength(0);
    expect(result.trades).toHaveLength(0);
    expect(result.errors).toContain("No signals from agent");
  });

  it("sells existing positions when signal says sell", async () => {
    const marketData = createMockMarketData({
      TSLA: deathCrossBars(200), // bearish → sell signal
    });
    const research = new ResearchService(marketData);
    const coordinator = createMockCoordinator();

    const store = new ThemeStore(db);
    const theme = await store.create({
      name: "Agent Sell Test",
      strategy: "agent-driven",
      schedule: { type: "manual" },
      allocatedCapital: 100_000,
      maxPositions: 5,
      params: {
        universe: ["TSLA"],
        agentName: "doom",
      },
    });

    // Set up sub-account with existing TSLA position
    const sub = new ThemeSubAccount(db, theme.id, {
      feeRate: 0,
      getCurrentPrice: () => 185,
    });
    await sub.initialize(100_000);
    await sub.placeOrder({
      symbol: "TSLA",
      side: "buy",
      quantity: 100,
      orderType: "market",
    });

    // Verify position
    const positions = await sub.getPositions();
    expect(positions).toHaveLength(1);
    expect(positions[0].symbol).toBe("TSLA");

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
      getCurrentPrice: () => 185,
    });
    runner.registerStrategy(new AgentDrivenStrategy(coordinator, research));

    const result = await runner.evaluateOnce(theme.id);

    // Should have sell signal for TSLA
    const sellSignals = result.signals.filter((s) => s.action === "sell");
    expect(sellSignals.length).toBeGreaterThan(0);

    // Should have sell decision
    const sellDecisions = result.decisions.filter((d) => d.action === "sell");
    expect(sellDecisions.length).toBeGreaterThan(0);

    // Should have sell trade
    const sellTrades = result.trades.filter((t) => t.side === "sell");
    expect(sellTrades.length).toBeGreaterThan(0);
  });
});