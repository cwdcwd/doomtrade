/**
 * Tests for the experimental themes core framework.
 *
 * Covers:
 * - ThemeStore CRUD (create, getById, list, update, delete)
 * - ThemeStore signal dedup
 * - ThemeStore evaluation records
 * - ThemeSubAccount (initialize, balance, positions, orders)
 * - ThemeRunner (register, evaluateOnce, performance)
 * - ManualListSignalSource
 */

import { describe, it, expect, beforeEach } from "vitest";
import { openDatabase, closeDatabase, type DbClient } from "../src/db/database.js";
import { ThemeStore } from "../src/themes/theme-store.js";
import { ThemeSubAccount } from "../src/themes/theme-sub-account.js";
import { ThemeRunner } from "../src/themes/theme-runner.js";
import { ManualListSignalSource } from "../src/themes/sources/manual-list.js";
import type { ThemeStrategy, ThemeContext } from "../src/themes/strategy.js";
import type { ThemeConfig, ThemeEvaluationResult } from "../src/themes/theme.js";

let db: DbClient;

beforeEach(async () => {
  db = await openDatabase({ path: ":memory:" });
});

async function close() {
  await closeDatabase(db);
}

// ── ThemeStore ──────────────────────────────────────────────────

describe("ThemeStore", () => {
  it("creates and retrieves a theme", async () => {
    const store = new ThemeStore(db);
    const theme = await store.create({
      name: "Pelosi Follower",
      strategy: "congress-follower",
      schedule: { type: "interval", milliseconds: 60_000 },
      params: { politician: "Pelosi" },
      allocatedCapital: 10_000,
    });

    expect(theme.id).toBeDefined();
    expect(theme.name).toBe("Pelosi Follower");
    expect(theme.strategy).toBe("congress-follower");
    expect(theme.mode).toBe("sim");
    expect(theme.enabled).toBe(true);
    expect(theme.allocatedCapital).toBe(10_000);
    expect(theme.params).toEqual({ politician: "Pelosi" });

    const fetched = await store.getById(theme.id);
    expect(fetched).toEqual(theme);
  });

  it("lists themes with filter", async () => {
    const store = new ThemeStore(db);
    await store.create({
      name: "Theme A",
      strategy: "congress-follower",
      schedule: { type: "manual" },
    });
    await store.create({
      name: "Theme B",
      strategy: "momentum-rotation",
      schedule: { type: "manual" },
    });
    await store.create({
      name: "Theme C",
      strategy: "congress-follower",
      schedule: { type: "manual" },
      enabled: false,
    });

    const all = await store.list();
    expect(all).toHaveLength(3);

    const congress = await store.list({ strategy: "congress-follower" });
    expect(congress).toHaveLength(2);

    const enabled = await store.list({ enabled: true });
    expect(enabled).toHaveLength(2);

    const disabled = await store.list({ enabled: false });
    expect(disabled).toHaveLength(1);
    expect(disabled[0].name).toBe("Theme C");
  });

  it("updates a theme", async () => {
    const store = new ThemeStore(db);
    const theme = await store.create({
      name: "Test",
      strategy: "test",
      schedule: { type: "manual" },
      allocatedCapital: 5_000,
    });

    const updated = await store.update(theme.id, {
      name: "Updated",
      allocatedCapital: 15_000,
      enabled: false,
    });

    expect(updated).not.toBeNull();
    expect(updated!.name).toBe("Updated");
    expect(updated!.allocatedCapital).toBe(15_000);
    expect(updated!.enabled).toBe(false);
  });

  it("deletes a theme", async () => {
    const store = new ThemeStore(db);
    const theme = await store.create({
      name: "Delete Me",
      strategy: "test",
      schedule: { type: "manual" },
    });

    const deleted = await store.delete(theme.id);
    expect(deleted).toBe(true);

    const fetched = await store.getById(theme.id);
    expect(fetched).toBeNull();
  });

  it("deduplicates signals", async () => {
    const store = new ThemeStore(db);
    const theme = await store.create({
      name: "Dedup Test",
      strategy: "test",
      schedule: { type: "manual" },
    });

    const hash = "pelosi-NVDA-2024-09-12";
    const processed1 = await store.isSignalProcessed(theme.id, hash);
    expect(processed1).toBe(false);

    await store.recordSignal(theme.id, hash, "NVDA", "buy", { source: "bargo" });

    const processed2 = await store.isSignalProcessed(theme.id, hash);
    expect(processed2).toBe(true);
  });

  it("records and lists evaluations", async () => {
    const store = new ThemeStore(db);
    const theme = await store.create({
      name: "Eval Test",
      strategy: "test",
      schedule: { type: "manual" },
    });

    await store.recordEvaluation(theme.id, {
      signalsCount: 3,
      decisionsCount: 2,
      tradesCount: 2,
      errors: [],
    });

    // Small delay to ensure different timestamps
    await new Promise((r) => setTimeout(r, 50));

    await store.recordEvaluation(theme.id, {
      signalsCount: 5,
      decisionsCount: 4,
      tradesCount: 3,
      errors: ["Some error"],
    });

    const evaluations = await store.listEvaluations(theme.id);
    expect(evaluations).toHaveLength(2);
    // Most recent first - find the one with 5 signals
    const latest = evaluations.find((e) => e.signalsCount === 5);
    const oldest = evaluations.find((e) => e.signalsCount === 3);
    expect(latest).toBeDefined();
    expect(oldest).toBeDefined();
    expect(latest!.errors).toEqual(["Some error"]);
    expect(oldest!.errors).toBeNull();
  });
});

