/**
 * CCXTExecutor — live crypto trading via the CCXT library.
 *
 * Wraps `ccxt` and adapts it to the unified Executor interface. The
 * library is imported dynamically so it is only required when this
 * executor is actually used; if it is missing a clear error is thrown.
 */

import type {
  Balance,
  Executor,
  OrderRequest,
  OrderResult,
  Position,
} from "./executor.js";

export interface CCXTConfig {
  /** Exchange id, e.g. "binance", "coinbase", "kraken". */
  exchange: string;
  apiKey: string;
  apiSecret: string;
}

/** Structural type for the slice of a CCXT exchange instance we use. */
interface CCXTOrder {
  id: string;
  clientOrderId?: string;
  symbol: string;
  side: string;
  type: string;
  amount: number;
  price: number | null;
  average: number | null;
  status: string;
  timestamp: number;
  cost?: number;
  fee?: { cost?: number } | undefined;
}

interface CCXTPosition {
  symbol: string;
  contracts: number;
  entryPrice: number;
  side: string;
  unrealizedPnl?: number;
  markPrice?: number;
  collateral?: number;
  notional?: number;
}

interface CCXTBalanceEntry {
  free: number;
  used: number;
  total: number;
}

interface CCXTBalanceResponse {
  info: unknown;
  [currency: string]: CCXTBalanceEntry | unknown;
}

interface CCXTExchange {
  apiKey: string;
  secret: string;
  createOrder(
    symbol: string,
    type: string,
    side: string,
    amount: number,
    price?: number,
    params?: Record<string, unknown>,
  ): Promise<CCXTOrder>;
  cancelOrder(id: string, symbol?: string): Promise<unknown>;
  fetchPositions(symbols?: string[]): Promise<CCXTPosition[]>;
  fetchBalance(params?: Record<string, unknown>): Promise<CCXTBalanceResponse>;
}

interface CCXTLibrary {
  exchange: Record<string, new () => CCXTExchange>;
}

let libCache: CCXTLibrary | null = null;

async function loadLib(): Promise<CCXTLibrary> {
  if (libCache) return libCache;
  try {
    // Dynamic import — the package is optional. @ts-expect-error suppresses
    // TS2307 when the package is not installed.
    // @ts-expect-error — optional dependency, may not be installed
    const mod = (await import("ccxt")) as unknown;
    // ccxt exports exchange classes under `ccxt.<id>` and sometimes as named.
    const lib = mod as Record<string, unknown>;
    if (lib && typeof lib === "object") {
      libCache = {
        exchange: lib as unknown as Record<string, new () => CCXTExchange>,
      };
      return libCache;
    }
  } catch {
    // fall through
  }
  throw new Error(
    "ccxt is not installed. Install it with `npm install ccxt` to use CCXTExecutor.",
  );
}

/** Map a CCXT order status to our OrderStatus. */
function mapStatus(raw: string): OrderResult["status"] {
  const s = raw.toLowerCase();
  if (s === "closed" || s === "filled") return "filled";
  if (s === "canceled" || s === "cancelled" || s === "expired") return "cancelled";
  if (s === "rejected") return "rejected";
  // open / pending etc.
  return "pending";
}

export class CCXTExecutor implements Executor {
  readonly name: string;
  private exchange: CCXTExchange | null = null;
  private readonly config: CCXTConfig;

  constructor(config: CCXTConfig) {
    if (!config.exchange) {
      throw new Error("CCXTExecutor requires an exchange id");
    }
    if (!config.apiKey || !config.apiSecret) {
      throw new Error("CCXTExecutor requires apiKey and apiSecret");
    }
    this.config = config;
    this.name = `ccxt-${config.exchange}`;
  }

  /** Lazily instantiate the configured CCXT exchange. */
  private async getExchange(): Promise<CCXTExchange> {
    if (this.exchange) return this.exchange;
    const lib = await loadLib();
    const ExchangeCtor = lib.exchange[this.config.exchange];
    if (!ExchangeCtor || typeof ExchangeCtor !== "function") {
      throw new Error(
        `Unknown CCXT exchange "${this.config.exchange}". ` +
          "Check the exchange id against the ccxt documentation.",
      );
    }
    const ex = new ExchangeCtor();
    ex.apiKey = this.config.apiKey;
    ex.secret = this.config.apiSecret;
    this.exchange = ex;
    return this.exchange;
  }

  async placeOrder(order: OrderRequest): Promise<OrderResult> {
    const ex = await this.getExchange();

    if (order.quantity <= 0) {
      return this.reject(order, "Quantity must be positive");
    }
    if (order.orderType === "limit" && order.limitPrice == null) {
      return this.reject(order, "Limit orders require a limitPrice");
    }
    if (order.orderType === "stop") {
      return this.reject(order, "Stop orders are not supported by CCXTExecutor");
    }

    try {
      const params: Record<string, unknown> = {};
      if (order.clientOrderId) {
        params.clientOrderId = order.clientOrderId;
      }
      const raw = await ex.createOrder(
        order.symbol,
        order.orderType, // "market" | "limit"
        order.side,
        order.quantity,
        order.orderType === "limit" ? order.limitPrice : undefined,
        params,
      );

      const fillPrice =
        raw.average ?? raw.price ?? null;

      return {
        id: raw.id,
        clientOrderId: raw.clientOrderId ?? order.clientOrderId,
        symbol: raw.symbol ?? order.symbol,
        side: order.side,
        orderType: order.orderType,
        quantity: order.quantity,
        fillPrice,
        status: mapStatus(raw.status),
        fee: raw.fee?.cost ?? 0,
        realizedPnl: 0,
        timestamp: raw.timestamp
          ? new Date(raw.timestamp).toISOString()
          : new Date().toISOString(),
      };
    } catch (err) {
      return this.reject(
        order,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  async cancelOrder(id: string): Promise<boolean> {
    const ex = await this.getExchange();
    try {
      await ex.cancelOrder(id);
      return true;
    } catch {
      return false;
    }
  }

  async getPositions(): Promise<Position[]> {
    const ex = await this.getExchange();
    const raw = await ex.fetchPositions();
    return raw
      .filter((p) => p.contracts && p.contracts !== 0)
      .map((p) => ({
        symbol: p.symbol,
        quantity: p.contracts,
        avgEntryPrice: p.entryPrice,
        side: p.side === "short" ? "short" : "long",
        unrealizedPnl: p.unrealizedPnl,
        marketValue: p.notional,
      }));
  }

  async getBalance(): Promise<Balance> {
    const ex = await this.getExchange();
    const resp = await ex.fetchBalance();

    let total = 0;
    for (const [key, val] of Object.entries(resp)) {
      if (key === "info" || key === "free" || key === "used" || key === "total") {
        continue;
      }
      if (val && typeof val === "object" && "total" in val) {
        const entry = val as CCXTBalanceEntry;
        if (typeof entry.total === "number") total += entry.total;
      }
    }

    const freeEntry = resp.free;
    const usedEntry = resp.used;
    const totalEntry = resp.total;

    const cash =
      typeof freeEntry === "number" ? freeEntry :
      typeof totalEntry === "number" ? totalEntry :
      total;
    const used =
      typeof usedEntry === "number" ? usedEntry : 0;

    return {
      cash,
      equity: cash + used,
      initialCash: cash, // not tracked by exchanges
      peakEquity: cash + used, // not tracked by exchanges
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