/**
 * Position tracking types and helpers.
 *
 * A Position represents a holding in the portfolio — whether from the
 * simulated exchange or a live executor. This module provides the
 * canonical types plus utility functions for computing P&L from
 * positions.
 */

import { z } from "zod";

// ── Types ──────────────────────────────────────────────────────

export const PositionSideSchema = z.enum(["long", "short"]);
export type PositionSide = z.infer<typeof PositionSideSchema>;

/**
 * A single position held in the portfolio.
 * Matches the shape returned by Executor.getPositions() but adds
 * fields needed for portfolio-level aggregation.
 */
export const PositionSchema = z.object({
  symbol: z.string().min(1),
  quantity: z.number().nonnegative(),
  avgEntryPrice: z.number().nonnegative(),
  side: PositionSideSchema,
  /** Current market price — may be null if unavailable */
  currentPrice: z.number().positive().nullable().optional(),
  /** Unrealized P&L for this position */
  unrealizedPnl: z.number().optional(),
  /** Market value of this position (quantity × currentPrice) */
  marketValue: z.number().optional(),
});
export type Position = z.infer<typeof PositionSchema>;

/**
 * Aggregated P&L breakdown for the portfolio.
 */
export interface PnL {
  /** Unrealized P&L from open positions */
  unrealized: number;
  /** Realized P&L from closed trades */
  realized: number;
  /** Total P&L (unrealized + realized) */
  total: number;
  /** Total P&L as a percentage of initial capital */
  totalPct: number;
  /** Unrealized P&L as a percentage of current equity */
  unrealizedPct: number;
}

// ── Helpers ─────────────────────────────────────────────────────

/**
 * Compute unrealized P&L for a single position.
 *
 * For long positions: (currentPrice - avgEntryPrice) × quantity
 * For short positions: (avgEntryPrice - currentPrice) × quantity
 *
 * Returns 0 if currentPrice is null/undefined.
 */
export function computeUnrealizedPnl(
  position: Pick<Position, "quantity" | "avgEntryPrice" | "side" | "currentPrice">,
): number {
  const price = position.currentPrice;
  if (price == null || price <= 0) return 0;

  const diff =
    position.side === "long" ? price - position.avgEntryPrice : position.avgEntryPrice - price;

  return diff * position.quantity;
}

/**
 * Compute market value for a single position.
 * Returns 0 if currentPrice is null/undefined.
 */
export function computeMarketValue(position: Pick<Position, "quantity" | "currentPrice">): number {
  const price = position.currentPrice;
  if (price == null || price <= 0) return 0;
  return position.quantity * price;
}

/**
 * Compute total exposure as a percentage of equity.
 * Exposure = sum of all position market values / total equity.
 *
 * @param positionsValue - sum of all position market values
 * @param equity - total portfolio equity (cash + positions value)
 * @returns exposure as a percentage (0-100+), 0 if equity is 0
 */
export function computeExposure(positionsValue: number, equity: number): number {
  if (equity <= 0) return 0;
  return (positionsValue / equity) * 100;
}

/**
 * Aggregate unrealized P&L across all positions.
 */
export function aggregateUnrealizedPnl(positions: Position[]): number {
  return positions.reduce((sum, p) => {
    const pnl = p.unrealizedPnl ?? computeUnrealizedPnl(p);
    return sum + pnl;
  }, 0);
}

/**
 * Aggregate market value across all positions.
 */
export function aggregateMarketValue(positions: Position[]): number {
  return positions.reduce((sum, p) => {
    const mv = p.marketValue ?? computeMarketValue(p);
    return sum + mv;
  }, 0);
}
