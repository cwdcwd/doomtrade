/**
 * Zod schemas for API request validation.
 *
 * Every API route validates its input against a schema here before
 * touching the database or executor. Invalid requests get a 400 with
 * the Zod error details.
 */

import { z } from "zod";

// ── Decision endpoints ─────────────────────────────────────────

export const CreateDecisionBodySchema = z.object({
  agent: z.enum(["doom", "kangbot"]),
  symbol: z.string().min(1).max(50),
  action: z.enum(["buy", "sell", "hold"]),
  quantity: z.number().positive(),
  priceAtDecision: z.number().positive(),
  rationale: z.string().min(1),
  confidence: z.number().int().min(1).max(10),
  mode: z.enum(["sim", "live"]),
  marketContext: z
    .object({
      price: z.number().positive().optional(),
      volume: z.number().optional(),
      indicators: z.record(z.string(), z.unknown()).optional(),
      news: z.array(z.string()).optional(),
      notes: z.string().optional(),
    })
    .passthrough()
    .optional(),
});
export type CreateDecisionBody = z.infer<typeof CreateDecisionBodySchema>;

export const ListDecisionsQuerySchema = z.object({
  agent: z.enum(["doom", "kangbot"]).optional(),
  symbol: z.string().optional(),
  action: z.enum(["buy", "sell", "hold"]).optional(),
  mode: z.enum(["sim", "live"]).optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListDecisionsQuery = z.infer<typeof ListDecisionsQuerySchema>;

// ── Trade endpoint ─────────────────────────────────────────────

export const ExecuteTradeBodySchema = z.object({
  decisionId: z.string().uuid(),
  orderType: z.enum(["market", "limit", "stop"]).default("market"),
  limitPrice: z.number().positive().optional(),
  stopPrice: z.number().positive().optional(),
});
export type ExecuteTradeBody = z.infer<typeof ExecuteTradeBodySchema>;

// ── Portfolio endpoints ─────────────────────────────────────────

export const PortfolioHistoryQuerySchema = z.object({
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(10000).default(1000),
});
export type PortfolioHistoryQuery = z.infer<typeof PortfolioHistoryQuerySchema>;

// ── Mode toggle ─────────────────────────────────────────────────

export const ToggleModeBodySchema = z.object({
  mode: z.enum(["sim", "live"]),
  confirm: z.boolean().default(false),
});
export type ToggleModeBody = z.infer<typeof ToggleModeBodySchema>;

// ── Trades query ────────────────────────────────────────────────

export const ListTradesQuerySchema = z.object({
  symbol: z.string().optional(),
  status: z.enum(["pending", "filled", "cancelled", "rejected"]).optional(),
  decisionId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListTradesQuery = z.infer<typeof ListTradesQuerySchema>;
