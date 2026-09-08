/**
 * AgentExchange — per-agent simulated trading executor.
 *
 * One instance per agent. All DB queries are scoped by agent_id.
 * Reuses the price resolution logic from SimulatedExchange:
 *   price provider → limitPrice fallback → stale cache.
 *
 * Supports market and limit orders, tracks positions, computes P&L,
 * deducts fees, persists to agent_balance / agent_positions / agent_orders.
 */

import { randomUUID } from "node:crypto";
import type { Database } from "../db/database.js";
import { execAll, execGet, execRun, convertPlaceholders } from "../db/database.js";
import type {
  Balance,
  Executor,
  OrderRequest,
  OrderResult,
  OrderStatus,
  Position,
} from "./executor.js";

export interface AgentExchangeConfig {
  /** Agent ID this exchange belongs to */
  agentId: string;
  /** Starting cash balance */
  startingBalance: number;
  /** Fee per trade as a fraction (e.g., 0.001 = 0.1%) */
  feeRate?: number;
  /** Slippage simulation as a fraction (e.g., 0.0005 = 0.05%) */
  slippageRate?: number;
  /** Price provider function — returns current market price for a symbol */
  getCurrentPrice?: (symbol: string) => number | null;
}

interface AgentPositionRow {
  agent_id: string;
  symbol: string;
  quantity: number;
  avg_entry_price: number;
  side: "long" | "short";
  updated_at: string;
}

interface AgentBalanceRow {
  agent_id: string;
  cash: number;
  initial_cash: number;
  peak_equity: number;
  updated_at: string;
}

export class AgentExchange implements Executor {
  readonly name = "agent-simulated";

  private db: Database;
  private agentId: string;
  private startingBalance: number;
  private feeRate: number;
  private slippageRate: number;
  private getCurrentPrice: (symbol: string) => number | null;
  private priceCache: Map<string, number> = new Map();
  private initialized: Promise<void>;

  constructor(db: Database, config: AgentExchangeConfig) {
    this.db = db;
    this.agentId = config.agentId;
    this.startingBalance = config.startingBalance;
    this.feeRate = config.feeRate ?? 0.001;
    this.slippageRate = config.slippageRate ?? 0;
    this.getCurrentPrice = config.getCurrentPrice ?? (() => null);
    this.initialized = this.initBalance();
  }

  private async ready(): Promise<void> {
    await this.initialized;
  }

  // ── Public API (Executor interface) ────────────────────────────

  async placeOrder(order: OrderRequest): Promise<OrderResult> {
    await this.ready();
    const timestamp = new Date().toISOString();
    const id = randomUUID();

    if (order.quantity <= 0) {
      return this.reject(id, order, "Quantity must be positive", timestamp);
    }

    if (order.orderType === "limit" && !order.limitPrice) {
      return this.reject(id, order, "Limit orders require a limitPrice", timestamp);
    }

    return this.fillOrder(id, order, timestamp);
  }

  async cancelOrder(_id: string): Promise<boolean> {
    // Market orders fill immediately; nothing to cancel
    return false;
  }

  async getPositions(): Promise<Position[]> {
    await this.ready();
    const sql = convertPlaceholders(
      "SELECT * FROM agent_positions WHERE agent_id = ? AND quantity > 0",
      this.db.backend,
    );
    const rows = await execAll<AgentPositionRow>(this.db, sql, [this.agentId]);

    return rows.map((row) => {
      const currentPrice = this.resolvePrice(row.symbol, row.avg_entry_price);
      const marketValue = row.quantity * currentPrice;
      const unrealizedPnl = (currentPrice - row.avg_entry_price) * row.quantity;
      return {
        symbol: row.symbol,
        quantity: row.quantity,
        avgEntryPrice: row.avg_entry_price,
        side: row.side,
        unrealizedPnl,
        marketValue,
      };
    });
  }

  async getBalance(): Promise<Balance> {
    await this.ready();
    const row = await this.getBalanceRow();
    const positions = await this.getPositions();
    const positionsValue = positions.reduce((sum, p) => sum + (p.marketValue ?? 0), 0);
    const equity = row.cash + positionsValue;

    return {
      cash: row.cash,
      equity,
      initialCash: row.initial_cash,
      peakEquity: Math.max(row.peak_equity, equity),
    };
  }

  // ── Agent-specific methods ─────────────────────────────────────

