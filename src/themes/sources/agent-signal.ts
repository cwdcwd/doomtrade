/**
 * AgentSignalSource — delegates signal generation to an AI agent via A2A.
 *
 * The agent receives the current portfolio state and market context,
 * then returns buy/sell/hold recommendations as ThemeSignals.
 *
 * Uses the existing AgentCoordinator / A2AClient from @cwdcwd/agent-bridge.
 */

import type { SignalSource } from "../signal-source.js";
import type { ThemeSignal } from "../theme.js";
import type { Position } from "../../executor/executor.js";
import { errorMessage } from "../../util/error.js";

export interface AgentSignalSourceConfig {
  /** A2A endpoint for the agent */
  endpoint: string;
  /** Bearer token for A2A auth */
  token?: string;
  /** Which agent to ask */
  agentName: string;
  /** Current positions for context */
  getPositions: () => Promise<Position[]>;
  /** Current equity for context */
  getEquity: () => Promise<number>;
  /** Symbol universe to constrain the agent (optional) */
  universe?: string[];
  /** Prompt template — receives {equity}, {positions}, {universe} */
  promptTemplate?: string;
}

const DEFAULT_PROMPT = `You are a trading strategy agent. Based on the current portfolio state below, recommend buy/sell/hold actions for symbols.

Current equity: {equity}
Current positions: {positions}
Symbol universe: {universe}

Respond as a JSON array of objects with fields: symbol, action (buy|sell|hold), reason, suggestedQuantity (optional). Only include valid US stock tickers.`;

export class AgentSignalSource implements SignalSource {
  readonly name = "agent-signal";

  constructor(private config: AgentSignalSourceConfig) {}

  async fetchSignals(): Promise<ThemeSignal[]> {
    const positions = await this.config.getPositions();
    const equity = await this.config.getEquity();

    const prompt = (this.config.promptTemplate ?? DEFAULT_PROMPT)
      .replace("{equity}", String(equity))
      .replace(
        "{positions}",
        JSON.stringify(
          positions.map((p) => ({
            symbol: p.symbol,
            quantity: p.quantity,
            avgEntryPrice: p.avgEntryPrice,
          })),
        ),
      )
      .replace("{universe}", this.config.universe?.join(", ") ?? "any");

    // Dynamic import to avoid hard dependency on agent-bridge
    let A2AClient: any;
    try {
      const mod = await import("@cwdcwd/agent-bridge");
      A2AClient = mod.A2AClient;
    } catch {
      throw new Error("Agent-bridge package not available — cannot use AgentSignalSource");
    }

    const client = new A2AClient({
      endpoint: this.config.endpoint,
      token: this.config.token,
      timeoutMs: 30_000,
    });

    const response = await client.sendMessage(prompt, this.config.agentName);

    // Parse the agent's response as JSON array of signals
    let signals: ThemeSignal[];
    try {
      // Try to extract JSON from the response
      const jsonMatch = response.match(/\[[\s\S]*\]/);
      const jsonStr = jsonMatch ? jsonMatch[0] : response;
      const parsed = JSON.parse(jsonStr);

      signals = (Array.isArray(parsed) ? parsed : [parsed])
        .map((item: any): ThemeSignal => ({
          symbol: String(item.symbol ?? item.ticker ?? ""),
          action: (item.action ?? item.recommendation ?? "hold") as "buy" | "sell" | "hold",
          reason: String(item.reason ?? item.rationale ?? "Agent recommendation"),
          suggestedQuantity: item.suggestedQuantity ?? item.quantity,
        }))
        .filter((s: ThemeSignal) => s.symbol.length > 0);
    } catch (err) {
      // Surface parse errors with context for observability (fixes #39)
      throw new Error(
        `Failed to parse agent response as JSON: ${errorMessage(err)}. Response: ${response.slice(0, 200)}`,
      );
    }

    return signals;
  }
}
