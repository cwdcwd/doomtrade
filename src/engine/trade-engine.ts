/**
 * Trade engine — the orchestrator.
 *
 * Takes a Decision from the Decision Log, runs pre-trade risk checks,
 * routes to the right executor (sim or live), and logs the result to SQLite.
 */

import type { Database as DatabaseType } from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type {
  Balance,
  Executor,
  OrderRequest,
  OrderResult,
  Position,
} from "../executor/executor.js";
import type { Decision } from "../decision/decision.js";

// ── Types ───────────────────────────────────────────────────

export interface RiskConfig {
  maxOpenPositions: number;
  maxPositionSizePct: number;
  dailyTradeLimit: number;
  maxDrawdownPct: number;
  duplicateOrderWindowMs: number;
}

const DEFAULT_RISK_CONFIG: RiskConfig = {
  maxOpenPositions: 10,
  maxPositionSizePct: 0.2,
  dailyTradeLimit: 20,
  maxDrawdownPct: 0.15,
  duplicateOrderWindowMs: 60_000,
};

export interface Executors {
  simulated: Executor;
  alpaca?: Executor;
  ccxt?: Executor;
}

export interface TradeResult {
  tradeId: string;
  decisionId: string;
  status: "filled" | "pending" | "rejected" | "skipped";
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  fillPrice: number | null;
  fee: number;
  realizedPnl: number;
  error?: string;
  mode: "sim" | "live";
  executor: string;
  portfolioSnapshot: {
    cash: number;
    equity: number;
    positions: Position[];
  };
  timestamp: string;
}

export interface TradeRow {
  id: string;
  decision_id: string;
  timestamp: string;
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  order_type: "market" | "limit" | "stop";
  fill_price: number | null;
  status: "pending" | "filled" | "cancelled" | "rejected" | "skipped";
  fee: number;
  realized_pnl: number;
  mode: "sim" | "live";
  executor: string;
  error: string | null;
  created_at: string;
}

export interface TradeFilter {
  symbol?: string;
  mode?: "sim" | "live";
  startDate?: string;
  endDate?: string;
  limit?: number;
  offset?: number;
}

// ── Custom error ────────────────────────────────────────────

export class RiskCheckError extends Error {
  readonly check: string;

  constructor(check: string, message: string) {
    super(message);
    this.name = "RiskCheckError";
    this.check = check;
  }
}

// ── Helpers ─────────────────────────────────────────────────

export function isCrypto(symbol: string): boolean {
  return symbol.includes("/");
}

// ── TradeEngine ─────────────────────────────────────────────

export class TradeEngine {
  private db: DatabaseType;
  private mode: "sim" | "live";
  private executors: Executors;
  private riskConfig: RiskConfig;

  constructor(opts: {
    db: DatabaseType;
    mode: "sim" | "live";
    executors: Executors;
    riskConfig?: Partial<RiskConfig>;
  }) {
    this.db = opts.db;
    this.mode = opts.mode;
    this.executors = opts.executors;
    this.riskConfig = { ...DEFAULT_RISK_CONFIG, ...opts.riskConfig };
  }

  async execute(decision: Decision): Promise<TradeResult> {
    // 1. Hold → skip
    if (decision.action === "hold") {
      return this.skippedResult(decision);
    }

    const side = decision.action; // "buy" | "sell"
    const executor = this.routeExecutor(decision.symbol);

    // 2. Pre-trade risk checks (throw on violation)
    await this.runRiskChecks(decision, side, executor);

    // 3. Build the order request
    const order: OrderRequest = {
      symbol: decision.symbol,
      side,
      quantity: decision.quantity,
      orderType: "market",
      clientOrderId: decision.id,
    };

    // 4. Place the order
    let orderResult: OrderResult;
    try {
      orderResult = await executor.placeOrder(order);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      return this.recordTrade(decision, {
        id: randomUUID(),
        clientOrderId: decision.id,
        symbol: decision.symbol,
        side,
        orderType: "market",
        quantity: decision.quantity,
        fillPrice: null,
        status: "rejected",
        fee: 0,
        realizedPnl: 0,
        error: errorMsg,
        timestamp: new Date().toISOString(),
      }, executor);
    }

    // 5. Record trade in SQLite + build result
    return this.recordTrade(decision, orderResult, executor);
  }

  // ── Routing ──────────────────────────────────────────────

  private routeExecutor(symbol: string): Executor {
    if (this.mode === "sim") {
      return this.executors.simulated;
    }

    // live mode
    if (isCrypto(symbol)) {
      if (!this.executors.ccxt) {
        throw new RiskCheckError(
          "executor_missing",
          `No ccxt executor configured for crypto symbol ${symbol}`,
        );
      }
      return this.executors.ccxt;
    }

    if (!this.executors.alpaca) {
      throw new RiskCheckError(
        "executor_missing",
        `No alpaca executor configured for stock symbol ${symbol}`,
      );
    }
    return this.executors.alpaca;
  }

  // ── Risk checks ──────────────────────────────────────────

