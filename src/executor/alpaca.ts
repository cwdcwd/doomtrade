/**
 * AlpacaExecutor — live/paper stock trades via the Alpaca SDK.
 *
 * Wraps @alpacahq/alpaca-trade-api behind the unified Executor interface.
 * Supports market, limit, and stop orders. Maps Alpaca's order/position/
 * account responses to DoomTrade's OrderResult, Position, and Balance types.
 *
 * Design:
 * - All methods are async (Executor contract).
 * - Errors are caught and returned as rejected OrderResult, never thrown.
 * - The executor name is "alpaca" (matches the trades table CHECK constraint).
 * - mode (sim/live) is NOT set here — the TradeEngine sets that on the trade record.
 * - Uses the Alpaca SDK's ergonomic order methods (market/limit/stop).
 * - Alpaca returns all numeric values as strings; we parse to numbers.
 */

import { randomUUID } from "node:crypto";
import type { Alpaca } from "@alpacahq/alpaca-trade-api";
import type {
  Balance,
  Executor,
  OrderRequest,
  OrderResult,
  OrderStatus,
  Position,
} from "./executor.js";

/** Constructor config for AlpacaExecutor. */
export interface AlpacaExecutorConfig {
  /** Alpaca SDK client instance (already constructed with credentials). */
  client: Alpaca;
}

/**
 * Minimal shape of an Alpaca Order response that we read.
 * The SDK's Order interface has all fields optional; this keeps the mapping
 * code explicit without resorting to `any`.
 */
interface AlpacaOrder {
  id?: string;
  clientOrderId?: string;
  status?: string;
  filledQty?: string;
  filledAvgPrice?: string | null;
  createdAt?: string | Date;
}

/**
 * AlpacaExecutor implements the Executor interface for live/paper stock trading.
 */
export class AlpacaExecutor implements Executor {
  readonly name = "alpaca";

  private client: Alpaca;

  constructor(config: AlpacaExecutorConfig) {
    this.client = config.client;
  }

  // ── Public API ──────────────────────────────────────────────

  async placeOrder(order: OrderRequest): Promise<OrderResult> {
    const timestamp = new Date().toISOString();

    // Validate quantity
    if (order.quantity <= 0) {
      return this.reject(
        randomUUID(),
        order,
        "Quantity must be positive",
        timestamp,
      );
    }

    // Validate limit price for limit orders
    if (order.orderType === "limit" && !order.limitPrice) {
      return this.reject(
        randomUUID(),
        order,
        "Limit orders require a limitPrice",
        timestamp,
      );
    }

    // Validate stop price for stop orders
    if (order.orderType === "stop" && !order.stopPrice) {
      return this.reject(
        randomUUID(),
        order,
        "Stop orders require a stopPrice",
        timestamp,
      );
    }

    try {
      const result = await this.submitOrder(order);
      return this.mapOrderResult(result, order, timestamp);
    } catch (err) {
      return this.reject(
        randomUUID(),
        order,
        `Alpaca order failed: ${this.errorMessage(err)}`,
        timestamp,
      );
    }
  }

  async cancelOrder(id: string): Promise<boolean> {
    try {
      await this.client.trading.orders.deleteOrderByOrderID({ orderId: id });
      return true;
    } catch (err) {
      return false;
    }
  }

  async getPositions(): Promise<Position[]> {
    try {
      const alpacaPositions = await this.client.trading.positions.getAllOpenPositions();
      return alpacaPositions
        .filter((p) => parseFloat(p.qty) > 0)
        .map((p) => this.mapPosition(p));
    } catch (err) {
      return [];
    }
  }

  async getBalance(): Promise<Balance> {
    try {
      const account = await this.client.trading.account.getAccount();
      const cash = parseFloat(account.cash ?? "0");
      const equity = parseFloat(account.equity ?? "0");
      const initialCash = parseFloat(account.lastEquity ?? "0") || equity;
      const peakEquity = parseFloat(account.portfolioValue ?? "0") || equity;

      return {
        cash,
        equity,
        initialCash,
        peakEquity,
      };
    } catch (err) {
      throw new Error(`Alpaca getBalance failed: ${this.errorMessage(err)}`);
    }
  }

  // ── Private helpers ─────────────────────────────────────────

  /**
   * Submit the order to Alpaca using the appropriate ergonomic method.
   */
  private async submitOrder(order: OrderRequest): Promise<AlpacaOrder> {
    const orders = this.client.trading.orders;
    const qty = order.quantity;
    const symbol = order.symbol;
    const side = order.side;
    const clientOrderId = order.clientOrderId ?? "";

    if (order.orderType === "market") {
      return orders.market({
        symbol,
        side,
        qty,
        clientOrderId,
      }) as Promise<AlpacaOrder>;
    }

    if (order.orderType === "limit") {
      return orders.limit({
        symbol,
        side,
        qty,
        limitPrice: order.limitPrice!,
        clientOrderId,
      }) as Promise<AlpacaOrder>;
    }

    // Stop order
    return orders.stop({
      symbol,
      side,
      qty,
      stopPrice: order.stopPrice!,
      clientOrderId,
    }) as Promise<AlpacaOrder>;
  }

  /**
   * Map an Alpaca Order response to our OrderResult.
   * Alpaca statuses: new, partially_filled, filled, done_for_day,
   * canceled, expired, replaced, pending_cancel, pending_replace,
   * rejected. We map: filled → filled, canceled → cancelled,
   * rejected → rejected, everything else → pending.
   */
  private mapOrderResult(
    result: AlpacaOrder,
    order: OrderRequest,
    timestamp: string,
  ): OrderResult {
    const status = this.mapStatus(result.status ?? "new");
    const fillPrice = result.filledAvgPrice ? parseFloat(result.filledAvgPrice) : null;
    const filledQty = result.filledQty ? parseFloat(result.filledQty) : 0;
    const fee = 0; // Alpaca fees come from activities, not the order response

    return {
      id: result.id ?? randomUUID(),
      clientOrderId: order.clientOrderId,
      symbol: order.symbol,
      side: order.side,
      orderType: order.orderType,
      quantity: order.quantity,
      fillPrice,
      status,
      fee,
      realizedPnl: 0, // Realized P&L not available from order response
      timestamp: result.createdAt
        ? new Date(result.createdAt).toISOString()
        : timestamp,
    };
  }

  private mapStatus(alpacaStatus: string): OrderStatus {
    switch (alpacaStatus) {
      case "filled":
        return "filled";
      case "canceled":
        return "cancelled";
      case "rejected":
      case "expired":
        return "rejected";
      case "partially_filled":
      case "new":
      case "accepted":
      case "pending_new":
      case "done_for_day":
      case "replaced":
      case "pending_cancel":
      case "pending_replace":
      default:
        return "pending";
    }
  }

  private mapPosition(p: {
    symbol: string;
    qty: string;
    avgEntryPrice: string;
    side: string;
    unrealizedPl?: string;
    marketValue?: string;
    currentPrice?: string;
  }): Position {
    const quantity = parseFloat(p.qty);
    const avgEntryPrice = parseFloat(p.avgEntryPrice);
    const side: "long" | "short" = p.side === "short" ? "short" : "long";

    return {
      symbol: p.symbol,
      quantity,
      avgEntryPrice,
      side,
      unrealizedPnl: p.unrealizedPl ? parseFloat(p.unrealizedPl) : undefined,
      marketValue: p.marketValue ? parseFloat(p.marketValue) : undefined,
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

  private errorMessage(err: unknown): string {
    if (err instanceof Error) return err.message;
    return String(err);
  }
}