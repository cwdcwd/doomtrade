/**
 * Simulated exchange executor — in-memory paper trading engine.
 *
 * Mimics real exchange behavior without making any API calls.
 * Starts with $100,000 virtual cash. Supports market and limit orders.
 * Tracks long positions, computes P&L, deducts configurable fees.
 * Persists state to SQLite so it survives restarts.
 *
 * Note: Short selling is not supported in this version. Sells require
 * an existing long position (selling to close).
 */

import type { Database as DatabaseType } from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type {
  Balance,
  Executor,
  OrderRequest,
  OrderResult,
  OrderStatus,
  Position,
} from "./executor.js";

export interface SimulatedExchangeConfig {
  initialCash?: number;
  /** Fee per trade as a fraction (e.g., 0.001 = 0.1%) */
  feeRate?: number;
  /** Slippage simulation as a fraction (e.g., 0.0005 = 0.05%) */
  slippageRate?: number;
  /** Price provider function — returns current market price for a symbol */
  getCurrentPrice?: (symbol: string) => number | null;
}

const DEFAULT_CONFIG: Required<
  Omit<SimulatedExchangeConfig, "getCurrentPrice">
> = {
  initialCash: 100_000,
  feeRate: 0.001,
  slippageRate: 0,
};

interface SimPositionRow {
  symbol: string;
  quantity: number;
  avg_entry_price: number;
  side: "long" | "short";
  updated_at: string;
}

interface SimBalanceRow {
  id: number;
  cash: number;
  initial_cash: number;
  peak_equity: number;
  updated_at: string;
}

interface SimOrderRow {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  order_type: "market" | "limit";
  quantity: number;
  limit_price: number | null;
  status: "pending" | "filled" | "cancelled";
  created_at: string;
  filled_at: string | null;
}

export class SimulatedExchange implements Executor {
  readonly name = "simulated";

  private db: DatabaseType;
  private config: Required<Omit<SimulatedExchangeConfig, "getCurrentPrice">>;
  private getCurrentPrice: (symbol: string) => number | null;
  private priceCache: Map<string, number> = new Map();

  constructor(db: DatabaseType, config?: SimulatedExchangeConfig) {
    this.db = db;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.getCurrentPrice = config?.getCurrentPrice ?? (() => null);
    this.initBalance();
  }

  // ── Public API ──────────────────────────────────────────────