// ── ThemeSubAccount ─────────────────────────────────────────────

describe("ThemeSubAccount", () => {
  it("initializes with a starting balance", async () => {
    const themeId = crypto.randomUUID();
    const sub = new ThemeSubAccount(db, themeId, { feeRate: 0.001 });
    await sub.initialize(50_000);

    const balance = await sub.getBalance();
    expect(balance.cash).toBe(50_000);
    expect(balance.equity).toBe(50_000);
    expect(balance.initialCash).toBe(50_000);
    expect(balance.peakEquity).toBe(50_000);
  });

  it("places a buy order and updates position", async () => {
    const themeId = crypto.randomUUID();
    const sub = new ThemeSubAccount(db, themeId, {
      feeRate: 0,
      getCurrentPrice: (sym) => sym === "AAPL" ? 150 : null,
    });
    await sub.initialize(100_000);

    const result = await sub.placeOrder({
      symbol: "AAPL",
      side: "buy",
      quantity: 10,
      orderType: "market",
      clientOrderId: "test-1",
    });

    expect(result.status).toBe("filled");
    expect(result.fillPrice).toBe(150);
    expect(result.realizedPnl).toBe(0);

    const positions = await sub.getPositions();
    expect(positions).toHaveLength(1);
    expect(positions[0].symbol).toBe("AAPL");
    expect(positions[0].quantity).toBe(10);
    expect(positions[0].avgEntryPrice).toBe(150);

    const balance = await sub.getBalance();
    expect(balance.cash).toBe(100_000 - 150 * 10);
  });

  it("places a sell order and realizes P&L", async () => {
    const themeId = crypto.randomUUID();
    // Use a price provider that returns different prices based on a mutable state
    let currentPrice = 150;
    const sub = new ThemeSubAccount(db, themeId, {
      feeRate: 0,
      getCurrentPrice: () => currentPrice,
    });
    await sub.initialize(100_000);

    // Buy at 150
    await sub.placeOrder({
      symbol: "AAPL",
      side: "buy",
      quantity: 10,
      orderType: "market",
    });

    // Price moves to 200
    currentPrice = 200;

    const sellResult = await sub.placeOrder({
      symbol: "AAPL",
      side: "sell",
      quantity: 10,
      orderType: "market",
    });

    expect(sellResult.status).toBe("filled");
    expect(sellResult.fillPrice).toBe(200);
    expect(sellResult.realizedPnl).toBe((200 - 150) * 10);

    const positions = await sub.getPositions();
    expect(positions).toHaveLength(0);

    const balance = await sub.getBalance();
    expect(balance.cash).toBe(100_000 - 150 * 10 + 200 * 10);
  });

  it("rejects buy with insufficient cash", async () => {
    const themeId = crypto.randomUUID();
    const sub = new ThemeSubAccount(db, themeId, {
      feeRate: 0,
      getCurrentPrice: () => 1000,
    });
    await sub.initialize(5_000);

    const result = await sub.placeOrder({
      symbol: "EXPENSIVE",
      side: "buy",
      quantity: 10,
      orderType: "market",
    });

    expect(result.status).toBe("rejected");
    expect(result.error).toContain("Insufficient cash");
  });

  it("rejects sell without position", async () => {
    const themeId = crypto.randomUUID();
    const sub = new ThemeSubAccount(db, themeId, {
      feeRate: 0,
      getCurrentPrice: () => 100,
    });
    await sub.initialize(10_000);

    const result = await sub.placeOrder({
      symbol: "NOPOS",
      side: "sell",
      quantity: 5,
      orderType: "market",
    });

    expect(result.status).toBe("rejected");
    expect(result.error).toContain("Insufficient position");
  });
});