  async getTrades(limit = 50): Promise<AgentOrderRow[]> {
    await this.ready();
    const sql = convertPlaceholders(
      "SELECT * FROM agent_orders WHERE agent_id = ? ORDER BY created_at DESC, id DESC LIMIT ?",
      this.db.backend,
    );
    return execAll<AgentOrderRow>(this.db, sql, [this.agentId, limit]);
  }

  async recordCheckpoint(): Promise<void> {
    await this.ready();
    const balance = await this.getBalance();
    const positions = await this.getPositions();
    const positionsValue = positions.reduce((sum, p) => sum + (p.marketValue ?? 0), 0);
    const unrealizedPnl = positions.reduce((sum, p) => sum + (p.unrealizedPnl ?? 0), 0);
    const realizedPnl = balance.cash - balance.initialCash;

    const sql = convertPlaceholders(
      `INSERT INTO agent_portfolio_history (id, agent_id, equity, cash, positions_value, unrealized_pnl, realized_pnl)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      this.db.backend,
    );
    await execRun(this.db, sql, [
      randomUUID(),
      this.agentId,
      balance.equity,
      balance.cash,
      positionsValue,
      unrealizedPnl,
      realizedPnl,
    ]);
  }

  // ── Private helpers ────────────────────────────────────────────

  private async initBalance(): Promise<void> {
    const sql = convertPlaceholders(
      "SELECT agent_id FROM agent_balance WHERE agent_id = ?",
      this.db.backend,
    );
    const existing = await execGet<{ agent_id: string }>(this.db, sql, [this.agentId]);

    if (!existing) {
      const insertSql = convertPlaceholders(
        "INSERT INTO agent_balance (agent_id, cash, initial_cash, peak_equity) VALUES (?, ?, ?, ?)",
        this.db.backend,
      );
      await execRun(this.db, insertSql, [
        this.agentId,
        this.startingBalance,
        this.startingBalance,
        this.startingBalance,
      ]);
    }
  }

  private resolvePrice(symbol: string, fallback?: number): number {
    const providerPrice = this.getCurrentPrice(symbol);
    if (providerPrice !== null && providerPrice > 0) return providerPrice;

    if (fallback && fallback > 0) return fallback;

    const cached = this.priceCache.get(symbol);
    if (cached) return cached;

    throw new Error(`No price available for ${symbol}. Provide a price provider or limit price.`);
  }

  private applySlippage(price: number, side: "buy" | "sell"): number {
    if (this.slippageRate === 0) return price;
    const slip = price * this.slippageRate;
    return side === "buy" ? price + slip : price - slip;
  }

  private calculateFee(notional: number): number {
    return notional * this.feeRate;
  }

  private async fillOrder(
    id: string,
    order: OrderRequest,
    timestamp: string,
  ): Promise<OrderResult> {
    const basePrice =
      order.orderType === "limit"
        ? order.limitPrice!
        : this.resolvePrice(order.symbol, order.limitPrice);

    const fillPrice = this.applySlippage(basePrice, order.side);
    const notional = fillPrice * order.quantity;
    const fee = this.calculateFee(notional);

    const balance = await this.getBalanceRow();
    const position = await this.getPositionRow(order.symbol);

    let realizedPnl = 0;
    let newCash = balance.cash;
    let newQty: number;
    let newAvgEntry: number;

    if (order.side === "buy") {
      const cost = notional + fee;
      if (balance.cash < cost) {
        return this.reject(
          id,
          order,
          `Insufficient cash: need $${cost.toFixed(2)}, have $${balance.cash.toFixed(2)}`,
          timestamp,
        );
      }
      newCash = balance.cash - cost;
      if (position && position.side === "long" && position.quantity > 0) {
        const totalCost = position.avg_entry_price * position.quantity + notional;
        newQty = position.quantity + order.quantity;
        newAvgEntry = totalCost / newQty;
      } else {
        newQty = order.quantity;
        newAvgEntry = fillPrice;
      }
    } else {
      // Sell — must have existing long position
      if (!position || position.quantity < order.quantity) {
        return this.reject(
          id,
          order,
          `Insufficient position: need ${order.quantity} ${order.symbol}, have ${position?.quantity ?? 0}`,
          timestamp,
        );
      }
      realizedPnl = (fillPrice - position.avg_entry_price) * order.quantity - fee;
      newCash = balance.cash + notional - fee;
      newQty = position.quantity - order.quantity;
      newAvgEntry = newQty > 0 ? position.avg_entry_price : 0;
    }

    // Persist
    await this.upsertPosition(order.symbol, newQty, newAvgEntry, fillPrice);
    const equity = await this.calculateEquity(newCash);
    const peakEquity = Math.max(balance.peak_equity, equity);
    await this.updateBalance(newCash, peakEquity);
    this.priceCache.set(order.symbol, fillPrice);

    // Record order
    const orderSql = convertPlaceholders(
      `INSERT INTO agent_orders (id, agent_id, symbol, side, order_type, quantity, fill_price, fee, realized_pnl, status, filled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'filled', ?)`,
      this.db.backend,
    );
    await execRun(this.db, orderSql, [
      id,
      this.agentId,
      order.symbol,
      order.side,
      order.orderType === "stop" ? "market" : order.orderType,
      order.quantity,
      fillPrice,
      fee,
      realizedPnl,
      timestamp,
    ]);

    return {
      id,
      clientOrderId: order.clientOrderId,
      symbol: order.symbol,
      side: order.side,
      orderType: order.orderType,
      quantity: order.quantity,
      fillPrice,
      status: "filled",
      fee,
      realizedPnl,
      timestamp,
    };
  }

  private reject(id: string, order: OrderRequest, error: string, timestamp: string): OrderResult {
    return {
      id,
      clientOrderId: order.clientOrderId,
      symbol: order.symbol,
      side: order.side,
      orderType: order.orderType,
      quantity: order.quantity,
      fillPrice: null,
      status: "rejected" as OrderStatus,
      fee: 0,
      realizedPnl: 0,
      error,
      timestamp,
    };
  }

  private async getBalanceRow(): Promise<AgentBalanceRow> {
    const sql = convertPlaceholders(
      "SELECT * FROM agent_balance WHERE agent_id = ?",
      this.db.backend,
    );
    const row = await execGet<AgentBalanceRow>(this.db, sql, [this.agentId]);
    if (!row) {
      throw new Error(
        `agent_balance row not found for agent ${this.agentId} — was initBalance() called?`,
      );
    }
    return row;
  }

  private async getPositionRow(symbol: string): Promise<AgentPositionRow | null> {
    const sql = convertPlaceholders(
      "SELECT * FROM agent_positions WHERE agent_id = ? AND symbol = ?",
      this.db.backend,
    );
    const row = await execGet<AgentPositionRow>(this.db, sql, [this.agentId, symbol]);
    return row ?? null;
  }

  private async upsertPosition(
    symbol: string,
    quantity: number,
    avgEntryPrice: number,
    _currentPrice: number,
  ): Promise<void> {
    if (quantity === 0) {
      const sql = convertPlaceholders(
        "DELETE FROM agent_positions WHERE agent_id = ? AND symbol = ?",
        this.db.backend,
      );
      await execRun(this.db, sql, [this.agentId, symbol]);
      return;
    }

    const side: "long" | "short" = "long";
    const sql = convertPlaceholders(
      `INSERT INTO agent_positions (agent_id, symbol, quantity, avg_entry_price, side, updated_at)
       VALUES (?, ?, ?, ?, ?, {now})
       ON CONFLICT(agent_id, symbol) DO UPDATE SET
         quantity = excluded.quantity,
         avg_entry_price = excluded.avg_entry_price,
         side = excluded.side,
         updated_at = excluded.updated_at`,
      this.db.backend,
    );
    await execRun(this.db, sql, [this.agentId, symbol, quantity, avgEntryPrice, side]);
  }

  private async updateBalance(cash: number, peakEquity: number): Promise<void> {
    const sql = convertPlaceholders(
      "UPDATE agent_balance SET cash = ?, peak_equity = ?, updated_at = {now} WHERE agent_id = ?",
      this.db.backend,
    );
    await execRun(this.db, sql, [cash, peakEquity, this.agentId]);
  }

  private async calculateEquity(cash: number): Promise<number> {
    const sql = convertPlaceholders(
      "SELECT * FROM agent_positions WHERE agent_id = ? AND quantity > 0",
      this.db.backend,
    );
    const rows = await execAll<AgentPositionRow>(this.db, sql, [this.agentId]);
    let positionsValue = 0;
    for (const row of rows) {
      const price = this.resolvePrice(row.symbol, row.avg_entry_price);
      positionsValue += row.quantity * price;
    }
    return cash + positionsValue;
  }
}

export interface AgentOrderRow {
  id: string;
  agent_id: string;
  decision_id: string | null;
  symbol: string;
  side: "buy" | "sell";
  order_type: "market" | "limit" | "stop";
  quantity: number;
  fill_price: number | null;
  fee: number;
  realized_pnl: number;
  status: "pending" | "filled" | "cancelled" | "rejected";
  error: string | null;
  created_at: string;
  filled_at: string | null;
}
