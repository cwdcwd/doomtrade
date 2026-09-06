/**
 * AlpacaExecutor — live/paper stock trading via the Alpaca Trade API.
 *
 * Wraps `@alpacahq/alpaca-trade-api` (v4) and adapts it to the unified
 * Executor interface. The SDK is imported dynamically so the package is
 * only required when this executor is actually used; if it is missing a
 * clear error is thrown on construction.
 */

import type {
  Balance,
  Executor,
  OrderRequest,
  OrderResult,
  Position,
} from "./executor.js";

export interface AlpacaConfig {
  keyId: string;
  secretKey: string;
  /** Use Alpaca's paper-trading endpoint when true. */
  paper: boolean;
}

/**
 * Minimal structural type for the pieces of the Alpaca SDK we call.
 * We keep this local so tsc doesn't need the package installed.
 */
interface AlpacaOrderParams {
  symbol: string;
  qty: number;
  side: "buy" | "sell";
  type: "market" | "limit" | "stop" | "stop_limit";
  time_in_force: "day" | "gtc" | "ioc" | "fok";
  limit_price?: number;
  stop_price?: number;
  client_order_id?: string;
}

interface AlpacaOrderResponse {
  id: string;
  client_order_id?: string;
  symbol: string;
  side: string;
  type: string;
  qty: string;
  filled_avg_price: string | null;
  status: string;
  created_at: string;
}

interface AlpacaPositionResponse {
  symbol: string;
  qty: string;
  avg_entry_price: string;
  side: string;
  unrealized_pl?: string;
  market_value?: string;
}

interface AlpacaAccountResponse {
  id: string;
  cash: string;
  equity: string;
  created_at: string;
}

interface AlpacaClient {
  submitOrder(params: AlpacaOrderParams): Promise<AlpacaOrderResponse>;
  cancelOrder(id: string): Promise<void>;
  getPositions(): Promise<AlpacaPositionResponse[]>;
  getAccount(): Promise<AlpacaAccountResponse>;
}

interface AlpacaSdk {
  Alpaca: new (options: {
    keyId: string;
    secretKey: string;
    paper: boolean;
  }) => AlpacaClient;
}

/** Cache the dynamically imported SDK across instances. */
let sdkCache: AlpacaSdk | null = null;

async function loadSdk(): Promise<AlpacaSdk> {
  if (sdkCache) return sdkCache;
  try {
    // Dynamic import — the package is optional. @ts-expect-error suppresses
    // TS2307 when the package is not installed.
    // @ts-expect-error — optional dependency, may not be installed
    const mod = (await import("@alpacahq/alpaca-trade-api")) as unknown;
    // The v4 SDK exposes a named `Alpaca` constructor.
    if (mod && typeof (mod as Record<string, unknown>).Alpaca === "function") {
      sdkCache = mod as AlpacaSdk;
      return sdkCache;
    }
    // Some bundlings expose the constructor as the default export.
    if (mod && typeof mod === "function") {
      const ctor = mod as unknown as new (o: {
        keyId: string;
        secretKey: string;
        paper: boolean;
      }) => AlpacaClient;
      sdkCache = { Alpaca: ctor };
      return sdkCache;
    }
  } catch {
    // fall through to the error below
  }
  throw new Error(
    "@alpacahq/alpaca-trade-api is not installed. " +
      "Install it with `npm install @alpacahq/alpaca-trade-api` to use AlpacaExecutor.",
  );
}

function toNum(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isNaN(n) ? null : n;
}

/** Map Alpaca order status string to our OrderStatus. */
function mapStatus(raw: string): OrderResult["status"] {
  const s = raw.toLowerCase();
  if (s === "filled" || s === "partially_filled") return "filled";
  if (s === "cancelled" || s === "canceled") return "cancelled";
  if (s === "rejected" || s === "expired") return "rejected";
  // new / accepted / pending_new / done_for_day etc.
  return "pending";
}

export class AlpacaExecutor implements Executor {
  readonly name: string;
  private client: AlpacaClient | null = null;
  private readonly config: AlpacaConfig;

  constructor(config: AlpacaConfig) {
    if (!config.keyId || !config.secretKey) {
      throw new Error("AlpacaExecutor requires keyId and secretKey");
    }
    this.config = config;
    this.name = config.paper ? "alpaca-paper" : "alpaca-live";
  }

  /** Lazily create the underlying Alpaca client. */
  private async getClient(): Promise<AlpacaClient> {
    if (this.client) return this.client;
    const sdk = await loadSdk();
    this.client = new sdk.Alpaca({
      keyId: this.config.keyId,
      secretKey: this.config.secretKey,
      paper: this.config.paper,
    });
    return this.client;
  }

  async placeOrder(order: OrderRequest): Promise<OrderResult> {
    const client = await this.getClient();

    if (order.quantity <= 0) {
      return this.reject(order, "Quantity must be positive");
    }
    if (order.orderType === "limit" && order.limitPrice == null) {
      return this.reject(order, "Limit orders require a limitPrice");
    }
    if (order.orderType === "stop" && order.stopPrice == null) {
      return this.reject(order, "Stop orders require a stopPrice");
    }

    const params: AlpacaOrderParams = {
      symbol: order.symbol,
      qty: order.quantity,
      side: order.side,
      type: order.orderType, // "market" | "limit" | "stop"
      time_in_force: "day",
      client_order_id: order.clientOrderId,
    };
    if (order.orderType === "limit") {
      params.limit_price = order.limitPrice;
    }
    if (order.orderType === "stop") {
      params.stop_price = order.stopPrice;
    }

    try {
      const resp = await client.submitOrder(params);
      const fillPrice = toNum(resp.filled_avg_price);
      return {
        id: resp.id,
        clientOrderId: resp.client_order_id ?? order.clientOrderId,
        symbol: resp.symbol,
        side: order.side,
        orderType: order.orderType,
        quantity: order.quantity,
        fillPrice,
        status: mapStatus(resp.status),
        fee: 0,
        realizedPnl: 0,
        timestamp: resp.created_at ?? new Date().toISOString(),
      };
    } catch (err) {
      return this.reject(
        order,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  async cancelOrder(id: string): Promise<boolean> {
    const client = await this.getClient();
    try {
      await client.cancelOrder(id);
      return true;
    } catch {
      return false;
    }
  }

  async getPositions(): Promise<Position[]> {
    const client = await this.getClient();
    const raw = await client.getPositions();
    return raw.map((p) => ({
      symbol: p.symbol,
      quantity: Number(p.qty),
      avgEntryPrice: Number(p.avg_entry_price),
      side: p.side === "short" ? "short" : "long",
      unrealizedPnl: toNum(p.unrealized_pl) ?? undefined,
      marketValue: toNum(p.market_value) ?? undefined,
    }));
  }

  async getBalance(): Promise<Balance> {
    const client = await this.getClient();
    const acct = await client.getAccount();
    const cash = toNum(acct.cash) ?? 0;
    const equity = toNum(acct.equity) ?? cash;
    return {
      cash,
      equity,
      initialCash: cash, // Alpaca does not expose initial cash directly
      peakEquity: equity, // Alpaca does not expose peak equity directly
    };
  }

  private reject(order: OrderRequest, error: string): OrderResult {
    return {
      id: "",
      clientOrderId: order.clientOrderId,
      symbol: order.symbol,
      side: order.side,
      orderType: order.orderType,
      quantity: order.quantity,
      fillPrice: null,
      status: "rejected",
      fee: 0,
      realizedPnl: 0,
      error,
      timestamp: new Date().toISOString(),
    };
  }
}