  private async runRiskChecks(
    decision: Decision,
    side: "buy" | "sell",
    executor: Executor,
  ): Promise<void> {
    const balance = await executor.getBalance();
    const positions = await executor.getPositions();

    // Daily trade limit
    const dailyCount = this.getDailyTradeCount();
    if (dailyCount >= this.riskConfig.dailyTradeLimit) {
      throw new RiskCheckError(
        "daily_trade_limit",
        `Daily trade limit reached: ${dailyCount}/${this.riskConfig.dailyTradeLimit}`,
      );
    }

    // Max drawdown
    const drawdown = this.calculateDrawdown(balance);
    if (drawdown > this.riskConfig.maxDrawdownPct) {
      throw new RiskCheckError(
        "max_drawdown",
        `Max drawdown exceeded: ${(drawdown * 100).toFixed(2)}% > ${(this.riskConfig.maxDrawdownPct * 100).toFixed(2)}%`,
      );
    }

    // Max open positions (only for new positions — buys that don't already have a position)
    const existingPosition = positions.find((p) => p.symbol === decision.symbol);
    const isNewPosition = side === "buy" && !existingPosition;
    if (isNewPosition && positions.length >= this.riskConfig.maxOpenPositions) {
      throw new RiskCheckError(
        "max_open_positions",
        `Max open positions reached: ${positions.length}/${this.riskConfig.maxOpenPositions}`,
      );
    }

    // Max position size (order notional vs portfolio equity)
    const notional = decision.priceAtDecision * decision.quantity;
    if (
      balance.equity > 0 &&
      notional / balance.equity > this.riskConfig.maxPositionSizePct
    ) {
      throw new RiskCheckError(
        "max_position_size",
        `Position size ${(notional / balance.equity * 100).toFixed(2)}% exceeds max ${(this.riskConfig.maxPositionSizePct * 100).toFixed(2)}%`,
      );
    }

    // Duplicate order
    if (this.isDuplicateOrder(decision.symbol, side)) {
      throw new RiskCheckError(
        "duplicate_order",
        `Duplicate order for ${decision.symbol} ${side} within ${this.riskConfig.duplicateOrderWindowMs}ms`,
      );
    }
  }

  private calculateDrawdown(balance: Balance): number {
    if (balance.peakEquity <= 0) return 0;
    return (balance.peakEquity - balance.equity) / balance.peakEquity;
  }

  private isDuplicateOrder(symbol: string, side: "buy" | "sell"): boolean {
    const windowMs = this.riskConfig.duplicateOrderWindowMs;
    const cutoff = new Date(Date.now() - windowMs).toISOString();
    const row = this.db
      .prepare(
        `SELECT id FROM trades
         WHERE symbol = ? AND side = ? AND timestamp >= ?
         AND status IN ('filled', 'pending')
         ORDER BY timestamp DESC LIMIT 1`,
      )
      .get(symbol, side, cutoff) as { id: string } | undefined;
    return !!row;
  }

  // ── Trade recording ──────────────────────────────────────

  private async recordTrade(
    decision: Decision,
    result: OrderResult,
    executor: Executor,
  ): Promise<TradeResult> {
    const tradeId = randomUUID();
    const timestamp = result.timestamp;
    const executorName = executor.name;

    // Map OrderStatus → TradeResult status (cancelled maps to rejected)
    const tradeStatus: TradeResult["status"] =
      result.status === "cancelled" ? "rejected" : result.status;

    this.db
      .prepare(
        `INSERT INTO trades
           (id, decision_id, timestamp, symbol, side, quantity, order_type,
            fill_price, status, fee, realized_pnl, mode, executor, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        tradeId,
        decision.id,
        timestamp,
        decision.symbol,
        result.side,
        result.quantity,
        result.orderType === "stop" ? "stop" : result.orderType,
        result.fillPrice,
        result.status,
        result.fee,
        result.realizedPnl,
        this.mode,
        executorName,
        result.error ?? null,
      );

    // Build portfolio snapshot from the executor's current state
    const balance = await executor.getBalance();
    const positions = await executor.getPositions();

    return {
      tradeId,
      decisionId: decision.id,
      status: tradeStatus,
      symbol: decision.symbol,
      side: result.side,
      quantity: result.quantity,
      fillPrice: result.fillPrice,
      fee: result.fee,
      realizedPnl: result.realizedPnl,
      error: result.error,
      mode: this.mode,
      executor: executorName,
      portfolioSnapshot: {
        cash: balance.cash,
        equity: balance.equity,
        positions,
      },
      timestamp,
    };
  }

  private skippedResult(decision: Decision): TradeResult {
    return {
      tradeId: randomUUID(),
      decisionId: decision.id,
      status: "skipped",
      symbol: decision.symbol,
      side: "buy",
      quantity: decision.quantity,
      fillPrice: null,
      fee: 0,
      realizedPnl: 0,
      mode: this.mode,
      executor: "none",
      portfolioSnapshot: { cash: 0, equity: 0, positions: [] },
      timestamp: new Date().toISOString(),
    };
  }

  // ── Query helpers ────────────────────────────────────────

  getDailyTradeCount(): number {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const startIso = todayStart.toISOString();

    const row = this.db
      .prepare(
        `SELECT COUNT(*) as count FROM trades
         WHERE timestamp >= ? AND status IN ('filled', 'pending')`,
      )
      .get(startIso) as { count: number };
    return row.count;
  }

  getTrades(filter?: TradeFilter): TradeRow[] {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (filter?.symbol) {
      conditions.push("symbol = ?");
      params.push(filter.symbol);
    }
    if (filter?.mode) {
      conditions.push("mode = ?");
      params.push(filter.mode);
    }
    if (filter?.startDate) {
      conditions.push("timestamp >= ?");
      params.push(filter.startDate);
    }
    if (filter?.endDate) {
      conditions.push("timestamp <= ?");
      params.push(filter.endDate);
    }

    const limit = filter?.limit ?? 100;
    const offset = filter?.offset ?? 0;

    let sql = "SELECT * FROM trades";
    if (conditions.length > 0) {
      sql += " WHERE " + conditions.join(" AND ");
    }
    sql += " ORDER BY timestamp DESC LIMIT ? OFFSET ?";
    params.push(limit, offset);

    return this.db.prepare(sql).all(...params) as TradeRow[];
  }
}