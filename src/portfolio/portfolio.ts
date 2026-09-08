/**
 * Portfolio module — real-time position tracking, P&L calculation,
 * and equity curve history.
 *
 * Works with any Executor implementation (SimulatedExchange, Alpaca,
 * CCXT). Pulls positions and balance via the executor interface,
 * computes P&L, and persists equity snapshots to the portfolio_history
 * table at each checkpoint.
 */

import { randomUUID } from "node:crypto";
import type { Database } from "../db/database.js";
import { execAll, execGet, execRun } from "../db/database.js";
import type { Executor, Position, Balance } from "../executor/executor.js";
import {
  type PnL,
  computeUnrealizedPnl,
  computeMarketValue,
  computeExposure,
  aggregateUnrealizedPnl,
  aggregateMarketValue,
} from "./positions.js";

// ── Types ──────────────────────────────────────────────────────

/**
 * Snapshot of the portfolio at a point in time.
 */
export interface PortfolioSnapshot {
  /** Total equity = cash + positions market value */
  equity: number;
  /** Available cash */
  cash: number;
  /** Sum of all position market values */
  positionsValue: number;
  /** Open positions (with enriched P&L data) */
  positions: Position[];
  /** Exposure as % of equity (0-100+) */
  exposurePct: number;
  /** Number of open positions */
  positionCount: number;
  /** Current trading mode */
  mode: "sim" | "live";
  /** Timestamp of the snapshot */
  timestamp: string;
}

/**
 * A single point on the equity curve.
 */
export interface EquityCurvePoint {
  timestamp: string;
  equity: number;
  cash: number;
  positionsValue: number;
  unrealizedPnl: number;
  realizedPnl: number;
}

/**
 * Row shape for the portfolio_history table.
 */
interface PortfolioHistoryRow {
  id: string;
  timestamp: string;
  equity: number;
  cash: number;
  positions_value: number;
  unrealized_pnl: number;
  realized_pnl: number;
  mode: string;
}

/**
 * Configuration for the Portfolio module.
 */
export interface PortfolioConfig {
  /** Trading mode — affects labeling in snapshots */
  mode: "sim" | "live";
  /** Initial capital — used for P&L percentage calculations */
  initialCapital: number;
}

// ── Portfolio Class ─────────────────────────────────────────────

export class Portfolio {
  private db: Database;
  private executor: Executor;
  private config: PortfolioConfig;

  constructor(db: Database, executor: Executor, config: PortfolioConfig) {
    this.db = db;
    this.executor = executor;
    this.config = config;
  }

  /**
   * Get a real-time snapshot of the portfolio.
   * Pulls current positions and balance from the executor.
   */
  async getSnapshot(): Promise<PortfolioSnapshot> {
    const [balance, positions] = await Promise.all([
      this.executor.getBalance(),
      this.executor.getPositions(),
    ]);

    const enrichedPositions = positions.map((p) => ({
      ...p,
      unrealizedPnl: p.unrealizedPnl ?? computeUnrealizedPnl(p),
      marketValue: p.marketValue ?? computeMarketValue(p),
    }));

    const positionsValue = aggregateMarketValue(enrichedPositions);
    const exposurePct = computeExposure(positionsValue, balance.equity);

    return {
      equity: balance.equity,
      cash: balance.cash,
      positionsValue,
      positions: enrichedPositions,
      exposurePct,
      positionCount: enrichedPositions.length,
      mode: this.config.mode,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Get P&L breakdown: unrealized (open positions) + realized (closed trades).
   *
   * Realized P&L is computed from the trades table — sum of realized_pnl
   * for all filled trades.
   */
  async getPnL(): Promise<PnL> {
    const balance = await this.executor.getBalance();
    const positions = await this.executor.getPositions();

    const unrealized = aggregateUnrealizedPnl(
      positions.map((p) => ({
        ...p,
        unrealizedPnl: p.unrealizedPnl ?? computeUnrealizedPnl(p),
      })),
    );

    const realized = await this.getTotalRealizedPnl();
    const total = unrealized + realized;
    const totalPct =
      this.config.initialCapital > 0 ? (total / this.config.initialCapital) * 100 : 0;
    const unrealizedPct = balance.equity > 0 ? (unrealized / balance.equity) * 100 : 0;

    return {
      unrealized,
      realized,
      total,
      totalPct,
      unrealizedPct,
    };
  }

  /**
   * Get the equity curve — history of portfolio equity over time.
   * Each point corresponds to a checkpoint (typically after each trade).
   *
   * @param options - Optional filtering by date range and limit
   */
  async getHistory(options?: {
    startDate?: string;
    endDate?: string;
    limit?: number;
  }): Promise<EquityCurvePoint[]> {
    const limit = options?.limit ?? 1000;
    const params: (string | number | null)[] = [];

    let where = "";
    const conditions: string[] = [];
    if (options?.startDate) {
      conditions.push("timestamp >= ?");
      params.push(options.startDate);
    }
    if (options?.endDate) {
      conditions.push("timestamp <= ?");
      params.push(options.endDate);
    }
    if (conditions.length > 0) {
      where = " WHERE " + conditions.join(" AND ");
    }

    const rows = await execAll<PortfolioHistoryRow>(
      this.db,
      `SELECT * FROM portfolio_history${where} ORDER BY timestamp ASC LIMIT ?`,
      [...params, limit],
    );

    return rows.map(rowToEquityCurvePoint);
  }

  /**
   * Record a portfolio checkpoint — call after each trade to
   * build the equity curve. Persists the current snapshot to
   * the portfolio_history table.
   */
  async recordCheckpoint(): Promise<void> {
    const snapshot = await this.getSnapshot();
    const pnl = await this.getPnL();
    const id = randomUUID();

    await execRun(
      this.db,
      `INSERT INTO portfolio_history
        (id, timestamp, equity, cash, positions_value, unrealized_pnl, realized_pnl, mode)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        snapshot.timestamp,
        snapshot.equity,
        snapshot.cash,
        snapshot.positionsValue,
        pnl.unrealized,
        pnl.realized,
        this.config.mode,
      ],
    );
  }

  /**
   * Get total realized P&L from the trades table.
   * Sums the realized_pnl column for all filled trades.
   */
  private async getTotalRealizedPnl(): Promise<number> {
    const row = await execGet<{ total: number }>(
      this.db,
      "SELECT COALESCE(SUM(realized_pnl), 0) AS total FROM trades WHERE status = 'filled'",
    );
    return row?.total ?? 0;
  }

  /**
   * Get the most recent equity snapshot from history, if any.
   * Useful for computing drawdown from peak.
   */
  async getPeakEquity(): Promise<number> {
    const row = await execGet<{ max_equity: number }>(
      this.db,
      "SELECT MAX(equity) AS max_equity FROM portfolio_history",
    );
    return row?.max_equity ?? 0;
  }

  /**
   * Get current open positions (thin wrapper around executor).
   */
  async getPositions(): Promise<Position[]> {
    return this.executor.getPositions();
  }
}

// ── Helpers ─────────────────────────────────────────────────────

function rowToEquityCurvePoint(row: PortfolioHistoryRow): EquityCurvePoint {
  return {
    timestamp: row.timestamp,
    equity: row.equity,
    cash: row.cash,
    positionsValue: row.positions_value,
    unrealizedPnl: row.unrealized_pnl,
    realizedPnl: row.realized_pnl,
  };
}