  async placeOrder(order: OrderRequest): Promise<OrderResult> {
    const timestamp = new Date().toISOString();
    const id = randomUUID();

    // Validate
    if (order.quantity <= 0) {
      return this.reject(id, order, "Quantity must be positive", timestamp);
    }

    if (order.orderType === "limit" && !order.limitPrice) {
      return this.reject(id, order, "Limit orders require a limitPrice", timestamp);
    }

    if (order.orderType === "stop" && !order.stopPrice) {
      return this.reject(id, order, "Stop orders require a stopPrice", timestamp);
    }

    // For limit orders, check if the price would fill now.
    // If not, store as pending and return.
    if (order.orderType === "limit") {
      const currentPrice = this.resolvePrice(order.symbol, order.limitPrice);
      const wouldFill =
        (order.side === "buy" && order.limitPrice! >= currentPrice) ||
        (order.side === "sell" && order.limitPrice! <= currentPrice);

      if (!wouldFill) {
        this.db
          .prepare(
            `INSERT INTO sim_orders (id, symbol, side, order_type, quantity, limit_price, status)
             VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
          )
          .run(
            id,
            order.symbol,
            order.side,
            "limit",
            order.quantity,
            order.limitPrice,
          );

        return {
          id,
          clientOrderId: order.clientOrderId,
          symbol: order.symbol,
          side: order.side,
          orderType: order.orderType,
          quantity: order.quantity,
          fillPrice: null,
          status: "pending",
          fee: 0,
          realizedPnl: 0,
          timestamp,
        };
      }
    }

    return this.fillOrder(id, order, timestamp);
  }

  async cancelOrder(id: string): Promise<boolean> {
    const order = this.db
      .prepare("SELECT * FROM sim_orders WHERE id = ? AND status = 'pending'")
      .get(id) as SimOrderRow | undefined;

    if (!order) return false;

    this.db
      .prepare("UPDATE sim_orders SET status = 'cancelled' WHERE id = ?")
      .run(id);

    return true;
  }

  async getPositions(): Promise<Position[]> {
    const rows = this.db
      .prepare("SELECT * FROM sim_positions WHERE quantity > 0")
      .all() as SimPositionRow[];

    return rows.map((row) => {
      const currentPrice = this.resolvePrice(row.symbol, row.avg_entry_price);
      const marketValue = row.quantity * currentPrice;
      const unrealizedPnl =
        (currentPrice - row.avg_entry_price) * row.quantity;

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
    const row = this.getBalanceRow();
    const positions = await this.getPositions();
    const positionsValue = positions.reduce(
      (sum, p) => sum + (p.marketValue ?? 0),
      0,
    );
    const equity = row.cash + positionsValue;

    return {
      cash: row.cash,
      equity,
      initialCash: row.initial_cash,
      peakEquity: Math.max(row.peak_equity, equity),
    };
  }

  /**
   * Try to fill pending limit orders when price updates.
   * Call this after the price provider returns updated prices.
   */
  async checkPendingOrders(): Promise<OrderResult[]> {
    const pending = this.db
      .prepare("SELECT * FROM sim_orders WHERE status = 'pending'")
      .all() as SimOrderRow[];

    const filled: OrderResult[] = [];

    for (const order of pending) {
      const currentPrice = this.resolvePrice(
        order.symbol,
        order.limit_price ?? undefined,
      );
      const wouldFill =
        (order.side === "buy" && order.limit_price! >= currentPrice) ||
        (order.side === "sell" && order.limit_price! <= currentPrice);

      if (wouldFill) {
        // Mark the old pending order as cancelled (we'll create a new filled one)
        this.db
          .prepare("UPDATE sim_orders SET status = 'cancelled' WHERE id = ?")
          .run(order.id);

        const result = await this.placeOrder({
          symbol: order.symbol,
          side: order.side,
          quantity: order.quantity,
          orderType: "limit",
          limitPrice: order.limit_price!,
          clientOrderId: order.id,
        });
        filled.push(result);
      }
    }

    return filled;
  }

  // ── Private helpers ─────────────────────────────────────────

  private initBalance(): void {
    const existing = this.db
      .prepare("SELECT id FROM sim_balance WHERE id = 1")
      .get() as { id: number } | undefined;

    if (!existing) {
      this.db
        .prepare(
          "INSERT INTO sim_balance (id, cash, initial_cash, peak_equity) VALUES (1, ?, ?, ?)",
        )
        .run(
          this.config.initialCash,
          this.config.initialCash,
          this.config.initialCash,
        );
    }
  }

  /**
   * Resolve the current price for a symbol.
   * Priority: price provider → cached fill price → fallback.
   */
  private resolvePrice(symbol: string, fallback?: number): number {
    const providerPrice = this.getCurrentPrice(symbol);
    if (providerPrice !== null && providerPrice > 0) return providerPrice;

    const cached = this.priceCache.get(symbol);
    if (cached) return cached;

    const pos = this.getPositionRow(symbol);
    if (pos) return pos.avg_entry_price;

    if (fallback) return fallback;

    throw new Error(
      `No price available for ${symbol}. Provide a price provider or limit price.`,
    );
  }

  private applySlippage(price: number, side: "buy" | "sell"): number {
    if (this.config.slippageRate === 0) return price;
    const slip = price * this.config.slippageRate;
    return side === "buy" ? price + slip : price - slip;
  }

  private calculateFee(notional: number): number {
    return notional * this.config.feeRate;
  }

  /**
   * Core fill logic — executes a buy or sell at the given fill price.
   */
  private async fillOrder(
    id: string,
    order: OrderRequest,
    timestamp: string,
  ): Promise<OrderResult> {
    // Determine fill price
    const basePrice =
      order.orderType === "limit"
        ? order.limitPrice!
        : this.resolvePrice(order.symbol);

    const fillPrice = this.applySlippage(basePrice, order.side);
    const notional = fillPrice * order.quantity;
    const fee = this.calculateFee(notional);

    const balance = this.getBalanceRow();
    const position = this.getPositionRow(order.symbol);

    let realizedPnl = 0;
    let newCash = balance.cash;
    let newQty: number;
    let newAvgEntry: number;

    if (order.side === "buy") {
      // Check sufficient cash
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

      if (position && position.side === "long") {
        // Add to existing long position — weighted average entry
        const totalCost =
          position.avg_entry_price * position.quantity + notional;
        newQty = position.quantity + order.quantity;
        newAvgEntry = totalCost / newQty;
      } else {
        // New long position
        newQty = order.quantity;
        newAvgEntry = fillPrice;
      }
    } else {
      // Sell — must have an existing long position to close
      if (!position || position.quantity < order.quantity) {
        return this.reject(
          id,
          order,
          `Insufficient position: need ${order.quantity} ${order.symbol}, have ${position?.quantity ?? 0}`,
          timestamp,
        );
      }

      realizedPnl =
        (fillPrice - position.avg_entry_price) * order.quantity - fee;
      newCash = balance.cash + notional - fee;
      newQty = position.quantity - order.quantity;
      newAvgEntry = newQty > 0 ? position.avg_entry_price : 0;
    }

    // Persist state changes
    this.upsertPosition(order.symbol, newQty, newAvgEntry, fillPrice);

    const equity = this.calculateEquity(newCash);
    const peakEquity = Math.max(balance.peak_equity, equity);
    this.updateBalance(newCash, peakEquity);

    this.priceCache.set(order.symbol, fillPrice);

    // Record filled order
    this.db
      .prepare(
        `INSERT INTO sim_orders (id, symbol, side, order_type, quantity, limit_price, status, filled_at)
         VALUES (?, ?, ?, ?, ?, ?, 'filled', ?)`,
      )
      .run(
        id,
        order.symbol,
        order.side,
        order.orderType === "stop" ? "market" : order.orderType,
        order.quantity,
        order.limitPrice ?? null,
        timestamp,
      );

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

  private reject(
    id: string,
    order: OrderRequest,
    error: string,
    timestamp: string,
  ): OrderResult {
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

  private getBalanceRow(): SimBalanceRow {
    return this.db
      .prepare("SELECT * FROM sim_balance WHERE id = 1")
      .get() as SimBalanceRow;
  }

  private getPositionRow(symbol: string): SimPositionRow | null {
    const row = this.db
      .prepare("SELECT * FROM sim_positions WHERE symbol = ?")
      .get(symbol) as SimPositionRow | undefined;
    return row ?? null;
  }

  private upsertPosition(
    symbol: string,
    quantity: number,
    avgEntryPrice: number,
    currentPrice: number,
  ): void {
    if (quantity === 0) {
      this.db
        .prepare("DELETE FROM sim_positions WHERE symbol = ?")
        .run(symbol);
      return;
    }

    const side: "long" | "short" = "long";

    this.db
      .prepare(
        `INSERT INTO sim_positions (symbol, quantity, avg_entry_price, side, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'))
         ON CONFLICT(symbol) DO UPDATE SET
           quantity = excluded.quantity,
           avg_entry_price = excluded.avg_entry_price,
           side = excluded.side,
           updated_at = excluded.updated_at`,
      )
      .run(symbol, quantity, avgEntryPrice, side);
  }

  private updateBalance(cash: number, peakEquity: number): void {
    this.db
      .prepare(
        "UPDATE sim_balance SET cash = ?, peak_equity = ?, updated_at = datetime('now') WHERE id = 1",
      )
      .run(cash, peakEquity);
  }

  private calculateEquity(cash: number): number {
    const rows = this.db
      .prepare("SELECT * FROM sim_positions WHERE quantity > 0")
      .all() as SimPositionRow[];

    const positionsValue = rows.reduce((sum, row) => {
      const price = this.resolvePrice(row.symbol, row.avg_entry_price);
      return sum + row.quantity * price;
    }, 0);

    return cash + positionsValue;
  }
}