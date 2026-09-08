/**
 * Allocation enforcement helper for theme strategies.
 *
 * Checks whether a proposed buy would exceed the theme's
 * maxTotalAllocationPct limit (max % of equity across all positions).
 */

import type { Position } from "../executor/executor.js";

/**
 * Check if a proposed buy is within the theme's total allocation limit.
 *
 * @param positions Current open positions (only those with quantity > 0)
 * @param equity Current sub-account equity
 * @param config.maxTotalAllocationPct Max % of equity for total exposure
 * @param config.maxAllocationPct Max % of equity for a single position
 * @param buyValue The proposed buy's total value (qty * price)
 * @returns true if the buy is within limits, false if it would exceed
 */
export function isWithinAllocationLimit(
  positions: Position[],
  equity: number,
  maxTotalAllocationPct: number,
  maxAllocationPct: number,
  buyValue: number,
): { allowed: boolean; reason?: string } {
  if (equity <= 0) {
    return { allowed: false, reason: "No equity available" };
  }

  // Check single-position limit (allow equality — boundary case)
  const maxPerPosition = equity * (maxAllocationPct / 100);
  if (buyValue > maxPerPosition + 0.01) {
    return {
      allowed: false,
      reason: `Buy value $${buyValue.toFixed(2)} exceeds max position size $${maxPerPosition.toFixed(2)} (${maxAllocationPct}% of equity)`,
    };
  }

  // Check total allocation limit (fixes #37)
  const currentExposure = positions
    .filter((p) => p.quantity > 0)
    .reduce((sum, p) => sum + p.quantity * p.avgEntryPrice, 0);
  const maxTotalExposure = equity * (maxTotalAllocationPct / 100);
  const newTotalExposure = currentExposure + buyValue;

  if (newTotalExposure > maxTotalExposure + 0.01) {
    return {
      allowed: false,
      reason: `Total exposure $${newTotalExposure.toFixed(2)} would exceed max total allocation $${maxTotalExposure.toFixed(2)} (${maxTotalAllocationPct}% of equity)`,
    };
  }

  return { allowed: true };
}