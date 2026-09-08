/**
 * ThemeSubAccount — manages per-theme virtual sub-accounts.
 *
 * Each theme gets its own balance, positions, and P&L tracking
 * within the SimulatedExchange. This enables clean per-theme
 * performance attribution without contaminating the global account.
 *
 * Uses sim_sub_positions and sim_sub_orders tables (migration 5).
 */

import { randomUUID } from "node:crypto";
import type { Database } from "../db/database.js";
import { execAll, execGet, execRun, convertPlaceholders } from "../db/database.js";
import type { Position, Balance, OrderRequest, OrderResult, OrderStatus, Executor } from "../executor/executor.js";

interface SubPositionRow {
  theme_id: string;
  symbol: string;
  quantity: number;
  avg_entry_price: number;
  side: string;
  updated_at: string;
}

interface SubBalanceRow {
  theme_id: string;
  balance: number;
  peak_balance: number;
  starting_balance: number;
}

export class ThemeSubAccount implements Executor {
  readonly name = "theme-sub-account";
  private priceCache: Map<string, number> = new Map();
  private getCurrentPrice: (symbol: string) => number | null;
  private feeRate: number;

  constructor(
    private db: Database,
    private themeId: string,
    config: { feeRate?: number; getCurrentPrice?: (symbol: string) => number | null } = {},
  ) {
    this.feeRate = config.feeRate ?? 0.001;
    this.getCurrentPrice = config.getCurrentPrice ?? (() => null);
  }

  /**
   * Initialize the sub-account with a starting balance.
   * Idempotent — if already initialized, returns existing.
   */
  async initialize(startingBalance: number): Promise<void> {
    const existing = await execGet<SubBalanceRow>(
      this.db,
      convertPlaceholders(
        "SELECT * FROM theme_subaccounts WHERE theme_id = ?",
        this.db.backend,
      ),
      [this.themeId],
    );

    if (!existing) {
      await execRun(
        this.db,
        convertPlaceholders(
          `INSERT INTO theme_subaccounts (theme_id, balance, peak_balance, starting_balance)
           VALUES (?, ?, ?, ?)`,
          this.db.backend,
        ),
        [this.themeId, startingBalance, startingBalance, startingBalance],
      );
    }
  }

  /**
   * Get the sub-account balance.
   */
  async getBalance(): Promise<Balance> {
    const row = await this.getBalanceRow();
    const positions = await this.getPositions();
    const positionsValue = positions.reduce((sum, p) => sum + (p.marketValue ?? 0), 0);
    const equity = row.balance + positionsValue;

    return {
      cash: row.balance,
      equity,
      initialCash: row.starting_balance,
      peakEquity: Math.max(row.peak_balance, equity),
    };
  }

  /**
   * Get all open positions in this sub-account.
   */
  async getPositions(): Promise<Position[]> {
    const rows = await execAll<SubPositionRow>(
      this.db,
      convertPlaceholders(
        "SELECT * FROM sim_sub_positions WHERE theme_id = ? AND quantity > 0",
        this.db.backend,
      ),
      [this.themeId],
    );

    return rows.map((row) => {
      const currentPrice = this.resolvePrice(row.symbol, row.avg_entry_price);
      const marketValue = row.quantity * currentPrice;
      const unrealizedPnl = (currentPrice - row.avg_entry_price) * row.quantity;

      return {
        symbol: row.symbol,
        quantity: row.quantity,
        avgEntryPrice: row.avg_entry_price,
        side: row.side as "long" | "short",
        unrealizedPnl,
        marketValue,
      };
    });
  }

  /**
   * Cancel an order. Sub-account orders fill immediately, so nothing to cancel.
   */
  async cancelOrder(_id: string): Promise<boolean> {
    return false;
  }

