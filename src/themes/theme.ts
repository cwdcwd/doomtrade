/**
 * Core type definitions for the experimental themes feature.
 *
 * A "theme" is an independently-configured, self-contained trading strategy
 * instance that runs on its own schedule, manages its own allocation, and
 * reports its own performance. Themes are designed for rapid experimentation:
 * spin up a new strategy variant, give it a slice of capital, and compare
 * results side-by-side.
 *
 * @see docs/EXPERIMENTAL_THEMES_DESIGN.md
 */

import type { Decision } from "../decision/decision.js";
import type { TradeRecord } from "../engine/trade-engine.js";

// ── Signal ──────────────────────────────────────────────────────

/**
 * A single trading signal emitted by a theme's signal source.
 *
 * Signals are the raw output of a strategy's analysis — they describe *what*
 * the strategy wants to do, not *what will be done*. The theme's decision
 * layer converts signals into {@link Decision} records after applying risk
 * checks and allocation constraints.
 */
export interface ThemeSignal {
  /** Ticker / instrument symbol, e.g. "AAPL" or "BTC-USD". */
  symbol: string;
  /** Recommended action. */
  action: "buy" | "sell" | "hold";
  /** Optional suggested quantity (units). The decision layer may override. */
  suggestedQuantity?: number;
  /** Optional price at the time the signal was generated. */
  priceAtSignal?: number;
  /** Optional free-form metadata from the signal source. */
  metadata?: Record<string, unknown>;
  /** Human-readable explanation of why the signal was emitted. */
  reason: string;
}

// ── Schedule ────────────────────────────────────────────────────

/**
 * Evaluation schedule for a theme instance.
 *
 * - `cron`      — a standard cron expression (evaluated by the scheduler).
 * - `interval`  — a fixed interval between evaluations, in milliseconds.
 * - `manual`    — the theme is never auto-evaluated; it must be triggered by
 *                 an explicit API call or operator action.
 */
export type ThemeSchedule =
  | { type: "cron"; expression: string }
  | { type: "interval"; milliseconds: number }
  | { type: "manual" };

// ── Config ──────────────────────────────────────────────────────

/**
 * Configuration for a single theme instance.
 *
 * A theme config fully describes how a strategy should run: its identity,
 * execution mode, cadence, capital constraints, and strategy-specific
 * parameters. Configs are persisted and can be hot-reloaded.
 */
export interface ThemeConfig {
  /** Unique identifier for this theme instance. */
  id: string;
  /** Human-readable display name. */
  name: string;
  /** Strategy module key, e.g. "momentum" or "mean-reversion". */
  strategy: string;
  /** Execution mode: "sim" for paper trading, "live" for real orders. */
  mode: "sim" | "live";
  /** When and how often the theme should be evaluated. */
  schedule: ThemeSchedule;
  /** Max % of total portfolio equity this theme may allocate to a single position. */
  maxAllocationPct: number;
  /** Max % of total portfolio equity this theme may hold across all positions. */
  maxTotalAllocationPct: number;
  /** Maximum number of concurrently open positions. */
  maxPositions: number;
  /** Strategy-specific parameters passed to the strategy module. */
  params: Record<string, unknown>;
  /** Whether this theme is currently enabled. */
  enabled: boolean;
  /** Capital currently allocated to this theme, in account currency. Defaults to 0. */
  allocatedCapital: number;
}

// ── Evaluation Result ───────────────────────────────────────────

/**
 * Result of a single theme evaluation cycle.
 *
 * Captured every time the scheduler (or a manual trigger) runs a theme's
 * strategy. Contains the raw signals produced, the decisions that were
 * derived from them, any trades that were placed, and any errors encountered.
 */
export interface ThemeEvaluationResult {
  /** ID of the theme that was evaluated. */
  themeId: string;
  /** ISO-8601 timestamp of the evaluation cycle. */
  timestamp: string;
  /** Raw signals emitted by the strategy. */
  signals: ThemeSignal[];
  /** Decisions derived from the signals (after risk checks). */
  decisions: Decision[];
  /** Trade records created during this cycle (if any). */
  trades: TradeRecord[];
  /** Non-fatal errors or warnings logged during the cycle. */
  errors: string[];
}

// ── Performance ─────────────────────────────────────────────────

/**
 * Per-theme performance metrics.
 *
 * Tracks the financial health of a single theme instance over its lifetime.
 * Updated after every evaluation cycle or trade fill.
 */
export interface ThemePerformance {
  /** ID of the theme these metrics belong to. */
  themeId: string;
  /** Display name of the theme (denormalized for convenience). */
  name: string;
  /** Starting balance when the theme was activated. */
  startingBalance: number;
  /** Current account balance attributable to this theme. */
  currentBalance: number;
  /** Highest balance ever reached by this theme. */
  peakBalance: number;
  /** Current drawdown from peak, as a percentage (0–100). */
  drawdownPct: number;
  /** Total number of trade attempts (filled + unfilled). */
  totalTrades: number;
  /** Number of trades that were successfully filled. */
  filledTrades: number;
  /** Win rate — fraction of closed trades that were profitable (0–1). */
  winRate: number;
  /** Total realized profit/loss in account currency. */
  realizedPnl: number;
  /** Number of currently open positions. */
  openPositions: number;
  /** Operational status of the theme. */
  status: "active" | "paused" | "stopped";
}