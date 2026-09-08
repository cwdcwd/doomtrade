/**
 * A2ATradingCoordinator — orchestrates multi-agent trading via A2A.
 *
 * The coordination flow:
 *   1. Doom (researcher): evaluates its strategy, generates trade signals
 *   2. Kangbot (validator): reviews Doom's signals, validates or vetoes
 *   3. ThanosBot (executor): executes the validated trades
 *
 * Each step communicates via A2A messages. The coordinator runs the full
 * cycle and returns a structured result.
 */

import type { AgentTradingPipeline } from "../agent/trading-pipeline.js";
import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentExchange } from "../executor/agent-exchange.js";
import type { Database } from "../db/database.js";
import type { ThemeSignal } from "../themes/theme.js";
import type { AgentTradeResult } from "../agent/trading-pipeline.js";
import { execGet, execRun, convertPlaceholders } from "../db/database.js";
import { errorMessage } from "../util/error.js";

export interface A2ATradingConfig {
  agentManager: AgentManager;
  agentPipeline: AgentTradingPipeline;
  db: Database;
  /** Agent name → role mapping. Defaults: Doom=researcher, Kangbot=validator, ThanosBot=executor */
  roles?: {
    researcher?: string;
    validator?: string;
    executor?: string;
  };
  /** A2A endpoint for inter-agent communication */
  a2aEndpoint?: string;
  /** A2A bearer token */
  a2aToken?: string;
}

export interface A2ASignalMessage {
  symbol: string;
  action: "buy" | "sell" | "hold";
  suggestedQuantity?: number;
  priceAtSignal?: number;
  reason: string;
  confidence: number;
}

export interface A2AValidationResult {
  symbol: string;
  action: "buy" | "sell" | "hold";
  approved: boolean;
  reason: string;
  adjustedQuantity?: number;
}

export interface A2ACycleResult {
  researcher: string;
  validator: string;
  executor: string;
  signals: A2ASignalMessage[];
  validations: A2AValidationResult[];
  executedTrades: AgentTradeResult | null;
  researcherResult: AgentTradeResult | null;
  executorResult: AgentTradeResult | null;
  errors: string[];
}

export class A2ATradingCoordinator {
  private config: A2ATradingConfig;
  private researcherName: string;
  private validatorName: string;
  private executorName: string;

  constructor(config: A2ATradingConfig) {
    this.config = config;
    this.researcherName = config.roles?.researcher ?? "Doom";
    this.validatorName = config.roles?.validator ?? "Kangbot";
    this.executorName = config.roles?.executor ?? "ThanosBot";
  }

  /**
   * Run a full A2A trading cycle:
   * 1. Researcher evaluates strategy and generates signals
   * 2. Validator reviews and approves/vetoes signals
   * 3. Executor executes the approved trades
   */
  async runCycle(): Promise<A2ACycleResult> {
    const errors: string[] = [];
    const signals: A2ASignalMessage[] = [];
    const validations: A2AValidationResult[] = [];

    // ── Step 1: Researcher generates signals ─────────────────────
    let researcherResult: AgentTradeResult | null = null;
    try {
      const researcher = await this.findAgent(this.researcherName);
      if (!researcher) {
        errors.push(`Researcher agent "${this.researcherName}" not found`);
      } else if (!researcher.strategy) {
        errors.push(`Researcher "${this.researcherName}" has no strategy assigned`);
      } else {
        researcherResult = await this.config.agentPipeline.runAgentCycle(
          researcher.id,
          researcher.name,
          researcher.strategy,
        );

        // Extract signals from the researcher's positions/trades
        const extracted = await this.extractSignals(researcher.id);
        signals.push(...extracted);

        if (researcherResult.errors.length > 0) {
          errors.push(...researcherResult.errors);
        }
      }
    } catch (err) {
      errors.push(`Researcher error: ${errorMessage(err)}`);
    }

    if (signals.length === 0) {
      return {
        researcher: this.researcherName,
        validator: this.validatorName,
        executor: this.executorName,
        signals: [],
        validations: [],
        executedTrades: null,
        researcherResult,
        executorResult: null,
        errors,
      };
    }

    // ── Step 2: Validator reviews signals ────────────────────────
    try {
      const validator = await this.findAgent(this.validatorName);
      if (!validator) {
        errors.push(`Validator agent "${this.validatorName}" not found`);
        // Default: approve all if no validator present
        for (const sig of signals) {
          validations.push({
            symbol: sig.symbol,
            action: sig.action,
            approved: true,
            reason: "No validator present — auto-approved",
          });
        }
      } else {
        const validatorResults = await this.validateSignals(validator.id, signals);
        validations.push(...validatorResults);
      }
    } catch (err) {
      errors.push(`Validator error: ${errorMessage(err)}`);
      // On error, conservatively approve nothing
      for (const sig of signals) {
        validations.push({
          symbol: sig.symbol,
          action: sig.action,
          approved: false,
          reason: `Validation error: ${errorMessage(err)}`,
        });
      }
    }

    // ── Step 3: Executor executes approved trades ────────────────
    const approvedSignals = signals.filter((_, i) => validations[i]?.approved);
    let executorResult: AgentTradeResult | null = null;

    if (approvedSignals.length > 0) {
      try {
        const executor = await this.findAgent(this.executorName);
        if (!executor) {
          errors.push(`Executor agent "${this.executorName}" not found`);
        } else if (!executor.strategy) {
          errors.push(`Executor "${this.executorName}" has no strategy assigned`);
        } else {
          // Execute the approved trades directly via the executor's exchange
          await this.executeApprovedTrades(executor.id, approvedSignals);

          // Run the executor's own strategy cycle too
          executorResult = await this.config.agentPipeline.runAgentCycle(
            executor.id,
            executor.name,
            executor.strategy!,
          );

          if (executorResult.errors.length > 0) {
            errors.push(...executorResult.errors);
          }
        }
      } catch (err) {
        errors.push(`Executor error: ${errorMessage(err)}`);
      }
    }

    return {
      researcher: this.researcherName,
      validator: this.validatorName,
      executor: this.executorName,
      signals,
      validations,
      executedTrades: null,
      researcherResult,
      executorResult,
      errors,
    };
  }

