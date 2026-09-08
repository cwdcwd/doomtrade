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

// ── Theme endpoints ─────────────────────────────────────────────

export const CreateThemeBodySchema = z.object({
  name: z.string().min(1).max(200),
  strategy: z.string().min(1),
  mode: z.enum(["sim", "live"]).default("sim"),
  schedule: z.object({
    type: z.enum(["cron", "interval", "manual"]),
    expression: z.string().optional(),
    milliseconds: z.number().int().positive().optional(),
  }).refine(
    (data) => {
      if (data.type === "cron") return !!data.expression;
      if (data.type === "interval") return !!data.milliseconds;
      return true;
    },
    { message: "cron requires expression, interval requires milliseconds" }
  ),
  maxAllocationPct: z.number().positive().max(100).default(5),
  maxTotalAllocationPct: z.number().positive().max(100).default(40),
  maxPositions: z.number().int().positive().default(10),
  allocatedCapital: z.number().nonnegative().default(0),
  params: z.record(z.string(), z.unknown()).default({}),
  enabled: z.boolean().default(true),
});
export type CreateThemeBody = z.infer<typeof CreateThemeBodySchema>;

export const UpdateThemeBodySchema = z.object({
  name: z.string().min(1).max(200).optional(),
  mode: z.enum(["sim", "live"]).optional(),
  schedule: z.object({
    type: z.enum(["cron", "interval", "manual"]),
    expression: z.string().optional(),
    milliseconds: z.number().int().positive().optional(),
  }).optional(),
  maxAllocationPct: z.number().positive().max(100).optional(),
  maxTotalAllocationPct: z.number().positive().max(100).optional(),
  maxPositions: z.number().int().positive().optional(),
  allocatedCapital: z.number().nonnegative().optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  enabled: z.boolean().optional(),
});
export type UpdateThemeBody = z.infer<typeof UpdateThemeBodySchema>;

export const ListThemesQuerySchema = z.object({
  strategy: z.string().optional(),
  enabled: z.enum(["true", "false"]).optional(),
});
export type ListThemesQuery = z.infer<typeof ListThemesQuerySchema>;
