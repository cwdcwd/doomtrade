/**
 * AgentTradingPipeline — autonomous per-agent trading loop.
 *
 * Each agent runs on a schedule: evaluate its assigned strategy, generate
 * signals, execute trades via its AgentExchange, and coordinate with
 * peer agents via A2A.
 *
 * The pipeline is designed to be called from a cron job or scheduled loop:
 *   1. For each active agent with a strategy:
 *      a. Fetch market data for the agent's universe
 *      b. Run the strategy's evaluate() method
 *      c. Execute the resulting trades via AgentExchange
 *      d. Record portfolio checkpoint
 *      e. Notify peer agents of significant events
 *   2. Update the leaderboard
 *
 * A2A coordination:
 *   - Doom (researcher): generates buy/sell signals based on momentum
 *   - Kangbot (validator): reviews Doom's signals, can veto or add confidence
 *   - ThanosBot (executor): executes trades based on A2A agent signals
 */

import type { Database } from "../db/database.js";
import type { AgentManager } from "./agent-manager.js";
import type { AgentExchange } from "../executor/agent-exchange.js";
import type { MarketDataService } from "../market/market.js";
import type { ThemeStrategy, ThemeContext } from "../themes/strategy.js";
import type { ThemeConfig, ThemeEvaluationResult } from "../themes/theme.js";
import { execAll, execGet, execRun, convertPlaceholders } from "../db/database.js";
import { errorMessage } from "../util/error.js";

export interface PipelineConfig {
  agentManager: AgentManager;
  marketData: MarketDataService;
  db: Database;
  /** Strategy registry — maps strategy type to implementation */
  strategies: Map<string, ThemeStrategy>;
  /** Default symbol universe for agents without one */
  defaultUniverse: string[];
  /** A2A endpoint for agent communication */
  a2aEndpoint?: string;
  /** A2A bearer token */
  a2aToken?: string;
}

export interface AgentTradeResult {
  agentId: string;
  agentName: string;
  strategy: string | null;
  signals: number;
  trades: number;
  errors: string[];
  equityBefore: number;
  equityAfter: number;
  pnlChange: number;
}

export class AgentTradingPipeline {
  private config: PipelineConfig;

  constructor(config: PipelineConfig) {
    this.config = config;
  }

  /**
   * Run one trading cycle for all active agents with assigned strategies.
   * Returns results per agent.
   */
  async runCycle(): Promise<AgentTradeResult[]> {
    const agents = await this.config.agentManager.list();
    const active = agents.filter((a) => a.active && a.strategy);

    const results: AgentTradeResult[] = [];

    for (const agent of active) {
      try {
        const result = await this.runAgentCycle(agent.id, agent.name, agent.strategy!);
        results.push(result);
      } catch (err) {
        results.push({
          agentId: agent.id,
          agentName: agent.name,
          strategy: agent.strategy,
          signals: 0,
          trades: 0,
          errors: [`Pipeline error: ${errorMessage(err)}`],
          equityBefore: 0,
          equityAfter: 0,
          pnlChange: 0,
        });
      }
    }

    return results;
  }

  /**
   * Run one trading cycle for a specific agent.
   */
  async runAgentCycle(
    agentId: string,
    agentName: string,
    strategyType: string,
  ): Promise<AgentTradeResult> {
    const strategy = this.config.strategies.get(strategyType);
    if (!strategy) {
      return {
        agentId,
        agentName,
        strategy: strategyType,
        signals: 0,
        trades: 0,
        errors: [`Strategy not registered: ${strategyType}`],
        equityBefore: 0,
        equityAfter: 0,
        pnlChange: 0,
      };
    }

    const exchange = this.config.agentManager.getExchange(agentId);
    const balanceBefore = await exchange.getBalance();
    const equityBefore = balanceBefore.equity;

    // Ensure a themes row exists (FK target for theme_signals dedup table)
    await this.ensureThemeRow(agentId, agentName, strategyType);

    // Build the theme config for this agent
    const config: ThemeConfig = {
      id: agentId,
      name: agentName,
      strategy: strategyType,
      mode: "sim",
      schedule: { type: "manual" },
      maxAllocationPct: 99,
      maxTotalAllocationPct: 99,
      maxPositions: 10,
      params: this.getStrategyParams(agentName, strategyType),
      enabled: true,
      allocatedCapital: equityBefore,
    };

    // Build the context
    const ctx = await this.buildContext(agentId, exchange);

    // Run the strategy
    let result: ThemeEvaluationResult;
    try {
      result = await strategy.evaluate(ctx, config);
    } catch (err) {
      return {
        agentId,
        agentName,
        strategy: strategyType,
        signals: 0,
        trades: 0,
        errors: [`Strategy evaluation failed: ${errorMessage(err)}`],
        equityBefore,
        equityAfter: equityBefore,
        pnlChange: 0,
      };
    }

    // Record checkpoint
    await exchange.recordCheckpoint();

    const balanceAfter = await exchange.getBalance();

    return {
      agentId,
      agentName,
      strategy: strategyType,
      signals: result.signals.length,
      trades: result.trades.length,
      errors: result.errors,
      equityBefore,
      equityAfter: balanceAfter.equity,
      pnlChange: balanceAfter.equity - equityBefore,
    };
  }

