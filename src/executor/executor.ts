/**
 * Executor interface — unified contract for all trade executors.
 *
 * Implementations:
 * - SimulatedExchange: in-memory paper trading
 * - AlpacaExecutor: live/paper stock trades via Alpaca SDK
 * - CCXTExecutor: live/paper crypto trades via CCXT
 */

export type OrderSide = "buy" | "sell";
export type OrderType = "market" | "limit" | "stop";
export type OrderStatus = "pending" | "filled" | "cancelled" | "rejected";

/**
 * Input to place an order.
 */
export interface OrderRequest {
  symbol: string;
  side: OrderSide;
  quantity: number;
  orderType: OrderType;
  /** Required for limit orders. Price at which to fill. */
  limitPrice?: number;
  /** Required for stop orders. Trigger price. */
  stopPrice?: number;
  /** Client-assigned order ID for idempotency / tracking. */
  clientOrderId?: string;
}

/**
 * Result of placing an order.
 */
export interface OrderResult {
  id: string;
  clientOrderId?: string;
  symbol: string;
  side: OrderSide;
  orderType: OrderType;
  quantity: number;
  fillPrice: number | null;
  status: OrderStatus;
  fee: number;
  realizedPnl: number;
  error?: string;
  timestamp: string;
}

/**
 * A position held by the executor.
 */
export interface Position {
  symbol: string;
  quantity: number;
  avgEntryPrice: number;
  side: "long" | "short";
  unrealizedPnl?: number;
  marketValue?: number;
}

/**
 * Account balance / equity snapshot.
 */
export interface Balance {
  cash: number;
  equity: number;
  initialCash: number;
  peakEquity: number;
}

/**
 * The unified executor interface. All executors implement this.
 */
export interface Executor {
  /** Place an order. Returns the result (filled, pending, or rejected). */
  placeOrder(order: OrderRequest): Promise<OrderResult>;

  /** Cancel a pending order by ID. */
  cancelOrder(id: string): Promise<boolean>;

  /** Get all open positions. */
  getPositions(): Promise<Position[]>;

  /** Get account balance / equity. */
  getBalance(): Promise<Balance>;

  /** Get the executor name (for logging). */
  readonly name: string;
}