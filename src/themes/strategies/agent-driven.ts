/**
 * AgentDriven — a theme strategy that delegates decisions to an A2A agent.
 *
 * On each evaluation:
 * 1. Build market context (positions, prices, indicators)
 * 2. Send analysis prompt to the peer agent via AgentCoordinator
 * 3. Parse agent response into ThemeSignal[]
 * 4. Convert signals to decisions via the decision store
 * 5. Execute decisions through the sub-account
 *
 * Config params (via ThemeConfig.params):
 * - universe: string[] — symbols the agent should analyze
 * - agentName: "doom" | "kangbot" — which agent to delegate to
 * - instructions: string — additional instructions for the agent
 * - maxConfidence: number — max confidence level (default 8)
 */

import type { ThemeStrategy, ThemeContext } from "../strategy.js";
import type { ThemeConfig, ThemeEvaluationResult, ThemeSignal } from "../theme.js";
import type { Decision } from "../../decision/decision.js";
import type { TradeRecord } from "../../engine/trade-engine.js";
import { ThemeSubAccount } from "../theme-sub-account.js";
import { AgentSignalSource } from "../sources/agent-signal.js";
import type { AgentCoordinator } from "../../integration/agent-integration.js";
import type { ResearchService } from "../../research/research.js";

interface AgentDrivenParams {
  universe: string[];
  agentName: "doom" | "kangbot";
  instructions?: string;
  maxConfidence?: number;
}

export class AgentDrivenStrategy implements ThemeStrategy {
  readonly type = "agent-driven";
  private coordinator: AgentCoordinator;
  private research: ResearchService;

  constructor(coordinator: AgentCoordinator, research: ResearchService) {
    this.coordinator = coordinator;
    this.research = research;
  }

  async evaluate(
    ctx: ThemeContext,
    config: ThemeConfig,
  ): Promise<ThemeEvaluationResult> {
    const params = config.params as unknown as AgentDrivenParams;
    const maxConfidence = params.maxConfidence ?? 8;
    const errors: string[] = [];
    const decisions: Decision[] = [];
    const trades: TradeRecord[] = [];

    // 1. Create the signal source
    const signalSource = new AgentSignalSource(
      this.coordinator,
      this.research,
      {
        universe: params.universe,
        agentName: params.agentName,
        instructions: params.instructions,
      },
    );

    // 2. Fetch signals from the agent
    const signals = await signalSource.fetchSignals();

    if (signals.length === 0) {
      return {
        themeId: config.id,
        timestamp: new Date().toISOString(),
        signals: [],
        decisions: [],
        trades: [],
        errors: ["No signals from agent"],
      };
    }

    // 3. Get current positions for context
    const currentPositions = await ctx.getPositions();
    const positionMap = new Map(currentPositions.map((p) => [p.symbol, p]));

    // 4. Process each signal
    // Create sub-account with a price provider that uses ctx.getQuote
    const subAccount = new ThemeSubAccount(ctx.db, ctx.themeId, {
      getCurrentPrice: (symbol: string) => {
        // Synchronous price lookup from signal cache
        // The sub-account uses this for fills and position valuation
        return signalPrices.get(symbol) ?? null;
      },
    });

    // Pre-fetch prices for all signal symbols
    const signalPrices = new Map<string, number>();

    for (const signal of signals) {
      const price = signal.priceAtSignal ?? await ctx.getQuote(signal.symbol);

      if (price <= 0) {
        errors.push(`No price for ${signal.symbol}`);
        continue;
      }

      // Cache price for sub-account price provider
      signalPrices.set(signal.symbol, price);

      // Determine quantity
      let quantity = signal.suggestedQuantity ?? 0;

      if (signal.action === "buy") {
        // Calculate position size from available cash
        if (quantity <= 0) {
          let cash: number;
          try {
            const balance = await subAccount.getBalance();
            cash = balance.cash;
          } catch {
            // Sub-account may lack a price provider for existing positions;
            // fall back to theme equity as the available capital proxy
            cash = await ctx.getEquity();
          }
          const maxAllocation = (config.maxAllocationPct / 100) * (await ctx.getEquity());
          const allocation = Math.min(cash, maxAllocation);
          quantity = Math.floor(allocation / price);
        }

        if (quantity <= 0) {
          errors.push(`Cannot buy ${signal.symbol}: insufficient cash or allocation`);
          continue;
        }

        // Create decision
        const decision = await ctx.decisionStore.create({
          agent: params.agentName,
          symbol: signal.symbol,
          action: "buy",
          quantity,
          rationale: signal.reason,
          confidence: maxConfidence,
          priceAtDecision: price,
          mode: config.mode,
          marketContext: {
            price,
            mode: config.mode,
            themeStrategy: "agent-driven",
            agentSignal: signal.metadata,
          },
        });
        decisions.push(decision);

        // Execute via sub-account — pass price as limitPrice so the
        // sub-account can fill without needing an external price provider
        const orderResult = await subAccount.placeOrder({
          symbol: signal.symbol,
          side: "buy",
          quantity,
          orderType: "limit",
          limitPrice: price,
        });

        if (orderResult.status === "filled") {
          trades.push({
            id: orderResult.id,
            decisionId: decision.id,
            symbol: signal.symbol,
            side: "buy",
            quantity,
            fillPrice: orderResult.fillPrice!,
            fee: orderResult.fee,
            status: "filled",
            timestamp: orderResult.timestamp,
          } as TradeRecord);
        } else if (orderResult.error) {
          errors.push(`Buy ${signal.symbol} failed: ${orderResult.error}`);
        }
      } else if (signal.action === "sell") {
        const pos = positionMap.get(signal.symbol);
        if (!pos || pos.quantity <= 0) {
          errors.push(`Cannot sell ${signal.symbol}: no position`);
          continue;
        }

        quantity = Math.min(quantity || pos.quantity, pos.quantity);

        const decision = await ctx.decisionStore.create({
          agent: params.agentName,
          symbol: signal.symbol,
          action: "sell",
          quantity,
          rationale: signal.reason,
          confidence: maxConfidence,
          priceAtDecision: price,
          mode: config.mode,
          marketContext: {
            price,
            mode: config.mode,
            themeStrategy: "agent-driven",
            agentSignal: signal.metadata,
          },
        });
        decisions.push(decision);

        const orderResult = await subAccount.placeOrder({
          symbol: signal.symbol,
          side: "sell",
          quantity,
          orderType: "limit",
          limitPrice: price,
        });

        if (orderResult.status === "filled") {
          trades.push({
            id: orderResult.id,
            decisionId: decision.id,
            symbol: signal.symbol,
            side: "sell",
            quantity,
            fillPrice: orderResult.fillPrice!,
            fee: orderResult.fee,
            status: "filled",
            timestamp: orderResult.timestamp,
          } as TradeRecord);
        } else if (orderResult.error) {
          errors.push(`Sell ${signal.symbol} failed: ${orderResult.error}`);
        }
      }
    }

    // 5. Notify the peer agent of the evaluation result
    try {
      await this.coordinator.sendMessage(
        `Agent-driven theme ${config.name} evaluated: ` +
        `${signals.length} signals, ${decisions.length} decisions, ` +
        `${trades.length} trades, ${errors.length} errors.`,
      );
    } catch {
      // Notification failure is non-fatal
    }

    return {
      themeId: config.id,
      timestamp: new Date().toISOString(),
      signals,
      decisions,
      trades,
      errors,
    };
  }
}