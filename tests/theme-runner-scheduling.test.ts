/**
 * ThemeRunner scheduling tests — src/themes/theme-runner.ts (fleet-ops-b3u).
 *
 * themes.test.ts covers evaluateOnce/getPerformance basics. This file
 * covers the lifecycle: start/stop/startAll, timer scheduling, cron
 * fallback, sub-account initialization, and error paths.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { openDatabase, closeDatabase, type DbClient } from "../src/db/database.js";
import { ThemeRunner } from "../src/themes/theme-runner.js";
import { ThemeStore } from "../src/themes/theme-store.js";
import type { ThemeStrategy, ThemeContext } from "../src/themes/strategy.js";
import type { ThemeConfig, ThemeEvaluationResult } from "../src/themes/theme.js";

const evaluateSpy = vi.fn();

const countingStrategy: ThemeStrategy = {
  type: "counting",
  async evaluate(ctx: ThemeContext, config: ThemeConfig): Promise<ThemeEvaluationResult> {
    evaluateSpy(config.id);
    return {
      themeId: config.id,
      timestamp: new Date().toISOString(),
      signals: [{ symbol: "BTC/USDT", action: "buy", reason: "tick" }],
      decisions: [],
      trades: [],
      errors: [],
    };
  },
};

function makeRunner(db: DbClient) {
  const runner = new ThemeRunner(db, {
    decisionStore: {} as any,
    tradeEngine: {} as any,
    portfolio: {} as any,
    marketData: { getQuote: async () => ({ price: 100 }) } as any,
  });
  runner.registerStrategy(countingStrategy);
  return runner;
}

describe("ThemeRunner scheduling", () => {
  let db: DbClient;
  let store: ThemeStore;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    db = await openDatabase({ path: ":memory:" });
    store = new ThemeStore(db);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await closeDatabase(db);
  });

  it("start throws for an unknown theme", async () => {
    const runner = makeRunner(db);
    await expect(runner.start("nope")).rejects.toThrow("Theme not found: nope");
  });

  it("start throws for a disabled theme", async () => {
    const theme = await store.create({
      name: "Disabled",
      strategy: "counting",
      schedule: { type: "interval", milliseconds: 60_000 },
      enabled: false,
    });
    const runner = makeRunner(db);
    await expect(runner.start(theme.id)).rejects.toThrow("Theme is disabled");
  });

  it("start + interval schedule evaluates on the timer", async () => {
    const theme = await store.create({
      name: "Ticker",
      strategy: "counting",
      schedule: { type: "interval", milliseconds: 10_000 },
    });
    const runner = makeRunner(db);
    await runner.start(theme.id);

    await vi.advanceTimersByTimeAsync(0);
    expect(evaluateSpy).not.toHaveBeenCalled(); // interval doesn't fire immediately

    await vi.advanceTimersByTimeAsync(10_000);
    expect(evaluateSpy).toHaveBeenCalledWith(theme.id);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(evaluateSpy).toHaveBeenCalledTimes(2);

    await runner.stopAll();
  });

  it("cron schedules fall back to a 60s interval and warn", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const theme = await store.create({
      name: "Cron",
      strategy: "counting",
      schedule: { type: "cron", expression: "0 * * * *" },
    });
    const runner = makeRunner(db);
    await runner.start(theme.id);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(evaluateSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("cron scheduling requires"));

    warnSpy.mockRestore();
    await runner.stopAll();
  });

  it("stop clears the timer and marks the theme disabled", async () => {
    const theme = await store.create({
      name: "Stoppable",
      strategy: "counting",
      schedule: { type: "interval", milliseconds: 5_000 },
    });
    const runner = makeRunner(db);
    await runner.start(theme.id);
    await runner.stop(theme.id);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(evaluateSpy).not.toHaveBeenCalled();

    const config = await store.getById(theme.id);
    expect(config?.enabled).toBe(false);
  });

  it("start initializes the sub-account when capital is allocated", async () => {
    const theme = await store.create({
      name: "Funded",
      strategy: "counting",
      schedule: { type: "interval", milliseconds: 60_000 },
      allocatedCapital: 5_000,
    });
    const runner = makeRunner(db);
    await runner.start(theme.id);
    await runner.stopAll();

    const row = await db.get<{ balance: number }>(
      "SELECT balance FROM theme_subaccounts WHERE theme_id = ?",
      [theme.id],
    );
    expect(row).not.toBeNull();
    expect(row?.balance).toBe(5_000);
  });

  it("startAll schedules enabled themes only", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const on = await store.create({
      name: "On",
      strategy: "counting",
      schedule: { type: "interval", milliseconds: 10_000 },
    });
    await store.create({
      name: "Off",
      strategy: "counting",
      schedule: { type: "interval", milliseconds: 10_000 },
      enabled: false,
    });

    const runner = makeRunner(db);
    await runner.startAll();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(evaluateSpy).toHaveBeenCalledTimes(1);
    expect(evaluateSpy).toHaveBeenCalledWith(on.id);

    errSpy.mockRestore();
    await runner.stopAll();
  });

  it("startAll swallows per-theme startup failures", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // allocatedCapital > 0 makes startAll initialize the theme's
    // sub-account; dropping that table makes the INSERT throw inside
    // the startAll loop, which must swallow and log the failure.
    await store.create({
      name: "Broken",
      strategy: "counting",
      schedule: { type: "interval", milliseconds: 10_000 },
      allocatedCapital: 5_000,
    });
    await db.exec("DROP TABLE theme_subaccounts");

    const runner = makeRunner(db);
    await expect(runner.startAll()).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to start theme"),
      expect.anything(),
    );

    errSpy.mockRestore();
    await runner.stopAll();
  });

  it("evaluateOnce records an evaluation even when the strategy throws", async () => {
    const exploding: ThemeStrategy = {
      type: "exploding",
      async evaluate(): Promise<ThemeEvaluationResult> {
        throw new Error("strategy blew up");
      },
    };
    const theme = await store.create({
      name: "Exploding",
      strategy: "exploding",
      schedule: { type: "manual" },
    });
    const runner = makeRunner(db);
    runner.registerStrategy(exploding);

    const result = await runner.evaluateOnce(theme.id);
    expect(result.errors).toHaveLength(1);
    expect(String(result.errors[0])).toContain("strategy blew up");

    const evaluations = await store.listEvaluations(theme.id);
    expect(evaluations).toHaveLength(1);
  });

  it("buildContext exposes working getEquity/getPositions/getQuote helpers", async () => {
    const seen: ThemeContext[] = [];
    const ctxStrategy: ThemeStrategy = {
      type: "ctx-probe",
      async evaluate(ctx: ThemeContext, config: ThemeConfig): Promise<ThemeEvaluationResult> {
        seen.push(ctx);
        const equity = await ctx.getEquity();
        const positions = await ctx.getPositions();
        const price = await ctx.getQuote("BTC/USDT");
        return {
          themeId: config.id,
          timestamp: new Date().toISOString(),
          signals: [
            {
              symbol: "BTC/USDT",
              action: "hold",
              reason: `equity=${equity} positions=${positions.length} price=${price}`,
            },
          ],
          decisions: [],
          trades: [],
          errors: [],
        };
      },
    };

    const theme = await store.create({
      name: "Probe",
      strategy: "ctx-probe",
      schedule: { type: "manual" },
      allocatedCapital: 1_000,
    });
    const runner = makeRunner(db);
    runner.registerStrategy(ctxStrategy);

    // start() initializes the sub-account (evaluateOnce does not)
    await runner.start(theme.id);
    const result = await runner.evaluateOnce(theme.id);
    expect(result.errors).toHaveLength(0);
    expect(result.signals[0].reason).toContain("equity=1000");
    expect(result.signals[0].reason).toContain("positions=0");
    expect(result.signals[0].reason).toContain("price=100");
    expect(seen[0].themeId).toBe(theme.id);
    expect(seen[0].db).toBe(db);
  });
});
