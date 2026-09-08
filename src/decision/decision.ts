/**
 * Decision model + Zod schema.
 *
 * A Decision represents a trading decision made by an agent (doom or kangbot).
 * Every decision is logged — whether or not it results in an executed trade.
 * The decision log is append-only (no updates or deletes).
 */

import { z } from "zod";

export const AgentSchema = z.string().min(1);
export type Agent = string;

export const ActionSchema = z.enum(["buy", "sell", "hold"]);
export type Action = z.infer<typeof ActionSchema>;

export const TradeModeSchema = z.enum(["sim", "live"]);
export type TradeMode = z.infer<typeof TradeModeSchema>;

/**
 * Market context snapshot at the time of decision.
 * Free-form JSON — agents can attach any relevant indicators, news, etc.
 */
export const MarketContextSchema = z
  .object({
    price: z.number().positive().optional(),
    volume: z.number().optional(),
    indicators: z.record(z.string(), z.unknown()).optional(),
    news: z.array(z.string()).optional(),
    notes: z.string().optional(),
  })
  .passthrough()
  .optional();

export type MarketContext = z.infer<typeof MarketContextSchema>;

/**
 * Full Decision schema — used for validation on create.
 */
export const DecisionSchema = z.object({
  id: z.string().uuid(),
  timestamp: z.string().datetime(),
  agent: AgentSchema,
  symbol: z.string().min(1).max(50),
  action: ActionSchema,
  quantity: z.number().positive(),
  priceAtDecision: z.number().positive(),
  rationale: z.string().min(1),
  confidence: z.number().int().min(1).max(10),
  mode: TradeModeSchema,
  marketContext: MarketContextSchema,
});

export type Decision = z.infer<typeof DecisionSchema>;

/**
 * Schema for the input to create a new decision.
 * The system generates `id`, `timestamp`, and `created_at` — the caller
 * provides the rest.
 */
export const CreateDecisionInputSchema = z.object({
  agent: AgentSchema,
  symbol: z.string().min(1).max(50),
  action: ActionSchema,
  quantity: z.number().positive(),
  priceAtDecision: z.number().positive(),
  rationale: z.string().min(1),
  confidence: z.number().int().min(1).max(10),
  mode: TradeModeSchema,
  marketContext: MarketContextSchema,
});

export type CreateDecisionInput = z.infer<typeof CreateDecisionInputSchema>;

/**
 * Filters for listing decisions.
 */
export const DecisionFilterSchema = z
  .object({
    agent: AgentSchema.optional(),
    symbol: z.string().optional(),
    action: ActionSchema.optional(),
    mode: TradeModeSchema.optional(),
    startDate: z.string().optional(),
    endDate: z.string().optional(),
    limit: z.number().int().min(1).max(1000).default(100),
    offset: z.number().int().min(0).default(0),
  })
  .optional();

export type DecisionFilter = z.infer<typeof DecisionFilterSchema>;

/**
 * Row shape as stored in SQLite (snake_case columns → camelCase via mapper).
 */
export interface DecisionRow {
  id: string;
  timestamp: string;
  agent: Agent;
  symbol: string;
  action: Action;
  quantity: number;
  price_at_decision: number;
  rationale: string;
  confidence: number;
  mode: TradeMode;
  market_context: string | null;
  created_at: string;
}

/**
 * Convert a SQLite row to a Decision object.
 */
export function rowToDecision(row: DecisionRow): Decision {
  return {
    id: row.id,
    timestamp: row.timestamp,
    agent: row.agent,
    symbol: row.symbol,
    action: row.action,
    quantity: row.quantity,
    priceAtDecision: row.price_at_decision,
    rationale: row.rationale,
    confidence: row.confidence,
    mode: row.mode,
    marketContext: row.market_context
      ? (JSON.parse(row.market_context) as MarketContext)
      : undefined,
  };
}