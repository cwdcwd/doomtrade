/**
 * Tests for A2ATradingCoordinator — multi-agent trading pipeline.
 *
 * Verifies the end-to-end flow:
 *   1. Doom (researcher) evaluates strategy and generates signals
 *   2. Kangbot (validator) reviews and approves/vetoes signals
 *   3. ThanosBot (executor) executes approved trades
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Database } from "../src/db/database.js";
import { openDatabase, closeDatabase } from "../src/db/database.js";
import { AgentManager } from "../src/agent/agent-manager.js";
import { AgentTradingPipeline } from "../src/agent/trading-pipeline.js";
import { A2ATradingCoordinator } from "../src/integration/a2a-trading-coordinator.js";
import { MomentumRotationStrategy } from "../src/themes/strategies/momentum-rotation.js";
import { CongressFollowerStrategy } from "../src/themes/strategies/congress-follower.js";
import { AgentDrivenStrategy } from "../src/themes/strategies/agent-driven.js";
import type { MarketDataService } from "../src/market/market.js";

// ── Test helpers ────────────────────────────────────────────────

function createMockMarketData(prices: Map<string, number>): MarketDataService {
  return {
    getQuote: async (symbol: string) => {
      const price = prices.get(symbol) ?? 100;
      return { symbol, price, timestamp: new Date().toISOString(), source: "ccxt" as const };
    },
    getBars: async (_symbol: string) => [],
    getSnapshot: async (symbols: string[]) =>
      symbols.map((s) => ({ symbol: s, price: prices.get(s) ?? 100, timestamp: new Date().toISOString(), source: "ccxt" as const })),
  };
}

async function setupAgents(agentManager: AgentManager) {
  // Register Doom as researcher with momentum-rotation strategy
  await agentManager.register("Doom", { strategy: "momentum-rotation", startingBalance: 100 });
  // Register Kangbot as validator
  await agentManager.register("Kangbot", { strategy: "momentum-rotation", startingBalance: 100 });
  // Register ThanosBot as executor
  await agentManager.register("ThanosBot", { strategy: "momentum-rotation", startingBalance: 100 });
}

async function setupPipeline(db: Database, agentManager: AgentManager) {
  const prices = new Map<string, number>([
    ["BTC/USDT", 50000],
    ["ETH/USDT", 3000],
    ["SOL/USDT", 100],
  ]);

  const marketData = createMockMarketData(prices);

  const strategies = new Map<string, import("../src/themes/strategy.js").ThemeStrategy>();
  strategies.set("momentum-rotation", new MomentumRotationStrategy());
  strategies.set("congress-follower", new CongressFollowerStrategy());
  strategies.set("agent-driven", new AgentDrivenStrategy());

  const pipeline = new AgentTradingPipeline({
    agentManager,
    marketData,
    db,
    strategies,
    defaultUniverse: ["BTC/USDT", "ETH/USDT", "SOL/USDT"],
  });

  return { pipeline, prices, marketData };
}

// ── Tests ────────────────────────────────────────────────────────

describe("A2ATradingCoordinator", () => {
  let db: Database;

  beforeEach(async () => {
    db = await openDatabase({ path: ":memory:" });
  });

  afterEach(async () => {
    await closeDatabase(db);
  });

  it("should run a full A2A cycle with all three agents", async () => {
    const agentManager = new AgentManager(db, {
      defaultStartingBalance: 100,
      feeRate: 0.001,
      getCurrentPrice: (s: string) => 100,
    });
    await setupAgents(agentManager);
    const { pipeline } = await setupPipeline(db, agentManager);

    const coordinator = new A2ATradingCoordinator({
      agentManager,
      agentPipeline: pipeline,
      db,
    });

    const result = await coordinator.runCycle();

    expect(result.researcher).toBe("Doom");
    expect(result.validator).toBe("Kangbot");
    expect(result.executor).toBe("ThanosBot");
    expect(Array.isArray(result.signals)).toBe(true);
    expect(Array.isArray(result.validations)).toBe(true);
    expect(Array.isArray(result.errors)).toBe(true);
  });

  it("should return signals from the researcher's strategy evaluation", async () => {
    const agentManager = new AgentManager(db, {
      defaultStartingBalance: 100,
      feeRate: 0.001,
      getCurrentPrice: (s: string) => 100,
    });
    await setupAgents(agentManager);
    const { pipeline } = await setupPipeline(db, agentManager);

    const coordinator = new A2ATradingCoordinator({
      agentManager,
      agentPipeline: pipeline,
      db,
    });

    const result = await coordinator.runCycle();

    // Researcher should have been invoked
    expect(result.researcherResult).not.toBeNull();
    if (result.researcherResult) {
      expect(result.researcherResult.agentName).toBe("Doom");
      expect(result.researcherResult.strategy).toBe("momentum-rotation");
    }
  });

  it("should validate all signals (approve or reject)", async () => {
    const agentManager = new AgentManager(db, {
      defaultStartingBalance: 100,
      feeRate: 0.001,
      getCurrentPrice: (s: string) => 100,
    });
    await setupAgents(agentManager);
    const { pipeline } = await setupPipeline(db, agentManager);

    const coordinator = new A2ATradingCoordinator({
      agentManager,
      agentPipeline: pipeline,
      db,
    });

    const result = await coordinator.runCycle();

    // Every signal should have a corresponding validation
    expect(result.validations.length).toBe(result.signals.length);
    for (const v of result.validations) {
      expect(typeof v.approved).toBe("boolean");
      expect(typeof v.reason).toBe("string");
    }
  });

  it("should handle missing researcher gracefully", async () => {
    const agentManager = new AgentManager(db, {
      defaultStartingBalance: 100,
      feeRate: 0.001,
      getCurrentPrice: (s: string) => 100,
    });
    // Only register Kangbot and ThanosBot — no Doom
    await agentManager.register("Kangbot", { strategy: "momentum-rotation" });
    await agentManager.register("ThanosBot", { strategy: "momentum-rotation" });
    const { pipeline } = await setupPipeline(db, agentManager);

    const coordinator = new A2ATradingCoordinator({
      agentManager,
      agentPipeline: pipeline,
      db,
    });

    const result = await coordinator.runCycle();

    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => e.includes("Researcher"))).toBe(true);
  });

  it("should auto-approve signals when validator is missing", async () => {
    const agentManager = new AgentManager(db, {
      defaultStartingBalance: 100,
      feeRate: 0.001,
      getCurrentPrice: (s: string) => 100,
    });
    // Only register Doom — no Kangbot, no ThanosBot
    await agentManager.register("Doom", { strategy: "momentum-rotation" });
    const { pipeline } = await setupPipeline(db, agentManager);

    const coordinator = new A2ATradingCoordinator({
      agentManager,
      agentPipeline: pipeline,
      db,
    });

    const result = await coordinator.runCycle();

    // If there are signals, they should be auto-approved
    for (const v of result.validations) {
      expect(v.approved).toBe(true);
      expect(v.reason).toContain("auto-approved");
    }
  });

  it("should support custom role assignments", async () => {
    const agentManager = new AgentManager(db, {
      defaultStartingBalance: 100,
      feeRate: 0.001,
      getCurrentPrice: (s: string) => 100,
    });
    await agentManager.register("AlphaBot", { strategy: "momentum-rotation" });
    await agentManager.register("BetaBot", { strategy: "momentum-rotation" });
    await agentManager.register("GammaBot", { strategy: "momentum-rotation" });
    const { pipeline } = await setupPipeline(db, agentManager);

    const coordinator = new A2ATradingCoordinator({
      agentManager,
      agentPipeline: pipeline,
      db,
      roles: {
        researcher: "AlphaBot",
        validator: "BetaBot",
        executor: "GammaBot",
      },
    });

    const result = await coordinator.runCycle();

    expect(result.researcher).toBe("AlphaBot");
    expect(result.validator).toBe("BetaBot");
    expect(result.executor).toBe("GammaBot");
  });
});