  /**
   * Place an order in this sub-account.
   */
  async placeOrder(order: OrderRequest): Promise<OrderResult> {
    const timestamp = new Date().toISOString();
    const id = randomUUID();

    if (order.quantity <= 0) {
      return this.reject(id, order, "Quantity must be positive", timestamp);
    }

    const balance = await this.getBalanceRow();
    const position = await this.getPositionRow(order.symbol);

    // Determine fill price
    const fillPrice = order.orderType === "limit" && order.limitPrice
      ? order.limitPrice
      : this.resolvePrice(order.symbol, order.limitPrice);

    const notional = fillPrice * order.quantity;
    const fee = notional * this.feeRate;

    let realizedPnl = 0;
    let newBalance = balance.balance;
    let newQty: number;
    let newAvgEntry: number;

    if (order.side === "buy") {
      const cost = notional + fee;
      if (balance.balance < cost) {
        return this.reject(
          id, order,
          `Insufficient cash in sub-account: need $${cost.toFixed(2)}, have $${balance.balance.toFixed(2)}`,
          timestamp,
        );
      }

      newBalance = balance.balance - cost;

      if (position && position.quantity > 0) {
        const totalCost = position.avg_entry_price * position.quantity + notional;
        newQty = position.quantity + order.quantity;
        newAvgEntry = totalCost / newQty;
      } else {
        newQty = order.quantity;
        newAvgEntry = fillPrice;
      }
    } else {
      // Sell — must have existing position
      if (!position || position.quantity < order.quantity) {
        return this.reject(
          id, order,
          `Insufficient position: need ${order.quantity} ${order.symbol}, have ${position?.quantity ?? 0}`,
          timestamp,
        );
      }

      realizedPnl = (fillPrice - position.avg_entry_price) * order.quantity - fee;
      newBalance = balance.balance + notional - fee;
      newQty = position.quantity - order.quantity;
      newAvgEntry = newQty > 0 ? position.avg_entry_price : 0;
    }

    // Persist
    await this.upsertPosition(order.symbol, newQty, newAvgEntry);

    const equity = await this.calculateEquity(newBalance);
    const peakBalance = Math.max(balance.peak_balance, equity);
    await this.updateBalance(newBalance, peakBalance);

    this.priceCache.set(order.symbol, fillPrice);

    // Record order
    await execRun(
      this.db,
      convertPlaceholders(
        `INSERT INTO sim_sub_orders (id, theme_id, symbol, side, order_type, quantity, limit_price, status, filled_at, realized_pnl)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'filled', ?, ?)`,
        this.db.backend,
      ),
      [id, this.themeId, order.symbol, order.side,
       order.orderType === "stop" ? "market" : order.orderType,
       order.quantity, order.limitPrice ?? null, timestamp, realizedPnl],
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

  // ── Private helpers ─────────────────────────────────────────

  private resolvePrice(symbol: string, fallback?: number): number {
    const providerPrice = this.getCurrentPrice(symbol);
    if (providerPrice !== null && providerPrice > 0) return providerPrice;

    const cached = this.priceCache.get(symbol);
    if (cached) return cached;

    if (fallback) return fallback;

    throw new Error(`No price available for ${symbol} in sub-account ${this.themeId}`);
  }

  private async getBalanceRow(): Promise<SubBalanceRow> {
    const row = await execGet<SubBalanceRow>(
      this.db,
      convertPlaceholders(
        "SELECT * FROM theme_subaccounts WHERE theme_id = ?",
        this.db.backend,
      ),
      [this.themeId],
    );
    if (!row) {
      throw new Error(`Sub-account not initialized for theme ${this.themeId}`);
    }
    return row;
  }

  private async getPositionRow(symbol: string): Promise<SubPositionRow | null> {
    const row = await execGet<SubPositionRow>(
      this.db,
      convertPlaceholders(
        "SELECT * FROM sim_sub_positions WHERE theme_id = ? AND symbol = ?",
        this.db.backend,
      ),
      [this.themeId, symbol],
    );
    return row ?? null;
  }

  private async upsertPosition(
    symbol: string,
    quantity: number,
    avgEntryPrice: number,
  ): Promise<void> {
    if (quantity === 0) {
      await execRun(
        this.db,
        convertPlaceholders(
          "DELETE FROM sim_sub_positions WHERE theme_id = ? AND symbol = ?",
          this.db.backend,
        ),
        [this.themeId, symbol],
      );
      return;
    }

    await execRun(
      this.db,
      convertPlaceholders(
        `INSERT INTO sim_sub_positions (theme_id, symbol, quantity, avg_entry_price, side, updated_at)
         VALUES (?, ?, ?, ?, 'long', {now})
         ON CONFLICT(theme_id, symbol) DO UPDATE SET
           quantity = excluded.quantity,
           avg_entry_price = excluded.avg_entry_price,
           side = excluded.side,
           updated_at = excluded.updated_at`,
        this.db.backend,
      ),
      [this.themeId, symbol, quantity, avgEntryPrice],
    );
  }

  private async updateBalance(balance: number, peakBalance: number): Promise<void> {
    await execRun(
      this.db,
      convertPlaceholders(
        "UPDATE theme_subaccounts SET balance = ?, peak_balance = ? WHERE theme_id = ?",
        this.db.backend,
      ),
      [balance, peakBalance, this.themeId],
    );
  }

  private async calculateEquity(cash: number): Promise<number> {
    const rows = await execAll<SubPositionRow>(
      this.db,
      convertPlaceholders(
        "SELECT * FROM sim_sub_positions WHERE theme_id = ? AND quantity > 0",
        this.db.backend,
      ),
      [this.themeId],
    );

    const positionsValue = rows.reduce((sum, row) => {
      const price = this.resolvePrice(row.symbol, row.avg_entry_price);
      return sum + row.quantity * price;
    }, 0);

    return cash + positionsValue;
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
}