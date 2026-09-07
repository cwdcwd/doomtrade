/**
 * agent-integration.ts — A2A agent coordination for DoomTrade.
 *
 * Uses @cwdcwd/agent-bridge to let Doom and Kangbot submit trading
 * decisions programmatically via the A2A (Agent-to-Agent) protocol.
 *
 * The AgentCoordinator wraps the DecisionStore so agents can:
 *  - Submit decisions (POST /api/decisions equivalent)
 *  - Notify the peer agent of significant events (trade executed, risk blocked)
 *  - Query portfolio state
 */

import type { DecisionStore } from "../decision/decision-store.js";
import type { TradeEngine } from "../engine/trade-engine.js";
import type { Portfolio } from "../portfolio/portfolio.js";
import type { Decision, Agent } from "../decision/decision.js";
// @cwdcwd/agent-bridge has no bundled type declarations
import { A2AClient } from "@cwdcwd/agent-bridge";

export interface AgentCoordinatorOptions {
  /** A2A endpoint for the peer agent (LiteLLM gateway URL) */
  peerEndpoint: string;
  /** Bearer token for A2A authentication */
  peerToken?: string;
  /** This agent's name (doom or kangbot) */
  selfName: string;
  /** Timeout for A2A notifications in ms */
  timeoutMs?: number;
}

export class AgentCoordinator {
  private decisionStore: DecisionStore;
  private tradeEngine: TradeEngine;
  private portfolio: Portfolio;
  private a2a: A2AClient;
  private selfName: string;

  constructor(
    decisionStore: DecisionStore,
    tradeEngine: TradeEngine,
    portfolio: Portfolio,
    options: AgentCoordinatorOptions,
  ) {
    this.decisionStore = decisionStore;
    this.tradeEngine = tradeEngine;
    this.portfolio = portfolio;
    this.selfName = options.selfName;
    this.a2a = new A2AClient({
      endpoint: options.peerEndpoint,
      token: options.peerToken,
      timeoutMs: options.timeoutMs ?? 30_000,
    });
  }

  /**
   * Submit a trading decision from an agent and notify the peer.
   * This is the programmatic equivalent of POST /api/decisions.
   */
  async submitDecision(input: {
    agent: Agent;
    symbol: string;
    action: "buy" | "sell" | "hold";
    quantity: number;
    rationale: string;
    confidence: number;
    priceAtDecision: number;
    mode: "sim" | "live";
  }): Promise<Decision> {
    const decision = await this.decisionStore.create({
      agent: input.agent,
      symbol: input.symbol,
      action: input.action,
      quantity: input.quantity,
      rationale: input.rationale,
      confidence: input.confidence,
      priceAtDecision: input.priceAtDecision,
      marketContext: {
        price: input.priceAtDecision,
        mode: input.mode,
      },
      mode: input.mode,
    });

    // Notify peer agent of the new decision
    await this.a2a.notify("decision:created", {
      decisionId: decision.id,
      agent: input.agent,
      symbol: input.symbol,
      action: input.action,
      quantity: input.quantity,
      confidence: input.confidence,
      rationale: input.rationale,
    }, this.selfName);

    return decision;
  }

  /**
   * Execute a decision and notify the peer of the outcome.
   */
  async executeDecision(decisionId: string, orderType?: "market" | "limit" | "stop"): Promise<void> {
    const decision = await this.decisionStore.getById(decisionId);
    if (!decision) {
      throw new Error(`Decision not found: ${decisionId}`);
    }

    const result = await this.tradeEngine.executeDecision({
      decision,
      orderType,
    });

    // Record portfolio checkpoint
    await this.portfolio.recordCheckpoint();

    // Notify peer of execution outcome
    if (result.riskPassed && result.orderResult) {
      await this.a2a.notify("trade:executed", {
        decisionId,
        symbol: decision.symbol,
        action: decision.action,
        status: result.orderResult.status,
        fillPrice: result.orderResult.fillPrice,
        fee: result.orderResult.fee,
        realizedPnl: result.orderResult.realizedPnl,
      }, this.selfName);
    } else if (!result.riskPassed) {
      await this.a2a.notify("trade:blocked", {
        decisionId,
        symbol: decision.symbol,
        reasons: result.riskChecks
          .filter((c) => !c.passed)
          .map((c) => `${c.check}: ${c.reason}`),
      }, this.selfName);
    }
  }

  /**
   * Get current portfolio state for an agent query.
   */
  async getPortfolioStatus() {
    const [snapshot, pnl] = await Promise.all([
      this.portfolio.getSnapshot(),
      this.portfolio.getPnL(),
    ]);
    return { snapshot, pnl };
  }

  /**
   * Send a freeform message to the peer agent.
   */
  async sendMessage(text: string): Promise<void> {
    await this.a2a.sendMessage(text, this.selfName);
  }
}