/**
 * Tests for AgentDrivenStrategy and AgentSignalSource.
 *
 * A2A client calls are mocked — we don't hit a real agent in tests.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { openDatabase, type DbClient } from "../src/db/database.js";
import { ThemeStore } from "../src/themes/theme-store.js";
import { ThemeSubAccount } from "../src/themes/theme-sub-account.js";
import { AgentDrivenStrategy } from "../src/themes/strategies/agent-driven.js";
import type { ThemeContext } from "../src/themes/strategy.js";
import type { ThemeConfig } from "../src/themes/theme.js";

let db: DbClient;

beforeEach(async () => {
  db = await openDatabase({ path: ":memory:" });
});

describe("AgentDrivenStrategy", () => {
  function buildContext(themeId: string, getPrice: (s: string) => number = () => 100): ThemeContext {
    return {
      db,
      marketData: { getQuote: async () => ({ price: 100 }) } as any,
      decisionStore: {} as any,
      tradeEngine: {} as any,
      portfolio: {} as any,
      themeId,
      getEquity: async () => 50_000,
      getPositions: async () => [],
      getQuote: async (s: string) => getPrice(s),
    };
  }

  it("returns error when agent params are missing", async () => {
    const strategy = new AgentDrivenStrategy();
    const config: ThemeConfig = {
      id: "test-1",
      name: "Test",
      strategy: "agent-driven",
      mode: "sim",
      schedule: { type: "manual" },
      maxAllocationPct: 5,
      maxTotalAllocationPct: 40,
      maxPositions: 10,
      params: {},
      enabled: true,
      allocatedCapital: 10_000,
    };

    const result = await strategy.evaluate(buildContext("test-1"), config);
    expect(result.errors).toContain("Missing required params: agentEndpoint, agentName");
  });

  it("returns error when sub-account not initialized", async () => {
    const store = new ThemeStore(db);
    const theme = await store.create({
      name: "Agent Theme",
      strategy: "agent-driven",
      schedule: { type: "manual" },
      params: { agentEndpoint: "https://example.com/a2a", agentName: "doom" },
    });

    const strategy = new AgentDrivenStrategy();
    const config = await store.getById(theme.id);
    const result = await strategy.evaluate(buildContext(theme.id), config!);

    expect(result.errors).toContain("Sub-account not initialized");
  });

  it("processes agent signals and places trades", async () => {
    const store = new ThemeStore(db);
    const theme = await store.create({
      name: "Agent Theme",
      strategy: "agent-driven",
      schedule: { type: "manual" },
      params: {
        agentEndpoint: "https://example.com/a2a",
        agentName: "doom",
      },
      allocatedCapital: 50_000,
      maxAllocationPct: 10,
    });

    // Initialize sub-account with a price provider
    const sub = new ThemeSubAccount(db, theme.id, {
      feeRate: 0,
      getCurrentPrice: () => 100,
    });
    await sub.initialize(50_000);

    // Mock the agent-bridge module
    vi.doMock("@cwdcwd/agent-bridge", () => ({
      A2AClient: class {
        constructor() {}
        async sendMessage() {
          return JSON.stringify([
            { symbol: "AAPL", action: "buy", reason: "Strong fundamentals", quantity: 50 },
            { symbol: "NVDA", action: "buy", reason: "AI growth", quantity: 30 },
            { symbol: "TSLA", action: "hold", reason: "Volatile" },
          ]);
        }
      },
    }));

    const strategy = new AgentDrivenStrategy();
    const config = await store.getById(theme.id);

    const ctx: ThemeContext = {
      db,
      marketData: { getQuote: async () => ({ price: 100 }) } as any,
      decisionStore: {} as any,
      tradeEngine: {} as any,
      portfolio: {} as any,
      themeId: theme.id,
      getEquity: async () => {
        const bal = await sub.getBalance();
        return bal.equity;
      },
      getPositions: async () => sub.getPositions(),
      getQuote: async () => 100,
    };

    const result = await strategy.evaluate(ctx, config!);

    // Should have 3 signals (including hold), 2 trades (buys only)
    expect(result.signals).toHaveLength(3);
    expect(result.trades).toHaveLength(2);
    expect(result.trades[0].status).toBe("filled");
    expect(result.errors).toHaveLength(0);

    vi.doUnmock("@cwdcwd/agent-bridge");
  });

  it("handles agent response parsing failure gracefully", async () => {
    const store = new ThemeStore(db);
    const theme = await store.create({
      name: "Agent Theme",
      strategy: "agent-driven",
      schedule: { type: "manual" },
      params: {
        agentEndpoint: "https://example.com/a2a",
        agentName: "doom",
      },
      allocatedCapital: 50_000,
    });

    const sub = new ThemeSubAccount(db, theme.id, { feeRate: 0, getCurrentPrice: () => 100 });
    await sub.initialize(50_000);

    vi.doMock("@cwdcwd/agent-bridge", () => ({
      A2AClient: class {
        constructor() {}
        async sendMessage() {
          return "Sorry, I don't understand the request.";
        }
      },
    }));

    const strategy = new AgentDrivenStrategy();
    const config = await store.getById(theme.id);

    const ctx: ThemeContext = {
      db,
      marketData: {} as any,
      decisionStore: {} as any,
      tradeEngine: {} as any,
      portfolio: {} as any,
      themeId: theme.id,
      getEquity: async () => 50_000,
      getPositions: async () => [],
      getQuote: async () => 100,
    };

    const result = await strategy.evaluate(ctx, config!);

    expect(result.signals).toHaveLength(0);
    // After fix #39, parse errors are surfaced (not silently swallowed)
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toMatch(/Agent signal fetch failed.*Failed to parse agent response/);

    vi.doUnmock("@cwdcwd/agent-bridge");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("@cwdcwd/agent-bridge");
  });
});