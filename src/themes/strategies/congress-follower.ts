/**
 * CongressFollower strategy — mirrors trades made by a specific politician.
 *
 * Fetches congressional trade disclosures via the Bargo API, deduplicates
 * against previously processed signals, allocates from the theme's
 * sub-account, creates Decisions, and executes trades.
 *
 * Strategy type: "congress-follower"
 *
 * Required params:
 * - politician: name of the politician to follow (partial match)
 *
 * Optional params:
 * - mirrorAction: "buys-only" (default) or "all"
 * - apiKey: Bargo API key (optional, raises rate limits)
 */

import { randomUUID } from "node:crypto";
import type { ThemeStrategy, ThemeContext } from "../strategy.js";
import type { ThemeConfig, ThemeEvaluationResult, ThemeSignal } from "../theme.js";
import { CongressTradesSignalSource } from "../sources/congress-trades.js";
import { ThemeSubAccount } from "../theme-sub-account.js";
import { ThemeStore } from "../theme-store.js";
import { isWithinAllocationLimit } from "../allocation-check.js";

interface CongressFollowerParams {
  politician: string;
  mirrorAction?: "buys-only" | "all";
  apiKey?: string;
}

export class CongressFollowerStrategy implements ThemeStrategy {
  readonly type = "congress-follower";

  async evaluate(
    ctx: ThemeContext,
    config: ThemeConfig,
  ): Promise<ThemeEvaluationResult> {
    const params = config.params as unknown as CongressFollowerParams;
    const timestamp = new Date().toISOString();
    const errors: string[] = [];

    if (!params.politician) {
      return {
        themeId: config.id,
        timestamp,
        signals: [],
        decisions: [],
        trades: [],
        errors: ["Missing required param: politician"],
      };
    }

    // Fetch signals from Bargo API
    const source = new CongressTradesSignalSource({
      member: params.politician,
      type: params.mirrorAction === "all" ? undefined : "purchase",
      apiKey: params.apiKey,
      limit: 50,
    });

    let signals: ThemeSignal[];
    try {
      signals = await source.fetchSignals();
    } catch (err) {
      return {
        themeId: config.id,
        timestamp,
        signals: [],
        decisions: [],
        trades: [],
        errors: [`Failed to fetch signals: ${(err as Error).message}`],
      };
    }

    // Deduplicate: filter out signals already processed (fixes #34)
    const store = new ThemeStore(ctx.db);
    const newSignals: ThemeSignal[] = [];
    for (const signal of signals) {
      const meta = signal.metadata as Record<string, unknown>;
      const signalHash = `${meta.member_slug}-${signal.symbol}-${meta.transaction_date}-${signal.action}`;
      const processed = await store.isSignalProcessed(config.id, signalHash);
      if (!processed) {
        newSignals.push(signal);
      }
    }

    if (newSignals.length === 0) {
      return {
        themeId: config.id,
        timestamp,
        signals: [],
        decisions: [],
        trades: [],
        errors: [],
      };
    }

    // Get sub-account for execution — use context's getQuote for price resolution
    const subAccount = new ThemeSubAccount(ctx.db, config.id, {
      getCurrentPrice: (symbol: string) => {
        // Synchronous fallback — will be overridden by async price in placeOrder
        // if the order has a limitPrice. For market orders, we use priceAtSignal.
        return null;
      },
    });

    // Get current equity for allocation
    let equity = 0;
    try {
      const balance = await subAccount.getBalance();
      equity = balance.equity;
    } catch {
      // Sub-account not initialized
      errors.push("Sub-account not initialized — no capital allocated");
      return {
        themeId: config.id,
        timestamp,
        signals: newSignals,
        decisions: [],
        trades: [],
        errors,
      };
    }

    // Process each signal
    const decisions: ThemeEvaluationResult["decisions"] = [];
    const trades: ThemeEvaluationResult["trades"] = [];

    for (const signal of newSignals) {
      if (signal.action === "hold") continue;

      // Calculate allocation: maxAllocationPct of equity
      const maxAllocation = equity * (config.maxAllocationPct / 100);
      const price = signal.priceAtSignal ?? 0;
      if (price <= 0) {
        errors.push(`No price for ${signal.symbol} — skipping`);
        continue;
      }

      const qty = maxAllocation / price;
      if (qty <= 0) {
        errors.push(`Insufficient allocation for ${signal.symbol} at $${price}`);
        continue;
      }

      // Check max positions
      const positions = await subAccount.getPositions();
      const hasPosition = positions.some((p) => p.symbol === signal.symbol);
      if (!hasPosition && positions.length >= config.maxPositions) {
        errors.push(`Max positions reached — skipping ${signal.symbol}`);
        continue;
      }

      // Enforce maxTotalAllocationPct (fixes #37)
      if (signal.action === "buy") {
        const buyValue = qty * price;
        const check = isWithinAllocationLimit(
          positions, equity, config.maxTotalAllocationPct, config.maxAllocationPct, buyValue,
        );
        if (!check.allowed) {
          errors.push(`Allocation limit for ${signal.symbol}: ${check.reason}`);
          continue;
        }
      }

      // Record signal for dedup (fixes #34 — uses ThemeStore with convertPlaceholders)
      const meta = signal.metadata as Record<string, unknown>;
      const signalHash = `${meta.member_slug}-${signal.symbol}-${meta.transaction_date}-${signal.action}`;
      const store = new ThemeStore(ctx.db);
      await store.recordSignal(config.id, signalHash, signal.symbol, signal.action, signal.metadata as Record<string, unknown>);

      // Place order via sub-account — pass signal price as limitPrice
      // so the sub-account doesn't need a price provider
      try {
        const result = await subAccount.placeOrder({
          symbol: signal.symbol,
          side: signal.action,
          quantity: qty,
          orderType: "limit",
          limitPrice: price,
          clientOrderId: randomUUID(),
        });

        if (result.status === "filled") {
          trades.push(result as any);
        } else if (result.status === "rejected") {
          errors.push(`Order rejected for ${signal.symbol}: ${result.error}`);
        }
      } catch (err) {
        errors.push(`Trade failed for ${signal.symbol}: ${(err as Error).message}`);
      }
    }

    return {
      themeId: config.id,
      timestamp,
      signals: newSignals,
      decisions,
      trades,
      errors,
    };
  }
}