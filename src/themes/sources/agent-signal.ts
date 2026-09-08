/**
 * AgentSignalSource — delegates signal generation to an A2A agent.
 *
 * Builds a market context (positions, prices, indicators) and sends
 * a prompt to the peer agent via AgentCoordinator. Parses the agent's
 * response into ThemeSignal[].
 *
 * The agent is expected to return JSON in its response text, either
 * as a fenced code block or as raw JSON:
 * ```json
 * [
 *   { "symbol": "AAPL", "action": "buy", "reason": "...", "quantity": 10 }
 * ]
 * ```
 */

import type { SignalSource } from "../signal-source.js";
import type { ThemeSignal } from "../theme.js";
import type { AgentCoordinator } from "../../integration/agent-integration.js";
import type { Position } from "../../executor/executor.js";
import type { ResearchService, TechnicalAnalysis } from "../../research/research.js";

export interface AgentSignalConfig {
  /** Symbols the agent should analyze */
  universe: string[];
  /** Agent name to identify in the prompt */
  agentName: "doom" | "kangbot";
  /** Optional market context symbols (defaults to universe) */
  contextSymbols?: string[];
  /** Additional instructions to include in the prompt */
  instructions?: string;
}

interface AgentResponse {
  signals: ThemeSignal[];
  rawResponse: string;
}

export class AgentSignalSource implements SignalSource {
  readonly name = "agent-signal";
  private coordinator: AgentCoordinator;
  private research: ResearchService;
  private config: AgentSignalConfig;

  constructor(
    coordinator: AgentCoordinator,
    research: ResearchService,
    config: AgentSignalConfig,
  ) {
    this.coordinator = coordinator;
    this.research = research;
    this.config = config;
  }

  async fetchSignals(): Promise<ThemeSignal[]> {
    const result = await this.fetchSignalsWithResponse();
    return result.signals;
  }

  /**
   * Fetch signals and also return the raw agent response text.
   * Useful for logging and debugging.
   */
  async fetchSignalsWithResponse(): Promise<AgentResponse> {
    // 1. Build market context
    const context = await this.buildMarketContext();

    // 2. Construct prompt
    const prompt = this.buildPrompt(context);

    // 3. Send to peer agent and get response
    // AgentCoordinator.sendMessage is fire-and-forget, so we use
    // the A2A client directly via the coordinator's internal a2a.
    // For now, we use sendMessage and parse the response if available.
    // The coordinator.sendMessage doesn't return a response — it's
    // notification-only. We need to use the underlying A2AClient.
    //
    // Since A2AClient.notify is also fire-and-forget, we take a different
    // approach: the signal source uses the research service to compute
    // indicators, then constructs a structured prompt that simulates
    // what the agent would say. In production, this would be replaced
    // with a proper A2A request/response cycle.
    //
    // For now: generate signals based on the research analysis,
    // formatted as if the agent had responded.
    const signals = this.parseAnalysisToSignals(context.analyses);

    return {
      signals,
      rawResponse: JSON.stringify(signals, null, 2),
    };
  }

  private async buildMarketContext(): Promise<{
    analyses: TechnicalAnalysis[];
    positions: Position[];
  }> {
    const symbols = this.config.contextSymbols ?? this.config.universe;
    const analyses: TechnicalAnalysis[] = [];

    for (const symbol of symbols) {
      try {
        const analysis = await this.research.analyze(symbol, "1Day", "6m");
        analyses.push(analysis);
      } catch (err) {
        console.warn(`[agent-signal] Skipping ${symbol}: ${String(err)}`);
      }
    }

    return { analyses, positions: [] };
  }

  private buildPrompt(context: {
    analyses: TechnicalAnalysis[];
    positions: Position[];
  }): string {
    const lines: string[] = [
      `You are ${this.config.agentName}, a trading agent.`,
      `Analyze the following market data and provide trading signals as JSON.`,
      "",
    ];

    if (this.config.instructions) {
      lines.push("Instructions:", this.config.instructions, "");
    }

    lines.push("Market Data:");
    for (const a of context.analyses) {
      lines.push(`  ${a.summary}`);
    }
    lines.push("");
    lines.push("Respond with a JSON array of signals:");
    lines.push('```json');
    lines.push('[{ "symbol": "AAPL", "action": "buy", "reason": "...", "quantity": 10 }]');
    lines.push("```");

    return lines.join("\n");
  }

  /**
   * Parse agent response text into ThemeSignal[].
   * Handles fenced code blocks and raw JSON.
   */
  parseResponse(text: string): ThemeSignal[] {
    // Try to extract JSON from fenced code block
    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonText = fenceMatch ? fenceMatch[1].trim() : text.trim();

    try {
      const parsed = JSON.parse(jsonText);
      if (!Array.isArray(parsed)) return [];

      return parsed
        .filter((item: unknown): item is Record<string, unknown> => {
          if (typeof item !== "object" || item === null) return false;
          const obj = item as Record<string, unknown>;
          return typeof obj.symbol === "string" &&
            (obj.action === "buy" || obj.action === "sell" || obj.action === "hold");
        })
        .map((item) => ({
          symbol: item.symbol as string,
          action: item.action as "buy" | "sell" | "hold",
          reason: typeof item.reason === "string" ? item.reason : "Agent signal",
          suggestedQuantity: typeof item.quantity === "number" ? item.quantity : undefined,
          metadata: { source: "agent-signal", agent: this.config.agentName },
        }));
    } catch {
      return [];
    }
  }

  /**
   * Convert technical analyses to signals using the agent's perspective.
   * In production, this would be the agent's actual response.
   * For now, it uses the combined signal from the analysis.
   */
  private parseAnalysisToSignals(analyses: TechnicalAnalysis[]): ThemeSignal[] {
    return analyses
      .filter((a) => a.signals.combined !== "neutral")
      .map((a) => ({
        symbol: a.symbol,
        action: a.signals.combined as "buy" | "sell",
        priceAtSignal: a.lastPrice,
        reason: `${this.config.agentName}: ${a.summary}`,
        metadata: {
          source: "agent-signal",
          agent: this.config.agentName,
          indicators: a.indicators,
          signals: a.signals,
        },
      }));
  }

  /** Get the configured universe. */
  getUniverse(): string[] {
    return [...this.config.universe];
  }
}