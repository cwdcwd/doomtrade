/**
 * CCXTExecutor — live crypto trades via the CCXT library.
 *
 * Wraps the ccxt Exchange object behind the unified Executor interface.
 * Supports market and limit orders. Stop orders are rejected with a clear
 * error (CCXT does not have a universal native stop-order type across all
 * exchanges). Maps CCXT's order/position/balance responses to DoomTrade's
 * OrderResult, Position, and Balance types.
 *
 * Design:
 * - All methods are async (Executor contract).
 * - Errors are caught and returned as rejected OrderResult, never thrown.
 * - The executor name is "ccxt" (matches the trades table CHECK constraint).
 * - mode (sim/live) is NOT set here — the TradeEngine sets that on the trade record.
 * - CCXT numeric values are already numbers (unlike Alpaca's strings).
 */

import { randomUUID } from "node:crypto";
import type { Exchange } from "ccxt";
import type {
  Balance,
  Executor,
  OrderRequest,
  OrderResult,
  OrderStatus,
  Position,
} from "./executor.js";

/** Constructor config for CCXTExecutor. */
export interface CCXTExecutorConfig {
  /** CCXT Exchange instance (already constructed with credentials + loaded markets). */
  exchange: Exchange;
  /** Initial cash for peakEquity tracking (optional). */
  initialCash?: number;
}

/**
 * The actual runtime shape of CCXT's fetchBalance response.
 * CCXT's type definition says `Balances extends Dictionary<Balance>`, but at
 * runtime it also includes top-level `free`, `used`, `total` dictionaries of
 * numbers. This interface captures that dual nature.
 */
interface CCXTBalanceResponse {
  info: unknown;
  timestamp?: number;
  datetime?: string;
  free: Record<string, number>;
  used: Record<string, number>;
  total: Record<string, number>;
  [key: string]: unknown;
}

/**
 * Minimal shape of a CCXT Order response that we read.
 * CCXT's Order interface uses `Str` (string | undefined) for `id`, which
 * requires a cast to `string` for our OrderResult.
 */
interface CCXTOrder {
  id: string;
  clientOrderId?: string;
  status: string;
  average?: number | null;
  filled?: number | null;
  price?: number | null;
  fee?: { cost?: number } | null;
  datetime?: string;
}

/**
 * CCXTExecutor implements the Executor interface for live crypto trading.
 */
export class CCXTExecutor implements Executor {
  readonly name = "ccxt";

  private exchange: Exchange;
  private initialCash: number;

  constructor(config: CCXTExecutorConfig) {
    this.exchange = config.exchange;
    this.initialCash = config.initialCash ?? 0;
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

    // Reject stop orders — CCXT does not have universal stop orders
    if (order.orderType === "stop") {
      return this.reject(
        randomUUID(),
        order,
        "Stop orders are not supported by CCXTExecutor. Use a limit or market order instead.",
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

    try {
      const result = await this.exchange.createOrder(
        order.symbol,
        order.orderType,
        order.side,
        order.quantity,
        order.orderType === "limit" ? order.limitPrice : undefined,
        order.clientOrderId ? { clientOrderId: order.clientOrderId } : {},
      );

      return this.mapOrderResult(result as unknown as CCXTOrder, order, timestamp);
    } catch (err) {
      return this.reject(
        randomUUID(),
        order,
        `CCXT order failed: ${this.errorMessage(err)}`,
        timestamp,
      );
    }
  }

  async cancelOrder(id: string): Promise<boolean> {
    try {
      await this.exchange.cancelOrder(id);
      return true;
    } catch (err) {
      return false;
    }
  }

  async getPositions(): Promise<Position[]> {
    try {
      // fetchBalance gives us the holdings. We treat non-zero balances as positions.
      const balances = await this.exchange.fetchBalance();
      const ccxtBalances = balances as unknown as CCXTBalanceResponse;
      const positions: Position[] = [];

      // CCXT fetchBalance returns { info, timestamp, datetime, free: {}, used: {}, total: {} }
      // We iterate over total balances (free + used) and map non-zero entries.
      const total = ccxtBalances.total ?? {};

      for (const currency of Object.keys(total)) {
        const qty = total[currency];
        if (qty === undefined || typeof qty !== "number" || qty <= 0) continue;

        positions.push({
          symbol: currency,
          quantity: qty,
          avgEntryPrice: 0, // Not directly available from balance
          side: "long" as const,
        });
      }

      return positions;
    } catch (err) {
      return [];
    }
  }

  async getBalance(): Promise<Balance> {
    try {
      const balances = await this.exchange.fetchBalance();
      const ccxtBalances = balances as unknown as CCXTBalanceResponse;

      // CCXT balance response: { total: { BTC: 1, USDT: 50000, ... }, ... }
      // The "cash" is the quote currency (USDT/USD) free balance.
      // equity is the sum of all holdings' total value.
      const free = ccxtBalances.free ?? {};
      const total = ccxtBalances.total ?? {};

      // Determine the quote currency from the exchange's default market
      const quoteCurrency = this.detectQuoteCurrency();
      const cash = free[quoteCurrency] ?? 0;

      // Equity = sum of all total balances (rough — without market price conversion)
      // For a proper equity calculation we'd need ticker prices; this is a basic sum.
      const equity = Object.values(total).reduce(
        (sum: number, val: number | undefined) =>
          sum + (typeof val === "number" ? val : 0),
        0,
      );

      const initialCash = this.initialCash || cash;
      const peakEquity = Math.max(initialCash, equity);

      return {
        cash,
        equity,
        initialCash,
        peakEquity,
      };
    } catch (err) {
      throw new Error(`CCXT getBalance failed: ${this.errorMessage(err)}`);
    }
  }

  // ── Private helpers ─────────────────────────────────────────

  /**
   * Detect the quote currency from the exchange's markets.
   * Falls back to "USDT" for most crypto exchanges.
   */
  private detectQuoteCurrency(): string {
    try {
      const markets = this.exchange.markets;
      if (!markets) return "USDT";

      // Find the most common quote currency across markets
      const quotes = new Map<string, number>();
      for (const market of Object.values(markets)) {
        if (market.quote) {
          quotes.set(market.quote, (quotes.get(market.quote) ?? 0) + 1);
        }
      }

      const sorted = [...quotes.entries()].sort((a, b) => b[1] - a[1]);
      return sorted.length > 0 ? sorted[0][0] : "USDT";
    } catch {
      return "USDT";
    }
  }

  /**
   * Map a CCXT Order response to our OrderResult.
   * CCXT statuses: 'open', 'closed', 'canceled', 'expired', 'rejected'.
   */
  private mapOrderResult(
    result: CCXTOrder,
    order: OrderRequest,
    timestamp: string,
  ): OrderResult {
    const status = this.mapStatus(result.status);
    const fillPrice = result.average ?? result.price ?? null;
    const fee = result.fee?.cost ?? 0;

    return {
      id: result.id,
      clientOrderId: order.clientOrderId,
      symbol: order.symbol,
      side: order.side,
      orderType: order.orderType,
      quantity: order.quantity,
      fillPrice,
      status,
      fee,
      realizedPnl: 0, // Not directly available from CCXT order response
      timestamp: result.datetime ?? timestamp,
    };
  }

  private mapStatus(ccxtStatus: string): OrderStatus {
    switch (ccxtStatus) {
      case "closed":
        return "filled";
      case "canceled":
        return "cancelled";
      case "rejected":
      case "expired":
        return "rejected";
      case "open":
      default:
        return "pending";
    }
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