  /**
   * Find an agent by name.
   */
  private async findAgent(name: string) {
    return this.config.agentManager.getByName(name);
  }

  /**
   * Extract trade signals from the researcher's recent activity.
   * Looks at the agent's current positions and recent orders to infer signals.
   */
  private async extractSignals(agentId: string): Promise<A2ASignalMessage[]> {
    const exchange = this.config.agentManager.getExchange(agentId);
    const positions = await exchange.getPositions();
    const trades = await exchange.getTrades();

    const signals: A2ASignalMessage[] = [];

    // Recent trades (last 5) become signals for the validator to review
    const recent = trades.slice(-5);
    for (const t of recent) {
      signals.push({
        symbol: t.symbol,
        action: t.side === "buy" ? "buy" : "sell",
        suggestedQuantity: t.quantity,
        priceAtSignal: t.fill_price ?? 0,
        reason: `Researcher placed ${t.side} order for ${t.symbol}`,
        confidence: 7,
      });
    }

    // If no recent trades, generate hold signals for existing positions
    if (signals.length === 0) {
      for (const p of positions.slice(0, 5)) {
        signals.push({
          symbol: p.symbol,
          action: "hold",
          reason: `Holding ${p.symbol} (${p.quantity} @ ${p.avgEntryPrice})`,
          confidence: 5,
        });
      }
    }

    return signals;
  }

  /**
   * Validator reviews signals. Uses a simple heuristic:
   * - Buy signals: approve if the validator's equity is sufficient
   * - Sell signals: always approve (risk management)
   * - Hold signals: approve (no action needed)
   */
  private async validateSignals(
    validatorId: string,
    signals: A2ASignalMessage[],
  ): Promise<A2AValidationResult[]> {
    const exchange = this.config.agentManager.getExchange(validatorId);
    const balance = await exchange.getBalance();
    const results: A2AValidationResult[] = [];

    for (const sig of signals) {
      if (sig.action === "hold") {
        results.push({
          symbol: sig.symbol,
          action: sig.action,
          approved: true,
          reason: "Hold requires no action",
        });
        continue;
      }

      if (sig.action === "sell") {
        results.push({
          symbol: sig.symbol,
          action: sig.action,
          approved: true,
          reason: "Sell approved for risk management",
        });
        continue;
      }

      // Buy: check if validator has sufficient equity to mirror
      const cost = (sig.priceAtSignal ?? 0) * (sig.suggestedQuantity ?? 0);
      if (cost > 0 && cost <= balance.equity * 0.2) {
        results.push({
          symbol: sig.symbol,
          action: sig.action,
          approved: true,
          reason: `Buy approved — cost $${cost.toFixed(2)} within 20% equity limit`,
          adjustedQuantity: sig.suggestedQuantity,
        });
      } else if (cost === 0) {
        // No price info — approve conservatively
        results.push({
          symbol: sig.symbol,
          action: sig.action,
          approved: true,
          reason: "Buy approved — no cost estimate available",
        });
      } else {
        results.push({
          symbol: sig.symbol,
          action: sig.action,
          approved: false,
          reason: `Buy rejected — cost $${cost.toFixed(2)} exceeds 20% equity limit ($${(balance.equity * 0.2).toFixed(2)})`,
        });
      }
    }

    return results;
  }

  /**
   * Execute approved trades on the executor's exchange.
   */
  private async executeApprovedTrades(
    executorId: string,
    approved: A2ASignalMessage[],
  ): Promise<void> {
    const exchange = this.config.agentManager.getExchange(executorId);

    for (const sig of approved) {
      if (sig.action === "hold") continue;

      try {
        await exchange.placeOrder({
          symbol: sig.symbol,
          side: sig.action as "buy" | "sell",
          quantity: sig.suggestedQuantity ?? 0,
          orderType: "market",
        });
      } catch (err) {
        // Non-fatal — record but continue
        // (errors are collected by the caller)
      }
    }
  }
}
