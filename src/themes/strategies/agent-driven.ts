/**
 * AgentDrivenStrategy — uses an AI agent to generate trading signals.
 *
 * Delegates to an agent (doom/kangbot) via A2A. The agent receives
 * the current portfolio state and market context, then returns
 * buy/sell/hold recommendations which are executed via the sub-account.
 *
 * Strategy type: "agent-driven"
 *
 * Required params:
 * - agentEndpoint: A2A endpoint URL for the agent
 * - agentName: name of the agent to query
 *
 * Optional params:
 * - agentToken: A2A bearer token
 * - universe: list of symbols to constrain the agent
 * - promptTemplate: custom prompt template
 */

import { randomUUID } from "node:crypto";
import type { ThemeStrategy, ThemeContext } from "../strategy.js";
import type { ThemeConfig, ThemeEvaluationResult, ThemeSignal } from "../theme.js";
import { AgentSignalSource } from "../sources/agent-signal.js";
import { ThemeSubAccount } from "../theme-sub-account.js";
import { ThemeStore } from "../theme-store.js";
import { isWithinAllocationLimit } from "../allocation-check.js";

interface AgentDrivenParams {
  agentEndpoint: string;
  agentName: string;
  agentToken?: string;
  universe?: string[];
  promptTemplate?: string;
}

export class AgentDrivenStrategy implements ThemeStrategy {
  readonly type = "agent-driven";

  async evaluate(
    ctx: ThemeContext,
    config: ThemeConfig,
  ): Promise<ThemeEvaluationResult> {
    const params = config.params as unknown as AgentDrivenParams;
    const timestamp = new Date().toISOString();
    const errors: string[] = [];

    if (!params.agentEndpoint || !params.agentName) {
      return {
        themeId: config.id,
        timestamp,
        signals: [],
        decisions: [],
        trades: [],
        errors: ["Missing required params: agentEndpoint, agentName"],
      };
    }

    // Get sub-account for price/equity context
    const subAccount = new ThemeSubAccount(ctx.db, config.id);

    let equity = 0;
    try {
      const balance = await subAccount.getBalance();
      equity = balance.equity;
    } catch {
      errors.push("Sub-account not initialized");
      return {
        themeId: config.id,
        timestamp,
        signals: [],
        decisions: [],
        trades: [],
        errors,
      };
    }

    // Create signal source with context
    const source = new AgentSignalSource({
      endpoint: params.agentEndpoint,
      token: params.agentToken,
      agentName: params.agentName,
      universe: params.universe,
      promptTemplate: params.promptTemplate,
      getEquity: async () => equity,
      getPositions: async () => subAccount.getPositions(),
    });

    // Fetch signals from the agent
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
        errors: [`Agent signal fetch failed: ${(err as Error).message}`],
      };
    }

    if (signals.length === 0) {
      return {
        themeId: config.id,
        timestamp,
        signals: [],
        decisions: [],
        trades: [],
        errors: ["Agent returned no signals"],
      };
    }

    // Process signals — execute trades via sub-account
    const trades: ThemeEvaluationResult["trades"] = [];

    for (const signal of signals) {
      if (signal.action === "hold") continue;

      // Get current price
      let price = signal.priceAtSignal;
      if (!price || price <= 0) {
        try {
          price = await ctx.getQuote(signal.symbol);
        } catch {
          errors.push(`No price for ${signal.symbol} — skipping`);
          continue;
        }
      }

      if (!price || price <= 0) {
        errors.push(`No price for ${signal.symbol} — skipping`);
        continue;
      }

      // Calculate quantity from allocation
      const maxAllocation = equity * (config.maxAllocationPct / 100);
      const qty = signal.suggestedQuantity ?? maxAllocation / price;
      if (qty <= 0) {
        errors.push(`Insufficient allocation for ${signal.symbol}`);
        continue;
      }

      // Check max positions for buys
      if (signal.action === "buy") {
        const positions = await subAccount.getPositions();
        const hasPosition = positions.some((p) => p.symbol === signal.symbol);
        if (!hasPosition && positions.length >= config.maxPositions) {
          errors.push(`Max positions reached — skipping ${signal.symbol}`);
          continue;
        }

        // Enforce maxTotalAllocationPct (fixes #37)
        const buyValue = qty * price;
        const allocCheck = isWithinAllocationLimit(
          positions, equity, config.maxTotalAllocationPct, config.maxAllocationPct, buyValue,
        );
        if (!allocCheck.allowed) {
          errors.push(`Allocation limit for ${signal.symbol}: ${allocCheck.reason}`);
          continue;
        }
      }

      // Record signal for dedup (fixes #35 — uses ThemeStore instead of
      // SQLite-only INSERT OR IGNORE; ThemeStore uses convertPlaceholders)
      const signalHash = `agent-${signal.symbol}-${signal.action}-${timestamp}`;
      const store = new ThemeStore(ctx.db);
      await store.recordSignal(
        config.id,
        signalHash,
        signal.symbol,
        signal.action,
        { source: "agent", ...signal.metadata } as Record<string, unknown>,
      );

      // Place order
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
      signals,
      decisions: [],
      trades,
      errors,
    };
  }
}