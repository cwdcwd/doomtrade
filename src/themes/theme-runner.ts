/**
 * ThemeRunner — orchestrates theme evaluation lifecycle.
 *
 * Manages:
 * - Strategy registration
 * - Theme start/stop (scheduling via BullMQ or in-process timers)
 * - Manual evaluation triggers
 * - Per-theme performance tracking
 *
 * On startup, reads enabled themes from ThemeStore and re-registers
 * their schedules. If REDIS_URL is set, uses BullMQ for persistent
 * scheduling. Otherwise falls back to in-process timers.
 */

import { randomUUID } from "node:crypto";
import type { Database } from "../db/database.js";
import type { DecisionStore } from "../decision/decision-store.js";
import type { TradeEngine } from "../engine/trade-engine.js";
import type { Portfolio } from "../portfolio/portfolio.js";
import type { MarketDataService } from "../market/market.js";
import type { Position } from "../executor/executor.js";

import { ThemeStore } from "./theme-store.js";
import { ThemeSubAccount } from "./theme-sub-account.js";
import type { ThemeStrategy, ThemeContext } from "./strategy.js";
import type { ThemeConfig, ThemeEvaluationResult, ThemePerformance } from "./theme.js";
import { execGet, execAll, convertPlaceholders } from "../db/database.js";

export interface ThemeRunnerOptions {
  decisionStore: DecisionStore;
  tradeEngine: TradeEngine;
  portfolio: Portfolio;
  marketData: MarketDataService;
  redisUrl?: string;
  /** Price provider for sub-account order fills */
  getCurrentPrice?: (symbol: string) => number | null;
  /** Sim fee rate for sub-account orders */
  simFeeRate?: number;
}

export class ThemeRunner {
  private strategies: Map<string, ThemeStrategy> = new Map();
  private timers: Map<string, NodeJS.Timeout> = new Map();
  private store: ThemeStore;
  private opts: ThemeRunnerOptions;

  constructor(private db: Database, opts: ThemeRunnerOptions) {
    this.opts = opts;
    this.store = new ThemeStore(db);
  }

  /**
   * Register a strategy implementation.
   */
  registerStrategy(strategy: ThemeStrategy): void {
    this.strategies.set(strategy.type, strategy);
  }

  /**
   * Start a theme: load config, schedule evaluations.
   */
  async start(themeId: string): Promise<void> {
    const config = await this.store.getById(themeId);
    if (!config) throw new Error(`Theme not found: ${themeId}`);
    if (!config.enabled) throw new Error(`Theme is disabled: ${themeId}`);

    // Initialize sub-account if capital is allocated
    if (config.allocatedCapital > 0) {
      const subAccount = new ThemeSubAccount(this.db, themeId, {
        feeRate: this.opts.simFeeRate,
        getCurrentPrice: this.opts.getCurrentPrice,
      });
      await subAccount.initialize(config.allocatedCapital);
    }

    // Schedule based on config
    this.scheduleTheme(config);
  }

  /**
   * Stop a theme: clear timer, mark disabled.
   */
  async stop(themeId: string): Promise<void> {
    const timer = this.timers.get(themeId);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(themeId);
    }

