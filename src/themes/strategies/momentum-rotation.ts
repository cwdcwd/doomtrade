/**
 * MomentumRotation — screens a symbol universe on a schedule, buys the
 * top N momentum symbols, and sells positions that drop out of the top set.
 * Equal-weight allocation across the portfolio.
 *
 * Strategy params (from ThemeConfig.params):
 * - universe:      string[]        — symbols to screen (required)
 * - topN:           number          — max positions to hold (default 5)
 * - timeframe:      Timeframe       — bar timeframe (default "1Day")
 * - range:          string          — lookback range (default "6m")
 * - method:         MomentumMethod  — scoring method (default "combined")
 * - rebalanceOnly:  boolean         — if true, only trade on rebalance cycles
 *                                     (skip ticks where portfolio is balanced)
 */

import type { ThemeStrategy, ThemeContext } from "../strategy.js";
import type { ThemeConfig, ThemeEvaluationResult, ThemeSignal } from "../theme.js";
import type { Decision } from "../../decision/decision.js";
import type { TradeRecord } from "../../engine/trade-engine.js";
import type { Position } from "../../executor/executor.js";
import { MomentumScreenSignalSource, type MomentumMethod } from "../sources/momentum-screen.js";
import { ResearchService } from "../../research/research.js";
import { createHash } from "node:crypto";

interface MomentumRotationParams {
  universe: string[];
  topN: number;
  timeframe?: "1Min" | "5Min" | "15Min" | "1Hour" | "1Day";
  range?: string;
  method?: MomentumMethod;
  rebalanceOnly?: boolean;
}

function parseParams(config: ThemeConfig): MomentumRotationParams {
  const p = config.params;
  const universe = Array.isArray(p.universe) ? p.universe : [];
  if (universe.length === 0) {
    throw new Error("MomentumRotation requires params.universe (string[])");
  }
  return {
    universe,
    topN: typeof p.topN === "number" && p.topN > 0 ? p.topN : 5,
    timeframe: p.timeframe as MomentumRotationParams["timeframe"] | undefined,
    range: typeof p.range === "string" ? p.range : undefined,
    method: p.method as MomentumMethod | undefined,
    rebalanceOnly: typeof p.rebalanceOnly === "boolean" ? p.rebalanceOnly : false,
  };
}

export class MomentumRotationStrategy implements ThemeStrategy {
  readonly type = "momentum-rotation";

  async evaluate(
    ctx: ThemeContext,
    config: ThemeConfig,
  ): Promise<ThemeEvaluationResult> {
    const timestamp = new Date().toISOString();
    const errors: string[] = [];
    const signals: ThemeSignal[] = [];
    const decisions: Decision[] = [];
    const trades: TradeRecord[] = [];

    try {
      const params = parseParams(config);

      // Build the screen source from the context's market data service
      const research = new ResearchService(ctx.marketData);
      const screen = new MomentumScreenSignalSource(research, {
        universe: params.universe,
        timeframe: params.timeframe,
        range: params.range,
        method: params.method,
      });

      // Screen the universe
      const allSignals = await screen.fetchSignals();
      signals.push(...allSignals);

      // Determine target portfolio: top N buy signals
      const buySignals = allSignals.filter((s) => s.action === "buy");
      const targetSymbols = new Set(buySignals.slice(0, params.topN).map((s) => s.symbol));

      // Get current positions
      let currentPositions: Position[] = [];
      try {
        currentPositions = await ctx.getPositions();
      } catch {
        // Sub-account may not be initialized — treat as empty
      }

      const heldSymbols = new Set(currentPositions.map((p) => p.symbol));

      // Symbols to sell: held but not in target set
      const toSell = currentPositions.filter((p) => !targetSymbols.has(p.symbol));

      // Symbols to buy: in target set but not currently held
      const toBuy = buySignals.filter((s) => !heldSymbols.has(s.symbol));

      // If rebalanceOnly and no changes needed, skip
      if (params.rebalanceOnly && toSell.length === 0 && toBuy.length === 0) {
        return {
          themeId: ctx.themeId,
          timestamp,
          signals,
          decisions: [],
          trades: [],
          errors,
        };
      }

      // Compute equal-weight allocation for new buys
      const equity = await ctx.getEquity();
      const perPositionAllocation = equity > 0 ? equity / params.topN : 0;

      // Execute sells first (free up capital)
      for (const pos of toSell) {
        try {
          const price = await ctx.getQuote(pos.symbol);
          const decision = await ctx.decisionStore.create({
            agent: "doom",
            symbol: pos.symbol,
            action: "sell",
            quantity: pos.quantity,
            priceAtDecision: price,
            rationale: `Momentum rotation: ${pos.symbol} dropped out of top ${params.topN} momentum screen`,
            confidence: 5,
            mode: config.mode,
            marketContext: {
              indicators: { strategy: "momentum-rotation", action: "rotate-out" },
            },
          });
          decisions.push(decision);

          const result = await ctx.tradeEngine.executeDecision({ decision });
          if (result.tradeRecord) trades.push(result.tradeRecord);
          if (!result.riskPassed && result.riskChecks) {
            errors.push(
              `Sell ${pos.symbol} risk check failed: ${result.riskChecks.map((r) => r.reason).join("; ")}`,
            );
          }
        } catch (err) {
          errors.push(
            `Failed to sell ${pos.symbol}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      // Execute buys
      for (const signal of toBuy) {
        try {
          const price = signal.priceAtSignal ?? (await ctx.getQuote(signal.symbol));
          if (price <= 0 || perPositionAllocation <= 0) continue;

          const quantity = perPositionAllocation / price;
          if (quantity <= 0) continue;

          // Signal dedup — avoid duplicate entries
          const signalHash = createHash("sha256")
            .update(`${ctx.themeId}:${signal.symbol}:${timestamp.slice(0, 10)}`)
            .digest("hex")
            .slice(0, 16);

          const decision = await ctx.decisionStore.create({
            agent: "doom",
            symbol: signal.symbol,
            action: "buy",
            quantity: Math.floor(quantity * 100) / 100, // truncate to 2 decimals
            priceAtDecision: price,
            rationale: `Momentum rotation: ${signal.symbol} entered top ${params.topN}. ${signal.reason}`,
            confidence: 6,
            mode: config.mode,
            marketContext: {
              indicators: signal.metadata,
              notes: `Momentum screen ${params.method ?? "combined"}`,
            },
          });
          decisions.push(decision);

          const result = await ctx.tradeEngine.executeDecision({ decision });
          if (result.tradeRecord) trades.push(result.tradeRecord);
          if (!result.riskPassed && result.riskChecks) {
            errors.push(
              `Buy ${signal.symbol} risk check failed: ${result.riskChecks.map((r) => r.reason).join("; ")}`,
            );
          }
        } catch (err) {
          errors.push(
            `Failed to buy ${signal.symbol}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }

    return {
      themeId: ctx.themeId,
      timestamp,
      signals,
      decisions,
      trades,
      errors,
    };
  }
}