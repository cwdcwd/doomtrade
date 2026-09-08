/**
 * MomentumRotationStrategy — rotational momentum theme strategy.
 *
 * Screens a universe of symbols for momentum signals using technical
 * indicators (SMA crossover, RSI, or combined), selects the top N symbols
 * with buy signals, equal-weights across them, and rotates out of
 * positions that have dropped from the top set.
 *
 * Strategy type: "momentum-rotation"
 *
 * Required params:
 * - universe: string[] — symbols to screen
 * - indicator: IndicatorConfig — indicator type and parameters
 *
 * Optional params:
 * - topN: number — how many top buy-signal symbols to hold (default 5)
 * - timeframe: Timeframe — bar timeframe (default "1Day")
 * - range: string — bar range (default "6m")
 */

import { randomUUID } from "node:crypto";
import type { ThemeStrategy, ThemeContext } from "../strategy.js";
import type { ThemeConfig, ThemeEvaluationResult, ThemeSignal } from "../theme.js";
import type { MarketDataService, Bar, Timeframe } from "../../market/market.js";
import { smaCrossover, rsiSignal, type Signal } from "../../research/indicators.js";
import { ThemeSubAccount } from "../theme-sub-account.js";
import { ThemeStore } from "../theme-store.js";
import { isWithinAllocationLimit } from "../allocation-check.js";
import { errorMessage } from "../../util/error.js";

// ── Config types (mirrors momentum-screen.ts for self-containment) ──

export type IndicatorType = "sma-crossover" | "rsi" | "combined";

export interface SmaCrossoverConfig {
  type: "sma-crossover";
  periods: { fast: number; slow: number };
}

export interface RsiConfig {
  type: "rsi";
  period: number;
  oversold?: number;
  overbought?: number;
}

export interface CombinedConfig {
  type: "combined";
  periods: { fast: number; slow: number };
  rsiPeriod: number;
  oversold?: number;
  overbought?: number;
}

export type IndicatorConfig = SmaCrossoverConfig | RsiConfig | CombinedConfig;

export interface MomentumRotationParams {
  universe: string[];
  indicator: IndicatorConfig;
  topN?: number;
  timeframe?: Timeframe;
  range?: string;
}

// ── Strategy implementation ─────────────────────────────────────

export class MomentumRotationStrategy implements ThemeStrategy {
  readonly type = "momentum-rotation";