// ── ThemeRunner ─────────────────────────────────────────────────

describe("ThemeRunner", () => {
  // Minimal mock strategy for testing
  const mockStrategy: ThemeStrategy = {
    type: "test-mock",
    async evaluate(ctx: ThemeContext, config: ThemeConfig): Promise<ThemeEvaluationResult> {
      return {
        themeId: config.id,
        timestamp: new Date().toISOString(),
        signals: [{
          symbol: "AAPL",
          action: "buy",
          reason: "test signal",
        }],
        decisions: [],
        trades: [],
        errors: [],
      };
    },
  };

  it("registers and evaluates a strategy", async () => {
    const store = new ThemeStore(db);
    const theme = await store.create({
      name: "Mock Theme",
      strategy: "test-mock",
      schedule: { type: "manual" },
    });

    // Create a minimal ThemeRunner without full service deps
    const runner = new ThemeRunner(db, {
      decisionStore: { create: () => {}, getById: () => null, list: () => [], count: () => 0 } as any,
      tradeEngine: { executeDecision: () => ({}) } as any,
      portfolio: { getSnapshot: () => ({}), getPnL: () => ({}), getPositions: () => [] } as any,
      marketData: { getQuote: () => ({ price: 100 }) } as any,
    });
    runner.registerStrategy(mockStrategy);

    const result = await runner.evaluateOnce(theme.id);
    expect(result.themeId).toBe(theme.id);
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0].symbol).toBe("AAPL");
    expect(result.errors).toHaveLength(0);

    // Check evaluation was recorded
    const evaluations = await store.listEvaluations(theme.id);
    expect(evaluations).toHaveLength(1);
    expect(evaluations[0].signalsCount).toBe(1);
  });

  it("throws for unregistered strategy", async () => {
    const store = new ThemeStore(db);
    const theme = await store.create({
      name: "Unknown Strategy",
      strategy: "nonexistent",
      schedule: { type: "manual" },
    });

    const runner = new ThemeRunner(db, {
      decisionStore: {} as any,
      tradeEngine: {} as any,
      portfolio: {} as any,
      marketData: {} as any,
    });

    await expect(runner.evaluateOnce(theme.id)).rejects.toThrow("Strategy not registered");
  });

  it("gets performance for a theme with sub-account", async () => {
    const store = new ThemeStore(db);
    const theme = await store.create({
      name: "Perf Test",
      strategy: "test-mock",
      schedule: { type: "manual" },
      allocatedCapital: 25_000,
    });

    // Initialize sub-account
    const sub = new ThemeSubAccount(db, theme.id, { feeRate: 0 });
    await sub.initialize(25_000);

    const runner = new ThemeRunner(db, {
      decisionStore: {} as any,
      tradeEngine: {} as any,
      portfolio: {} as any,
      marketData: {} as any,
    });

    const perf = await runner.getPerformance(theme.id);
    expect(perf.themeId).toBe(theme.id);
    expect(perf.name).toBe("Perf Test");
    expect(perf.startingBalance).toBe(25_000);
    expect(perf.currentBalance).toBe(25_000);
    expect(perf.realizedPnl).toBe(0);
    expect(perf.openPositions).toBe(0);
    expect(perf.status).toBe("active");
  });

  it("computes winRate from filled sell orders with realized_pnl", async () => {
    const store = new ThemeStore(db);
    const theme = await store.create({
      name: "WinRate Test",
      strategy: "test-mock",
      schedule: { type: "manual" },
      allocatedCapital: 100_000,
    });

    // Initialize sub-account with a mutable price provider
    let currentPrice = 100;
    const sub = new ThemeSubAccount(db, theme.id, {
      feeRate: 0,
      getCurrentPrice: () => currentPrice,
    });
    await sub.initialize(100_000);

    // Buy at 100, sell at 120 — winning trade
    await sub.placeOrder({ symbol: "WIN", side: "buy", quantity: 10, orderType: "market", clientOrderId: "w1" });
    currentPrice = 120;
    await sub.placeOrder({ symbol: "WIN", side: "sell", quantity: 10, orderType: "market", clientOrderId: "w2" });

    // Buy at 100, sell at 80 — losing trade
    currentPrice = 100;
    await sub.placeOrder({ symbol: "LOSE", side: "buy", quantity: 10, orderType: "market", clientOrderId: "l1" });
    currentPrice = 80;
    await sub.placeOrder({ symbol: "LOSE", side: "sell", quantity: 10, orderType: "market", clientOrderId: "l2" });

    const runner = new ThemeRunner(db, {
      decisionStore: {} as any,
      tradeEngine: {} as any,
      portfolio: {} as any,
      marketData: {} as any,
    });

    const perf = await runner.getPerformance(theme.id);
    expect(perf.totalTrades).toBe(4);
    expect(perf.filledTrades).toBe(4);
    // 1 win out of 2 closed trades = 0.5
    expect(perf.winRate).toBeCloseTo(0.5, 5);
    expect(perf.openPositions).toBe(0);
  });

  it("winRate is 0 when no closed trades exist", async () => {
    const store = new ThemeStore(db);
    const theme = await store.create({
      name: "No Sells Test",
      strategy: "test-mock",
      schedule: { type: "manual" },
      allocatedCapital: 50_000,
    });

    const sub = new ThemeSubAccount(db, theme.id, {
      feeRate: 0,
      getCurrentPrice: () => 100,
    });
    await sub.initialize(50_000);

    // Only buy — no sells, so no closed trades
    await sub.placeOrder({ symbol: "AAPL", side: "buy", quantity: 10, orderType: "market", clientOrderId: "b1" });

    const runner = new ThemeRunner(db, {
      decisionStore: {} as any,
      tradeEngine: {} as any,
      portfolio: {} as any,
      marketData: {} as any,
    });

    const perf = await runner.getPerformance(theme.id);
    expect(perf.winRate).toBe(0);
    expect(perf.totalTrades).toBe(1);
    expect(perf.filledTrades).toBe(1);
    expect(perf.openPositions).toBe(1);
  });
});

// ── ManualListSignalSource ──────────────────────────────────────

describe("ManualListSignalSource", () => {
  it("returns static signals", async () => {
    const source = new ManualListSignalSource([
      { symbol: "AAPL", action: "buy", reason: "long-term hold" },
      { symbol: "NVDA", action: "buy", reason: "AI exposure" },
      { symbol: "TSLA", action: "hold", reason: "volatile" },
    ]);

    const signals = await source.fetchSignals();
    expect(signals).toHaveLength(3);
    expect(signals[0].symbol).toBe("AAPL");
    expect(signals[0].action).toBe("buy");
    expect(signals[1].symbol).toBe("NVDA");
    expect(signals[2].action).toBe("hold");
  });
});