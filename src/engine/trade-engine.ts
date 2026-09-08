/**
 * Trade engine — the orchestrator.
 *
 * Takes a decision from the Decision Log, runs pre-trade risk checks,
 * routes to the appropriate executor (sim or live), and logs the
 * resulting trade to the trades table.
 *
 * Risk checks enforced before any order is placed:
 *  - Max open positions (default 10)
 *  - Max position size as % of equity (default 20%)
 *  - Daily trade limit (default 20 trades/day)
 *  - Max drawdown (default 15%) — blocks new trades if exceeded
 *
 * The engine is executor-agnostic: it receives an Executor instance
 * and delegates order placement. This lets the same engine work with
 * the SimulatedExchange (paper) or live executors (Alpaca, CCXT).
 */

import { randomUUID } from "node:crypto";
import type { Database } from "../db/database.js";
import { execGet, execAll, execRun } from "../db/database.js";
import type { Executor, OrderRequest, OrderResult, Position } from "../executor/executor.js";
import type { Config } from "../config.js";
import type { Decision } from "../decision/decision.js";

// ── Types ──────────────────────────────────────────────────────

export interface ExecuteDecisionInput {
  decision: Decision;
  orderType?: "market" | "limit" | "stop";
  limitPrice?: number;
  stopPrice?: number;
}

/** Optional price provider — when set, market orders auto-fetch the current price. */
export interface PriceProvider {
  getQuote(symbol: string): Promise<number>;
}

export interface TradeRecord {
  id: string;
  decisionId: string;
  timestamp: string;
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  orderType: "market" | "limit" | "stop";
  fillPrice: number | null;
  status: "pending" | "filled" | "cancelled" | "rejected";
  fee: number;
  realizedPnl: number;
  mode: "sim" | "live";
  executor: string;
  error: string | null;
}

export interface RiskCheckResult {
  passed: boolean;
  reason?: string;
  check: string;
}

export interface ExecuteResult {
  decision: Decision;
  riskChecks: RiskCheckResult[];
  orderResult: OrderResult | null;
  tradeRecord: TradeRecord | null;
  riskPassed: boolean;
}

export interface TradeAnalytics {
  tradeCount: number;
  filledCount: number;
  pendingCount: number;
  rejectedCount: number;
  cancelledCount: number;
  winLoss: {
    wins: number;
    losses: number;
    breakeven: number;
    totalClosed: number;
    winRate: number;
  };
  pnl: {
    totalRealized: number;
    totalFees: number;
    netPnl: number;
    grossProfit: number;
    grossLoss: number;
    avgWin: number;
    avgLoss: number;
    profitFactor: number;
  };
  equity: {
    startEquity: number;
    endEquity: number;
    maxEquity: number;
    minEquity: number;
    drawdownPct: number;
  };
}

// ── Helpers ─────────────────────────────────────────────────────

interface TradeRow {
  id: string;
  decision_id: string;
  timestamp: string;
  symbol: string;
  side: string;
  quantity: number;
  order_type: string;
  fill_price: number | null;
  status: string;
  fee: number;
  realized_pnl: number;
  mode: string;
  executor: string;
  error: string | null;
}

function rowToTradeRecord(row: TradeRow): TradeRecord {
  return {
    id: row.id,
    decisionId: row.decision_id,
    timestamp: row.timestamp,
    symbol: row.symbol,
    side: row.side as TradeRecord["side"],
    quantity: row.quantity,
    orderType: row.order_type as TradeRecord["orderType"],
    fillPrice: row.fill_price,
    status: row.status as TradeRecord["status"],
    fee: row.fee,
    realizedPnl: row.realized_pnl,
    mode: row.mode as TradeRecord["mode"],
    executor: row.executor,
    error: row.error,
  };
}

/**
 * Get today's date as YYYY-MM-DD in local time for daily limit counting.
 */
function todayDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

// ── Trade Engine ────────────────────────────────────────────────

export class TradeEngine {
  private db: Database;
  private executor: Executor;
  private config: Pick<
    Config,
    "tradeMode" | "maxOpenPositions" | "maxPositionSizePct" | "dailyTradeLimit" | "maxDrawdownPct"
  >;
  private priceProvider?: PriceProvider;

  constructor(
    db: Database,
    executor: Executor,
    config: Pick<
      Config,
      "tradeMode" | "maxOpenPositions" | "maxPositionSizePct" | "dailyTradeLimit" | "maxDrawdownPct"
    >,
    priceProvider?: PriceProvider,
  ) {
    this.db = db;
    this.executor = executor;
    this.config = config;
    this.priceProvider = priceProvider;
  }