  async evaluate(ctx: ThemeContext, config: ThemeConfig): Promise<ThemeEvaluationResult> {
    const timestamp = new Date().toISOString();
    const errors: string[] = [];
    const params = config.params as unknown as MomentumRotationParams;

    // ── Validate params ───────────────────────────────────────
    if (!params.universe || !Array.isArray(params.universe) || params.universe.length === 0) {
      return {
        themeId: config.id,
        timestamp,
        signals: [],
        decisions: [],
        trades: [],
        errors: [],
      };
    }

    if (!params.indicator || !params.indicator.type) {
      return {
        themeId: config.id,
        timestamp,
        signals: [],
        decisions: [],
        trades: [],
        errors: ["Missing required param: indicator"],
      };
    }

    const topN = params.topN ?? 5;
    const timeframe = params.timeframe ?? "1Day";
    const range = params.range ?? "6m";

    // ── Screen the universe: compute signals for each symbol ──
    const signals = await this.screenUniverse(
      ctx.marketData,
      params.universe,
      params.indicator,
      timeframe,
      range,
      errors,
    );

    // ── Select top N symbols with buy signals ──────────────────
    const buySignals = signals.filter((s) => s.action === "buy");
    const selected = buySignals.slice(0, topN);
    const selectedSymbols = new Set(selected.map((s) => s.symbol));

    // ── Set up sub-account for order execution ──────────────────
    // Use ctx.exchange (AgentExchange) when provided by the agent pipeline,
    // otherwise fall back to a ThemeSubAccount (theme runner).
    const subAccount =
      ctx.exchange ??
      new ThemeSubAccount(ctx.db, config.id, {
        getCurrentPrice: () => null,
      });

    // Get current equity for allocation
    let equity = 0;
    try {
      const balance = await subAccount.getBalance();
      equity = balance.equity;
    } catch {
      errors.push("Sub-account not initialized — no capital allocated");
      return {
        themeId: config.id,
        timestamp,
        signals,
        decisions: [],
        trades: [],
        errors,
      };
    }

    // ── Get current positions ─────────────────────────────────
    let positions: { symbol: string; quantity: number; avgEntryPrice: number }[];
    try {
      positions = await subAccount.getPositions();
    } catch {
      positions = [];
    }

    const trades: ThemeEvaluationResult["trades"] = [];

    // ── Sell positions that dropped out of the top N ───────────
    for (const pos of positions) {
      if (pos.quantity > 0 && !selectedSymbols.has(pos.symbol)) {
        const sellPrice = await this.getPrice(ctx, pos.symbol);
        if (sellPrice <= 0) {
          errors.push(`No price for ${pos.symbol} — cannot sell`);
          continue;
        }

        // Build a sell signal for the dropped position
        const sellSignal: ThemeSignal = {
          symbol: pos.symbol,
          action: "sell",
          priceAtSignal: sellPrice,
          reason: `Rotating out of ${pos.symbol} — no longer in top ${topN}`,
        };

        // Dedup check
        const signalHash = this.hashSignal(config.id, pos.symbol, "sell", "rotation");
        const processed = await this.isSignalProcessed(ctx, config.id, signalHash);
        if (processed) continue;

        try {
          const result = await subAccount.placeOrder({
            symbol: pos.symbol,
            side: "sell",
            quantity: pos.quantity,
            orderType: "limit",
            limitPrice: sellPrice,
            clientOrderId: randomUUID(),
          });

          if (result.status === "filled") {
            trades.push(result as any);
            signals.push(sellSignal);
            await this.recordSignal(ctx, config.id, signalHash, pos.symbol, "sell");
          } else if (result.status === "rejected") {
            errors.push(`Sell rejected for ${pos.symbol}: ${result.error}`);
          }
        } catch (err) {
          errors.push(`Sell failed for ${pos.symbol}: ${errorMessage(err)}`);
        }
      }
    }

    // ── Buy new positions (equal-weight allocation) ────────────
    if (selected.length > 0 && equity > 0) {
      const perSymbolBudget = equity / selected.length;
      const maxAllocation = equity * (config.maxAllocationPct / 100);
      const budget = Math.min(perSymbolBudget, maxAllocation);

      for (const signal of selected) {
        const price = signal.priceAtSignal ?? 0;
        if (price <= 0) {
          errors.push(`No price for ${signal.symbol} — skipping buy`);
          continue;
        }

        // Check if we already hold this position
        const existingPos = positions.find((p) => p.symbol === signal.symbol);
        if (existingPos && existingPos.quantity > 0) {
          // Already holding — skip
          continue;
        }

        // Check max positions
        const currentPositions = await subAccount.getPositions();
        if (currentPositions.length >= config.maxPositions) {
          errors.push(`Max positions reached — skipping ${signal.symbol}`);
          continue;
        }

        const qty = budget / price;
        if (qty <= 0) {
          errors.push(`Insufficient allocation for ${signal.symbol} at $${price}`);
          continue;
        }

        // Enforce maxTotalAllocationPct (fixes #37)
        const buyValue = qty * price;
        const allocPositions = await subAccount.getPositions();
        const allocCheck = isWithinAllocationLimit(
          allocPositions,
          equity,
          config.maxTotalAllocationPct,
          config.maxAllocationPct,
          buyValue,
        );
        if (!allocCheck.allowed) {
          errors.push(`Allocation limit for ${signal.symbol}: ${allocCheck.reason}`);
          continue;
        }

        // Dedup
        const signalHash = this.hashSignal(config.id, signal.symbol, "buy", "rotation");
        const processed = await this.isSignalProcessed(ctx, config.id, signalHash);
        if (processed) continue;

        try {
          const result = await subAccount.placeOrder({
            symbol: signal.symbol,
            side: "buy",
            quantity: qty,
            orderType: "limit",
            limitPrice: price,
            clientOrderId: randomUUID(),
          });

          if (result.status === "filled") {
            trades.push(result as any);
            await this.recordSignal(ctx, config.id, signalHash, signal.symbol, "buy");
          } else if (result.status === "rejected") {
            errors.push(`Buy rejected for ${signal.symbol}: ${result.error}`);
          }
        } catch (err) {
          errors.push(`Buy failed for ${signal.symbol}: ${errorMessage(err)}`);
        }
      }
    }

    return {
      themeId: config.id,
      timestamp,
      signals,
      decisions: [],
      trades,
      errors,
    };
  }