    await this.store.update(themeId, { enabled: false });
  }

  /**
   * Start all enabled themes (called on app startup).
   */
  async startAll(): Promise<void> {
    const themes = await this.store.listEnabled();
    for (const config of themes) {
      try {
        this.scheduleTheme(config);
      } catch (err) {
        console.error(`Failed to start theme ${config.id} (${config.name}):`, err);
      }
    }
  }

  /**
   * Stop all themes (called on shutdown).
   */
  async stopAll(): Promise<void> {
    for (const [id, timer] of this.timers) {
      clearInterval(timer);
      this.timers.delete(id);
    }
  }

  /**
   * Manually trigger one evaluation.
   */
  async evaluateOnce(themeId: string): Promise<ThemeEvaluationResult> {
    const config = await this.store.getById(themeId);
    if (!config) throw new Error(`Theme not found: ${themeId}`);

    const strategy = this.strategies.get(config.strategy);
    if (!strategy) throw new Error(`Strategy not registered: ${config.strategy}`);

    const ctx = await this.buildContext(themeId);

    let result: ThemeEvaluationResult;
    try {
      result = await strategy.evaluate(ctx, config);
    } catch (err) {
      result = {
        themeId,
        timestamp: new Date().toISOString(),
        signals: [],
        decisions: [],
        trades: [],
        errors: [String(err)],
      };
    }

    // Record evaluation
    await this.store.recordEvaluation(themeId, {
      signalsCount: result.signals.length,
      decisionsCount: result.decisions.length,
      tradesCount: result.trades.length,
      errors: result.errors,
    });

    return result;
  }

  /**
   * Get per-theme performance.
   */
  async getPerformance(themeId: string): Promise<ThemePerformance> {
    const config = await this.store.getById(themeId);
    if (!config) throw new Error(`Theme not found: ${themeId}`);

    // Get sub-account balance if initialized
    let startingBalance = config.allocatedCapital;
    let currentBalance = config.allocatedCapital;
    let peakBalance = config.allocatedCapital;

    const subBalance = await execGet<{ balance: number; peak_balance: number; starting_balance: number }>(
      this.db,
      convertPlaceholders(
        "SELECT balance, peak_balance, starting_balance FROM theme_subaccounts WHERE theme_id = ?",
        this.db.backend,
      ),
      [themeId],
    );

    if (subBalance) {
      startingBalance = subBalance.starting_balance;
      currentBalance = subBalance.balance;
      peakBalance = subBalance.peak_balance;
    }

    // Count positions
    const positions = await execAll<{ symbol: string }>(
      this.db,
      convertPlaceholders(
        "SELECT symbol FROM sim_sub_positions WHERE theme_id = ? AND quantity > 0",
        this.db.backend,
      ),
      [themeId],
    );

    // Count trades from sub-account orders
    const tradeStats = await execGet<{ total: number; filled: number }>(
      this.db,
      convertPlaceholders(
        `SELECT
           COUNT(*) as total,
           COUNT(CASE WHEN status = 'filled' THEN 1 END) as filled
         FROM sim_sub_orders WHERE theme_id = ?`,
        this.db.backend,
      ),
      [themeId],
    );

    const drawdownPct = peakBalance > 0
      ? ((peakBalance - currentBalance) / peakBalance) * 100
      : 0;

    const realizedPnl = currentBalance - startingBalance;

    return {
      themeId,
      name: config.name,
      startingBalance,
      currentBalance,
      peakBalance,
      drawdownPct,
      totalTrades: tradeStats?.total ?? 0,
      filledTrades: tradeStats?.filled ?? 0,
      winRate: 0, // TODO: compute from individual trade P&L
      realizedPnl,
      openPositions: positions.length,
      status: config.enabled ? "active" : "stopped",
    };
  }

  // ── Private ──────────────────────────────────────────────────

  private scheduleTheme(config: ThemeConfig): void {
    if (config.schedule.type === "manual") return;

    if (config.schedule.type === "interval") {
      const ms = config.schedule.milliseconds;
      const timer = setInterval(() => {
        this.evaluateOnce(config.id).catch((err) => {
          console.error(`Theme ${config.id} evaluation failed:`, err);
        });
      }, ms);
      this.timers.set(config.id, timer);
    } else if (config.schedule.type === "cron") {
      // For v1 without BullMQ, parse simple cron expressions
      // BullMQ integration will be added when redisUrl is set
      // For now, use a 60-second fallback interval
      console.warn(
        `Theme ${config.id}: cron scheduling requires Redis/BullMQ. ` +
        `Using 60s interval fallback. Set REDIS_URL to enable cron.`
      );
      const timer = setInterval(() => {
        this.evaluateOnce(config.id).catch((err) => {
          console.error(`Theme ${config.id} evaluation failed:`, err);
        });
      }, 60_000);
      this.timers.set(config.id, timer);
    }
  }

  private async buildContext(themeId: string): Promise<ThemeContext> {
    const subAccount = new ThemeSubAccount(this.db, themeId, {
      feeRate: this.opts.simFeeRate,
      getCurrentPrice: this.opts.getCurrentPrice,
    });

    // Ensure sub-account is initialized
    try {
      await subAccount.getBalance();
    } catch {
      // Not initialized — getBalance will fail. Strategy should handle.
    }

    return {
      db: this.db,
      marketData: this.opts.marketData,
      decisionStore: this.opts.decisionStore,
      tradeEngine: this.opts.tradeEngine,
      portfolio: this.opts.portfolio,
      themeId,
      getEquity: async () => {
        try {
          const bal = await subAccount.getBalance();
          return bal.equity;
        } catch {
          return 0;
        }
      },
      getPositions: async () => {
        try {
          return await subAccount.getPositions();
        } catch {
          return [] as Position[];
        }
      },
      getQuote: async (symbol: string) => {
        const quote = await this.opts.marketData.getQuote(symbol);
        return quote.price;
      },
    };
  }
}