  /**
   * Execute a decision: run risk checks → place order → log trade.
   * Returns the full result including risk check outcomes.
   */
  async executeDecision(input: ExecuteDecisionInput): Promise<ExecuteResult> {
    const { decision } = input;
    const orderType = input.orderType ?? "market";

    // Auto-fetch market price for market orders when no limitPrice is provided
    let limitPrice = input.limitPrice;
    if (orderType === "market" && !limitPrice && this.priceProvider) {
      try {
        const quote = await this.priceProvider.getQuote(decision.symbol);
        limitPrice = quote;
      } catch (err) {
        // Fall back to priceAtDecision from the decision log
        limitPrice = decision.priceAtDecision > 0 ? decision.priceAtDecision : undefined;
      }
    } else if (orderType === "market" && !limitPrice) {
      // No price provider — fall back to priceAtDecision
      limitPrice = decision.priceAtDecision > 0 ? decision.priceAtDecision : undefined;
    }

    // Build the order request
    const order: OrderRequest = {
      symbol: decision.symbol,
      side: decision.action === "hold" ? "buy" : decision.action, // hold won't trade
      quantity: decision.quantity,
      orderType,
      limitPrice,
      stopPrice: input.stopPrice,
      clientOrderId: decision.id,
    };

    // Hold decisions don't trade — early return without risk checks
    if (decision.action === "hold") {
      return {
        decision,
        riskChecks: [],
        orderResult: null,
        tradeRecord: null,
        riskPassed: true,
      };
    }

    // Run pre-trade risk checks
    const riskChecks = await this.runRiskChecks(decision);
    const riskPassed = riskChecks.every((c) => c.passed);

    if (!riskPassed) {
      // Log a rejected trade
      const trade = await this.logTrade({
        decisionId: decision.id,
        symbol: decision.symbol,
        side: decision.action as "buy" | "sell",
        quantity: decision.quantity,
        orderType,
        fillPrice: null,
        status: "rejected",
        fee: 0,
        realizedPnl: 0,
        error: riskChecks.filter((c) => !c.passed).map((c) => `${c.check}: ${c.reason}`).join("; "),
      });

      return {
        decision,
        riskChecks,
        orderResult: null,
        tradeRecord: trade,
        riskPassed: false,
      };
    }

    // Place the order via executor
    const orderResult = await this.executor.placeOrder(order);

    // Log the trade
    const trade = await this.logTrade({
      decisionId: decision.id,
      symbol: decision.symbol,
      side: decision.action as "buy" | "sell",
      quantity: decision.quantity,
      orderType,
      fillPrice: orderResult.fillPrice,
      status: orderResult.status,
      fee: orderResult.fee,
      realizedPnl: orderResult.realizedPnl,
      error: orderResult.error ?? null,
    });

    return {
      decision,
      riskChecks,
      orderResult,
      tradeRecord: trade,
      riskPassed: true,
    };
  }

  // ── Risk checks ──────────────────────────────────────────────

  private async runRiskChecks(decision: Decision): Promise<RiskCheckResult[]> {
    const checks: RiskCheckResult[] = [];

    // 1. Max open positions (only for buy orders that open new positions)
    if (decision.action === "buy") {
      checks.push(await this.checkMaxOpenPositions(decision.symbol));
    }

    // 2. Max position size as % of equity
    if (decision.action === "buy") {
      checks.push(await this.checkMaxPositionSize(decision));
    }

    // 3. Daily trade limit
    checks.push(await this.checkDailyTradeLimit());

    // 4. Max drawdown
    checks.push(await this.checkMaxDrawdown());

    return checks;
  }

  /**
   * Check: max open positions.
   * If buying a new symbol (not adding to existing), count must be under limit.
   */
  private async checkMaxOpenPositions(symbol: string): Promise<RiskCheckResult> {
    const positions = await this.executor.getPositions();
    const hasPosition = positions.some((p) => p.symbol === symbol);

    if (hasPosition) {
      // Adding to existing position — doesn't open a new slot
      return { passed: true, check: "maxOpenPositions" };
    }

    if (positions.length >= this.config.maxOpenPositions) {
      return {
        passed: false,
        check: "maxOpenPositions",
        reason: `Max open positions reached (${positions.length}/${this.config.maxOpenPositions})`,
      };
    }

    return { passed: true, check: "maxOpenPositions" };
  }

  /**
   * Check: max position size as % of equity.
   * Notional of the order must not exceed maxPositionSizePct of current equity.
   */
  private async checkMaxPositionSize(decision: Decision): Promise<RiskCheckResult> {
    const balance = await this.executor.getBalance();
    const orderNotional = decision.quantity * decision.priceAtDecision;
    const maxNotional = balance.equity * (this.config.maxPositionSizePct / 100);

    if (orderNotional > maxNotional) {
      return {
        passed: false,
        check: "maxPositionSize",
        reason: `Order notional $${orderNotional.toFixed(2)} exceeds ${this.config.maxPositionSizePct}% of equity ($${maxNotional.toFixed(2)})`,
      };
    }

    return { passed: true, check: "maxPositionSize" };
  }