  // ── Private helpers ─────────────────────────────────────────

  /**
   * Screen the universe of symbols and return ThemeSignals for each
   * symbol that has an actionable signal (buy/sell). Neutral signals
   * are omitted.
   */
  private async screenUniverse(
    marketData: MarketDataService,
    universe: string[],
    indicator: IndicatorConfig,
    timeframe: Timeframe,
    range: string,
    errors: string[],
  ): Promise<ThemeSignal[]> {
    const signals: ThemeSignal[] = [];

    for (const symbol of universe) {
      try {
        const bars = await marketData.getBars(symbol, timeframe, range);
        if (bars.length === 0) continue;

        const closes = bars.map((b: Bar) => b.close);
        const lastPrice = closes[closes.length - 1];

        let action: "buy" | "sell" | "hold";
        let reason: string;
        let metadata: Record<string, unknown>;

        if (indicator.type === "sma-crossover") {
          const { fast, slow } = indicator.periods;
          const sig = smaCrossover(closes, fast, slow);
          if (sig === "neutral") continue;
          action = sig;
          reason = `SMA(${fast}/${slow}) ${sig === "buy" ? "golden cross" : "death cross"}`;
          metadata = { indicator: "sma-crossover", signal: sig };
        } else if (indicator.type === "rsi") {
          const sig = rsiSignal(
            closes,
            indicator.period,
            indicator.oversold ?? 30,
            indicator.overbought ?? 70,
          );
          if (sig === "neutral") continue;
          action = sig;
          reason = `RSI(${indicator.period}) ${sig === "buy" ? "oversold" : "overbought"}`;
          metadata = { indicator: "rsi", signal: sig };
        } else {
          // combined
          const { fast, slow } = indicator.periods;
          const smaSig = smaCrossover(closes, fast, slow);
          const rsiSig = rsiSignal(
            closes,
            indicator.rsiPeriod,
            indicator.oversold ?? 30,
            indicator.overbought ?? 70,
          );

          if (smaSig === "buy" && rsiSig === "buy") {
            action = "buy";
            reason = `Combined: SMA golden cross + RSI oversold`;
          } else if (smaSig === "sell" && rsiSig === "sell") {
            action = "sell";
            reason = `Combined: SMA death cross + RSI overbought`;
          } else {
            // Disagreement — hold, not actionable for rotation
            continue;
          }
          metadata = { indicator: "combined", smaSignal: smaSig, rsiSignal: rsiSig };
        }

        signals.push({
          symbol,
          action,
          priceAtSignal: lastPrice,
          reason,
          metadata,
        });
      } catch (err) {
        errors.push(`Failed to screen ${symbol}: ${errorMessage(err)}`);
        continue;
      }
    }

    return signals;
  }

  /**
   * Get the current price for a symbol — tries marketData.getQuote first.
   */
  private async getPrice(ctx: ThemeContext, symbol: string): Promise<number> {
    try {
      const quote = await ctx.marketData.getQuote(symbol);
      return quote.price;
    } catch {
      // Fall back to context's getQuote
      try {
        return await ctx.getQuote(symbol);
      } catch {
        return 0;
      }
    }
  }

  /**
   * Generate a deterministic signal hash for dedup.
   */
  private hashSignal(themeId: string, symbol: string, action: string, prefix: string): string {
    return `${prefix}-${symbol}-${action}`;
  }

  /**
   * Check if a signal has already been processed (dedup).
   * Uses ThemeStore which handles placeholder conversion (fixes #34).
   */
  private async isSignalProcessed(
    ctx: ThemeContext,
    themeId: string,
    signalHash: string,
  ): Promise<boolean> {
    const store = new ThemeStore(ctx.db);
    return store.isSignalProcessed(themeId, signalHash);
  }

  /**
   * Record a processed signal for dedup.
   * Uses ThemeStore which handles placeholder conversion (fixes #34).
   */
  private async recordSignal(
    ctx: ThemeContext,
    themeId: string,
    signalHash: string,
    symbol: string,
    action: string,
  ): Promise<void> {
    const store = new ThemeStore(ctx.db);
    await store.recordSignal(themeId, signalHash, symbol, action);
  }
}