  /**
   * Build a ThemeContext for an agent's strategy evaluation.
   */
  private async buildContext(agentId: string, exchange: AgentExchange): Promise<ThemeContext> {
    return {
      db: this.config.db,
      marketData: this.config.marketData,
      decisionStore: null as any, // Strategies that need it use ctx.db directly
      tradeEngine: null as any,
      portfolio: null as any,
      themeId: agentId,
      exchange, // Strategies use this for trade execution (AgentExchange)
      getEquity: async () => {
        const bal = await exchange.getBalance();
        return bal.equity;
      },
      getPositions: async () => {
        return exchange.getPositions();
      },
      getQuote: async (symbol: string) => {
        const quote = await this.config.marketData.getQuote(symbol);
        return quote.price;
      },
    };
  }

  /**
   * Get strategy-specific parameters for an agent.
   */
  private getStrategyParams(agentName: string, strategyType: string): Record<string, unknown> {
    switch (strategyType) {
      case "momentum-rotation":
        return {
          universe: this.config.defaultUniverse,
          indicator: { type: "combined", periods: { fast: 20, slow: 50 }, rsiPeriod: 14 },
          topN: 3,
          timeframe: "1Day",
          range: "1m",
        };
      case "congress-follower":
        return {
          politician: "Pelosi",
          mirrorAction: "buys-only",
        };
      case "agent-driven":
        return {
          agentEndpoint: this.config.a2aEndpoint ?? "",
          agentName: agentName,
          agentToken: this.config.a2aToken,
          universe: this.config.defaultUniverse,
        };
      default:
        return {};
    }
  }

  /**
   * Ensure a themes row exists for the agent (FK target for theme_signals).
   * Does NOT create a theme_subaccount — strategies use ctx.exchange
   * (AgentExchange) when available, which writes to agent_* tables.
   */
  private async ensureThemeRow(
    themeId: string,
    agentName: string,
    strategy: string,
  ): Promise<void> {
    const db = this.config.db;
    const themeCheckSql = convertPlaceholders("SELECT id FROM themes WHERE id = ?", db.backend);
    const themeExists = await execGet<{ id: string }>(db, themeCheckSql, [themeId]);
    if (!themeExists) {
      const themeInsertSql = convertPlaceholders(
        `INSERT INTO themes (id, name, strategy, mode, schedule, max_allocation_pct, max_total_allocation_pct, max_positions, allocated_capital, params, enabled)
         VALUES (?, ?, ?, 'sim', '{"type":"manual"}', 99, 99, 10, 0, '{}', 1)`,
        db.backend,
      );
      await execRun(db, themeInsertSql, [themeId, agentName, strategy]);
    }
  }

  /**
   * Get a summary of all agent portfolios for logging.
   */
  async getSummary(): Promise<string[]> {
    const leaderboard = await this.config.agentManager.leaderboard();
    return leaderboard.map(
      (e) =>
        `#${e.rank} ${e.name}: $${e.equity.toFixed(2)} (${e.totalReturnPct > 0 ? "+" : ""}${e.totalReturnPct.toFixed(2)}%)`,
    );
  }
}