  /**
   * Check: daily trade limit.
   * Count of trades (excluding rejected) today must be under limit.
   */
  private async checkDailyTradeLimit(): Promise<RiskCheckResult> {
    const today = todayDateString();
    const row = await execGet<{ count: number }>(
      this.db,
      `SELECT COUNT(*) as count FROM trades
       WHERE date(timestamp) = date(?) AND status != 'rejected'`,
      [today],
    );

    const count = row?.count ?? 0;

    if (count >= this.config.dailyTradeLimit) {
      return {
        passed: false,
        check: "dailyTradeLimit",
        reason: `Daily trade limit reached (${count}/${this.config.dailyTradeLimit})`,
      };
    }

    return { passed: true, check: "dailyTradeLimit" };
  }

  /**
   * Check: max drawdown.
   * If current drawdown from peak equity exceeds limit, block new trades.
   */
  private async checkMaxDrawdown(): Promise<RiskCheckResult> {
    const balance = await this.executor.getBalance();

    if (balance.peakEquity <= 0) {
      return { passed: true, check: "maxDrawdown" };
    }

    const drawdownPct =
      ((balance.peakEquity - balance.equity) / balance.peakEquity) * 100;

    if (drawdownPct >= this.config.maxDrawdownPct) {
      return {
        passed: false,
        check: "maxDrawdown",
        reason: `Max drawdown exceeded: ${drawdownPct.toFixed(2)}% (limit ${this.config.maxDrawdownPct}%)`,
      };
    }

    return { passed: true, check: "maxDrawdown" };
  }

  // ── Trade logging ────────────────────────────────────────────

