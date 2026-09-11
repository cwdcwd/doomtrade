/**
 * Tests for AgentTradingPipeline.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { openDatabase, type Database } from "../src/db/database.js";
import { AgentManager } from "../src/agent/agent-manager.js";
import { AgentTradingPipeline } from "../src/agent/trading-pipeline.js";
import type { ThemeStrategy, ThemeContext } from "../src/themes/strategy.js";
import type { ThemeConfig, ThemeEvaluationResult } from "../src/themes/theme.js";

let db: Database;
let manager: AgentManager;

// A simple test strategy that always generates one buy signal
class TestBuyStrategy implements ThemeStrategy {
  readonly type = "test-buy";
  async evaluate(ctx: ThemeContext, config: ThemeConfig): Promise<ThemeEvaluationResult> {
    return {
      themeId: config.id,
      timestamp: new Date().toISOString(),
      signals: [{ symbol: "ETH/USDT", action: "buy", reason: "Test buy signal" }],
      decisions: [],
      trades: [],
      errors: [],
    };
  }
}

// A no-op strategy that returns no signals
class NoopStrategy implements ThemeStrategy {
  readonly type = "noop";
  async evaluate(_ctx: ThemeContext, _config: ThemeConfig): Promise<ThemeEvaluationResult> {
    return {
      themeId: "test",
      timestamp: new Date().toISOString(),
      signals: [],
      decisions: [],
      trades: [],
      errors: [],
    };
  }
}

// Mock market data service
const mockMarketData = {
  async getQuote(symbol: string) {
    const prices: Record<string, number> = {
      "ETH/USDT": 2000,
      "BTC/USDT": 50000,
      "ADA/USDT": 0.5,
    };
    return { symbol, price: prices[symbol] ?? 100, bid: 100, ask: 100, timestamp: new Date().toISOString(), source: "mock" };
  },
  async getBars() { return []; },
  async getSnapshot(symbols: string[]) {
    return symbols.map((s) => ({ symbol: s, price: 100, change: 0, changePct: 0, volume: 0, timestamp: new Date().toISOString(), source: "mock" }));
  },
} as any;

beforeEach(async () => {
  db = await openDatabase({ path: ":memory:", url: undefined });
  manager = new AgentManager(db, { defaultStartingBalance: 100, feeRate: 0.001 });
});

describe("AgentTradingPipeline", () => {
  it("runs a cycle for agents with assigned strategies", async () => {
    await manager.register("Doom", { startingBalance: 100, strategy: "test-buy" });
    await manager.register("Kangbot", { startingBalance: 100, strategy: "noop" });
    await manager.register("NoStrategy", { startingBalance: 100 }); // no strategy

    const strategies = new Map<string, ThemeStrategy>();
    strategies.set("test-buy", new TestBuyStrategy());
    strategies.set("noop", new NoopStrategy());

    const pipeline = new AgentTradingPipeline({
      agentManager: manager,
      marketData: mockMarketData,
      db,
      strategies,
      defaultUniverse: ["ETH/USDT", "BTC/USDT"],
    });

    const results = await pipeline.runCycle();

    // Only agents with strategies should be processed
    expect(results).toHaveLength(2); // Doom + Kangbot, not NoStrategy

    const doom = results.find((r) => r.agentName === "Doom");
    expect(doom).toBeDefined();
    expect(doom!.signals).toBe(1);
    expect(doom!.errors).toHaveLength(0);

    const kangbot = results.find((r) => r.agentName === "Kangbot");
    expect(kangbot).toBeDefined();
    expect(kangbot!.signals).toBe(0);
  });

  it("handles unknown strategy gracefully", async () => {
    await manager.register("TestBot", { startingBalance: 100, strategy: "nonexistent" });

    const strategies = new Map<string, ThemeStrategy>();
    const pipeline = new AgentTradingPipeline({
      agentManager: manager,
      marketData: mockMarketData,
      db,
      strategies,
      defaultUniverse: ["ETH/USDT"],
    });

    const results = await pipeline.runCycle();
    expect(results).toHaveLength(1);
    expect(results[0].errors[0]).toContain("Strategy not registered");
  });

  it("produces a leaderboard summary", async () => {
    await manager.register("Doom", { startingBalance: 100, strategy: "noop" });
    await manager.register("Kangbot", { startingBalance: 100, strategy: "noop" });

    const strategies = new Map<string, ThemeStrategy>();
    strategies.set("noop", new NoopStrategy());

    const pipeline = new AgentTradingPipeline({
      agentManager: manager,
      marketData: mockMarketData,
      db,
      strategies,
      defaultUniverse: ["ETH/USDT"],
    });

    const summary = await pipeline.getSummary();
    expect(summary).toHaveLength(2);
    expect(summary[0]).toContain("#1");
    expect(summary[0]).toContain("Doom");
  });

  it("tracks equity before and after", async () => {
    await manager.register("Doom", { startingBalance: 100, strategy: "noop" });

    const strategies = new Map<string, ThemeStrategy>();
    strategies.set("noop", new NoopStrategy());

    const pipeline = new AgentTradingPipeline({
      agentManager: manager,
      marketData: mockMarketData,
      db,
      strategies,
      defaultUniverse: ["ETH/USDT"],
    });

    const results = await pipeline.runCycle();
    expect(results[0].equityBefore).toBe(100);
    expect(results[0].equityAfter).toBe(100); // noop strategy, no trades
    expect(results[0].pnlChange).toBe(0);
  });

  // fleet-ops-p1j: momentum-rotation must request enough bars for its
  // slowest indicator. With range "1m" (~30 daily bars) smaCrossover
  // (fast 20 / slow 50) needs 51 values and returns "neutral"
  // unconditionally — the agent could never trade, silently.
  it("momentum-rotation params request enough bars for the slowest indicator", async () => {
    const seenConfigs: ThemeConfig[] = [];
    class CapturingStrategy implements ThemeStrategy {
      readonly type = "momentum-rotation";
      async evaluate(_ctx: ThemeContext, config: ThemeConfig): Promise<ThemeEvaluationResult> {
        seenConfigs.push(config);
        return {
          themeId: config.id,
          timestamp: new Date().toISOString(),
          signals: [],
          decisions: [],
          trades: [],
          errors: [],
        };
      }
    }

    const strategies = new Map<string, ThemeStrategy>();
    strategies.set("momentum-rotation", new CapturingStrategy());

    const pipeline = new AgentTradingPipeline({
      agentManager: manager,
      marketData: mockMarketData,
      db,
      strategies,
      defaultUniverse: ["ETH/USDT"],
    });

    await manager.register("Doom", { startingBalance: 100, strategy: "momentum-rotation" });

    await pipeline.runCycle();

    expect(seenConfigs).toHaveLength(1);
    const params = seenConfigs[0].params as {
      range: string;
      indicator: { type: string; periods: { fast: number; slow: number } };
    };
    expect(params.indicator.periods.slow).toBeGreaterThan(0);

    // Mirror ccxt-data parseRangeDays: "6m" → 180 days ≈ 180 daily bars.
    const match = params.range.match(/^(\d+)([dwmy])$/);
    expect(match).not.toBeNull();
    const n = parseInt(match![1], 10);
    const days =
      match![2] === "d" ? n : match![2] === "w" ? n * 7 : match![2] === "m" ? n * 30 : n * 365;
    // smaCrossover requires slow + 1 closes; this is the strict minimum —
    // anything less means the indicator can never emit a signal.
    expect(days).toBeGreaterThanOrEqual(params.indicator.periods.slow + 1);
  });
});