  private async logTrade(params: {
    decisionId: string;
    symbol: string;
    side: "buy" | "sell";
    quantity: number;
    orderType: "market" | "limit" | "stop";
    fillPrice: number | null;
    status: "pending" | "filled" | "cancelled" | "rejected";
    fee: number;
    realizedPnl: number;
    error: string | null;
  }): Promise<TradeRecord> {
    const id = randomUUID();
    const timestamp = new Date().toISOString();
    const executorName = this.executor.name as "simulated" | "alpaca" | "ccxt";

    await execRun(
      this.db,
      `INSERT INTO trades
         (id, decision_id, timestamp, symbol, side, quantity, order_type,
          fill_price, status, fee, realized_pnl, mode, executor, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        params.decisionId,
        timestamp,
        params.symbol,
        params.side,
        params.quantity,
        params.orderType,
        params.fillPrice,
        params.status,
        params.fee,
        params.realizedPnl,
        this.config.tradeMode,
        executorName,
        params.error,
      ],
    );

    const row = await execGet<TradeRow>(
      this.db,
      "SELECT * FROM trades WHERE id = ?",
      [id],
    );

    return row ? rowToTradeRecord(row) : this.logTrade(params); // shouldn't happen
  }

  // ── Query helpers ─────────────────────────────────────────────

  /**
   * Get a trade by ID.
   */
  async getTrade(id: string): Promise<TradeRecord | null> {
    const row = await execGet<TradeRow>(
      this.db,
      "SELECT * FROM trades WHERE id = ?",
      [id],
    );
    return row ? rowToTradeRecord(row) : null;
  }

  /**
   * List trades, optionally filtered by symbol, status, decision ID, or date range.
   * Returns most recent first.
   */
  async listTrades(filter?: {
    symbol?: string;
    status?: TradeRecord["status"];
    decisionId?: string;
    startDate?: string;
    endDate?: string;
    limit?: number;
    offset?: number;
  }): Promise<TradeRecord[]> {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (filter?.symbol) {
      conditions.push("symbol = ?");
      params.push(filter.symbol);
    }
    if (filter?.status) {
      conditions.push("status = ?");
      params.push(filter.status);
    }
    if (filter?.decisionId) {
      conditions.push("decision_id = ?");
      params.push(filter.decisionId);
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

    const rows = await execAll<TradeRow>(this.db, sql, params);
    return rows.map(rowToTradeRecord);
  }

  /**
   * Count trades today (excluding rejected).
   */
  async getDailyTradeCount(): Promise<number> {
    const today = todayDateString();
    const row = await execGet<{ count: number }>(
      this.db,
      `SELECT COUNT(*) as count FROM trades
       WHERE date(timestamp) = date(?) AND status != 'rejected'`,
      [today],
    );
    return row?.count ?? 0;
  }

  /**
   * Get all trades for a decision.
   */
  async getTradesForDecision(decisionId: string): Promise<TradeRecord[]> {
    return this.listTrades({ decisionId, limit: 1000 });
  }

  // ── Performance analytics ────────────────────────────────────

  /**
   * Compute aggregated performance analytics from the trades table
   * and portfolio_history equity curve.
   *
   * Optional filters: symbol, startDate, endDate (applied to trades).
   */
  async getAnalytics(filter?: {
    symbol?: string;
    startDate?: string;
    endDate?: string;
  }): Promise<TradeAnalytics> {
    // Build WHERE clause for trade filters
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (filter?.symbol) {
      conditions.push("symbol = ?");
      params.push(filter.symbol);
    }
    if (filter?.startDate) {
      conditions.push("timestamp >= ?");
      params.push(filter.startDate);
    }
    if (filter?.endDate) {
      conditions.push("timestamp <= ?");
      params.push(filter.endDate);
    }

    const whereClause = conditions.length > 0
      ? " WHERE " + conditions.join(" AND ")
      : "";

    // ── Trade counts by status ──
    const countRows = await execAll<{ status: string; count: number }>(
      this.db,
      `SELECT status, COUNT(*) as count FROM trades${whereClause} GROUP BY status`,
      params,
    );

    let tradeCount = 0;
    let filledCount = 0;
    let pendingCount = 0;
    let rejectedCount = 0;
    let cancelledCount = 0;

    for (const row of countRows) {
      tradeCount += row.count;
      switch (row.status) {
        case "filled": filledCount = row.count; break;
        case "pending": pendingCount = row.count; break;
        case "rejected": rejectedCount = row.count; break;
        case "cancelled": cancelledCount = row.count; break;
      }
    }

    // ── Win/Loss and P&L from filled trades ──
    const filledConditions = [...conditions];
    const filledParams = [...params];
    filledConditions.push("status = 'filled'");
    const filledWhere = " WHERE " + filledConditions.join(" AND ");

    const pnlRows = await execAll<{
      realized_pnl: number;
      fee: number;
    }>(this.db, `SELECT realized_pnl, fee FROM trades${filledWhere}`, filledParams);

    let wins = 0;
    let losses = 0;
    let breakeven = 0;
    let totalRealized = 0;
    let totalFees = 0;
    let grossProfit = 0;
    let grossLoss = 0;

    for (const row of pnlRows) {
      const pnl = row.realized_pnl;
      totalRealized += pnl;
      totalFees += row.fee;

      if (pnl > 0) {
        wins++;
        grossProfit += pnl;
      } else if (pnl < 0) {
        losses++;
        grossLoss += pnl;
      } else {
        breakeven++;
      }
    }

    const totalClosed = wins + losses + breakeven;
    const winRate = totalClosed > 0 ? (wins / totalClosed) * 100 : 0;
    const netPnl = totalRealized - totalFees;
    const avgWin = wins > 0 ? grossProfit / wins : 0;
    const avgLoss = losses > 0 ? grossLoss / losses : 0;
    const profitFactor = grossLoss !== 0
      ? grossProfit / Math.abs(grossLoss)
      : grossProfit > 0
        ? Infinity
        : 0;

    // ── Equity curve from portfolio_history ──
    const equityConditions: string[] = [];
    const equityParams: (string | number)[] = [];

    if (filter?.startDate) {
      equityConditions.push("timestamp >= ?");
      equityParams.push(filter.startDate);
    }
    if (filter?.endDate) {
      equityConditions.push("timestamp <= ?");
      equityParams.push(filter.endDate);
    }

    const equityWhere = equityConditions.length > 0
      ? " WHERE " + equityConditions.join(" AND ")
      : "";

    const equityRows = await execAll<{ equity: number }>(
      this.db,
      `SELECT equity FROM portfolio_history${equityWhere} ORDER BY timestamp ASC`,
      equityParams,
    );

    let startEquity = 0;
    let endEquity = 0;
    let maxEquity = 0;
    let minEquity = 0;
    let drawdownPct = 0;

    if (equityRows.length > 0) {
      startEquity = equityRows[0].equity;
      endEquity = equityRows[equityRows.length - 1].equity;
      maxEquity = Math.max(...equityRows.map((r) => r.equity));
      minEquity = Math.min(...equityRows.map((r) => r.equity));

      if (maxEquity > 0) {
        drawdownPct = ((maxEquity - minEquity) / maxEquity) * 100;
      }
    }

    return {
      tradeCount,
      filledCount,
      pendingCount,
      rejectedCount,
      cancelledCount,
      winLoss: {
        wins,
        losses,
        breakeven,
        totalClosed,
        winRate,
      },
      pnl: {
        totalRealized,
        totalFees,
        netPnl,
        grossProfit,
        grossLoss,
        avgWin,
        avgLoss,
        profitFactor,
      },
      equity: {
        startEquity,
        endEquity,
        maxEquity,
        minEquity,
        drawdownPct,
      },
    };
  }
}