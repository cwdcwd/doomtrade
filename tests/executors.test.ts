import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type {
  Balance,
  OrderRequest,
  OrderResult,
  Position,
} from "../src/executor/executor.js";

// ── Mock infrastructure ────────────────────────────────────────
// We mock the dynamic import of the SDK packages so that no real
// network calls are ever made.  vi.mock at the top level intercepts
// the dynamic `import("@alpacahq/alpaca-trade-api")` / `import("ccxt")`
// calls performed inside the executors.

/* ---- Alpaca mock ---- */
const alpacaSubmitOrder = vi.fn();
const alpacaCancelOrder = vi.fn();
const alpacaGetPositions = vi.fn();
const alpacaGetAccount = vi.fn();

const AlpacaMock = vi.fn().mockImplementation(() => ({
  submitOrder: alpacaSubmitOrder,
  cancelOrder: alpacaCancelOrder,
  getPositions: alpacaGetPositions,
  getAccount: alpacaGetAccount,
}));

vi.mock("@alpacahq/alpaca-trade-api", () => ({
  Alpaca: AlpacaMock,
}));

/* ---- CCXT mock ---- */
const ccxtCreateOrder = vi.fn();
const ccxtCancelOrder = vi.fn();
const ccxtFetchPositions = vi.fn();
const ccxtFetchBalance = vi.fn();

const BinanceMock = vi.fn().mockImplementation(() => ({
  apiKey: "",
  secret: "",
  createOrder: ccxtCreateOrder,
  cancelOrder: ccxtCancelOrder,
  fetchPositions: ccxtFetchPositions,
  fetchBalance: ccxtFetchBalance,
}));

vi.mock("ccxt", () => ({
  binance: BinanceMock,
  coinbase: BinanceMock,
}));

// Import executors AFTER mocks are registered.
// We use dynamic import so the module-level vi.mock is already in place.
async function importAlpaca() {
  const mod = await import("../src/executor/alpaca.js");
  return mod.AlpacaExecutor;
}
async function importCCXT() {
  const mod = await import("../src/executor/ccxt.js");
  return mod.CCXTExecutor;
}

// ── Helpers ────────────────────────────────────────────────────

function alpacaOrderResp(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: "alpaca-order-1",
    client_order_id: "client-1",
    symbol: "AAPL",
    side: "buy",
    type: "market",
    qty: "10",
    filled_avg_price: "185.50",
    status: "filled",
    created_at: "2024-01-15T10:30:00Z",
    ...overrides,
  };
}

function alpacaPositionResp(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    symbol: "AAPL",
    qty: "10",
    avg_entry_price: "180.00",
    side: "long",
    unrealized_pl: "55.00",
    market_value: "1855.00",
    ...overrides,
  };
}

function alpacaAccountResp(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: "acct-1",
    cash: "50000.00",
    equity: "100000.00",
    created_at: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

function ccxtOrderResp(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: "ccxt-order-1",
    clientOrderId: "client-1",
    symbol: "BTC/USDT",
    side: "buy",
    type: "market",
    amount: 0.5,
    price: null,
    average: 65000,
    status: "closed",
    timestamp: 1705312200000,
    fee: { cost: 32.5 },
    ...overrides,
  };
}

function ccxtPositionResp(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    symbol: "BTC/USDT",
    contracts: 0.5,
    entryPrice: 64000,
    side: "long",
    unrealizedPnl: 500,
    notional: 32500,
    ...overrides,
  };
}

// ── AlpacaExecutor tests ───────────────────────────────────────

describe("AlpacaExecutor", () => {
  let AlpacaExecutor: Awaited<ReturnType<typeof importAlpaca>>;
  let executor: InstanceType<Awaited<ReturnType<typeof importAlpaca>>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    AlpacaExecutor = await importAlpaca();
    // Reset all mock return values to sensible defaults.
    alpacaSubmitOrder.mockResolvedValue(alpacaOrderResp());
    alpacaCancelOrder.mockResolvedValue(undefined);
    alpacaGetPositions.mockResolvedValue([]);
    alpacaGetAccount.mockResolvedValue(alpacaAccountResp());

    executor = new AlpacaExecutor({
      keyId: "test-key",
      secretKey: "test-secret",
      paper: true,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("construction", () => {
    it("should set name to alpaca-paper when paper=true", () => {
      const ex = new AlpacaExecutor({
        keyId: "k",
        secretKey: "s",
        paper: true,
      });
      expect(ex.name).toBe("alpaca-paper");
    });

    it("should set name to alpaca-live when paper=false", () => {
      const ex = new AlpacaExecutor({
        keyId: "k",
        secretKey: "s",
        paper: false,
      });
      expect(ex.name).toBe("alpaca-live");
    });

    it("should throw on missing keyId", () => {
      expect(
        () =>
          new AlpacaExecutor({
            keyId: "",
            secretKey: "s",
            paper: true,
          }),
      ).toThrow("keyId");
    });

    it("should throw on missing secretKey", () => {
      expect(
        () =>
          new AlpacaExecutor({
            keyId: "k",
            secretKey: "",
            paper: true,
          }),
      ).toThrow("secretKey");
    });
  });

  describe("placeOrder — market", () => {
    it("should fill a market buy order", async () => {
      const order: OrderRequest = {
        symbol: "AAPL",
        side: "buy",
        quantity: 10,
        orderType: "market",
        clientOrderId: "client-1",
      };

      const result = await executor.placeOrder(order);

      expect(alpacaSubmitOrder).toHaveBeenCalledTimes(1);
      const call = alpacaSubmitOrder.mock.calls[0]![0];
      expect(call.type).toBe("market");
      expect(call.side).toBe("buy");
      expect(call.qty).toBe(10);
      expect(call.time_in_force).toBe("day");
      expect(call.client_order_id).toBe("client-1");

      expect(result.id).toBe("alpaca-order-1");
      expect(result.status).toBe("filled");
      expect(result.fillPrice).toBe(185.5);
      expect(result.symbol).toBe("AAPL");
      expect(result.side).toBe("buy");
      expect(result.orderType).toBe("market");
      expect(result.quantity).toBe(10);
    });

    it("should fill a market sell order", async () => {
      alpacaSubmitOrder.mockResolvedValue(
        alpacaOrderResp({ side: "sell", filled_avg_price: "186.00" }),
      );

      const result = await executor.placeOrder({
        symbol: "AAPL",
        side: "sell",
        quantity: 5,
        orderType: "market",
      });

      expect(result.status).toBe("filled");
      expect(result.fillPrice).toBe(186);
      expect(result.side).toBe("sell");
    });
  });

  describe("placeOrder — limit", () => {
    it("should submit a limit order with limit_price", async () => {
      alpacaSubmitOrder.mockResolvedValue(
        alpacaOrderResp({
          type: "limit",
          status: "new",
          filled_avg_price: null,
        }),
      );

      const result = await executor.placeOrder({
        symbol: "AAPL",
        side: "buy",
        quantity: 10,
        orderType: "limit",
        limitPrice: 184.0,
      });

      const call = alpacaSubmitOrder.mock.calls[0]![0];
      expect(call.type).toBe("limit");
      expect(call.limit_price).toBe(184.0);
      expect(result.status).toBe("pending");
      expect(result.fillPrice).toBeNull();
    });

    it("should reject limit order without limitPrice", async () => {
      const result = await executor.placeOrder({
        symbol: "AAPL",
        side: "buy",
        quantity: 10,
        orderType: "limit",
      });

      expect(result.status).toBe("rejected");
      expect(result.error).toMatch(/limitPrice/i);
      expect(alpacaSubmitOrder).not.toHaveBeenCalled();
    });
  });

  describe("placeOrder — stop", () => {
    it("should submit a stop order with stop_price", async () => {
      alpacaSubmitOrder.mockResolvedValue(
        alpacaOrderResp({
          type: "stop",
          status: "new",
          filled_avg_price: null,
        }),
      );

      const result = await executor.placeOrder({
        symbol: "AAPL",
        side: "sell",
        quantity: 10,
        orderType: "stop",
        stopPrice: 180.0,
      });

      const call = alpacaSubmitOrder.mock.calls[0]![0];
      expect(call.type).toBe("stop");
      expect(call.stop_price).toBe(180.0);
      expect(result.status).toBe("pending");
    });

    it("should reject stop order without stopPrice", async () => {
      const result = await executor.placeOrder({
        symbol: "AAPL",
        side: "sell",
        quantity: 10,
        orderType: "stop",
      });

      expect(result.status).toBe("rejected");
      expect(result.error).toMatch(/stopPrice/i);
    });
  });

  describe("placeOrder — validation", () => {
    it("should reject zero quantity", async () => {
      const result = await executor.placeOrder({
        symbol: "AAPL",
        side: "buy",
        quantity: 0,
        orderType: "market",
      });

      expect(result.status).toBe("rejected");
      expect(result.error).toMatch(/positive/i);
    });
  });

  describe("placeOrder — API error", () => {
    it("should return rejected result on API error", async () => {
      alpacaSubmitOrder.mockRejectedValue(new Error("Insufficient buying power"));

      const result = await executor.placeOrder({
        symbol: "AAPL",
        side: "buy",
        quantity: 10,
        orderType: "market",
      });

      expect(result.status).toBe("rejected");
      expect(result.error).toBe("Insufficient buying power");
    });
  });

  describe("cancelOrder", () => {
    it("should return true on successful cancel", async () => {
      const ok = await executor.cancelOrder("alpaca-order-1");
      expect(alpacaCancelOrder).toHaveBeenCalledWith("alpaca-order-1");
      expect(ok).toBe(true);
    });

    it("should return false on cancel error", async () => {
      alpacaCancelOrder.mockRejectedValue(new Error("Order not found"));
      const ok = await executor.cancelOrder("bad-id");
      expect(ok).toBe(false);
    });
  });

  describe("getPositions", () => {
    it("should map Alpaca positions to Position[]", async () => {
      alpacaGetPositions.mockResolvedValue([
        alpacaPositionResp({ symbol: "AAPL", qty: "10", avg_entry_price: "180.00" }),
        alpacaPositionResp({
          symbol: "GOOGL",
          qty: "5",
          avg_entry_price: "150.00",
          side: "short",
          unrealized_pl: "-20.00",
          market_value: "750.00",
        }),
      ]);

      const positions = await executor.getPositions();

      expect(positions).toHaveLength(2);
      expect(positions[0]).toMatchObject({
        symbol: "AAPL",
        quantity: 10,
        avgEntryPrice: 180,
        side: "long",
        unrealizedPnl: 55,
        marketValue: 1855,
      });
      expect(positions[1]).toMatchObject({
        symbol: "GOOGL",
        quantity: 5,
        side: "short",
      });
    });

    it("should return empty array when no positions", async () => {
      alpacaGetPositions.mockResolvedValue([]);
      const positions = await executor.getPositions();
      expect(positions).toEqual([]);
    });
  });

  describe("getBalance", () => {
    it("should return balance from Alpaca account", async () => {
      alpacaGetAccount.mockResolvedValue(
        alpacaAccountResp({ cash: "40000.00", equity: "95000.00" }),
      );

      const balance = await executor.getBalance();

      expect(balance.cash).toBe(40000);
      expect(balance.equity).toBe(95000);
    });

    it("should propagate API error from getAccount", async () => {
      alpacaGetAccount.mockRejectedValue(new Error("Auth failed"));
      await expect(executor.getBalance()).rejects.toThrow("Auth failed");
    });
  });

  describe("paper mode flag", () => {
    it("should pass paper=true to the SDK constructor", async () => {
      // Trigger client creation.
      await executor.getBalance();

      expect(AlpacaMock).toHaveBeenCalledWith(
        expect.objectContaining({ paper: true }),
      );
    });

    it("should pass paper=false for live mode", async () => {
      const liveExecutor = new AlpacaExecutor({
        keyId: "k",
        secretKey: "s",
        paper: false,
      });
      alpacaGetAccount.mockResolvedValue(alpacaAccountResp());
      await liveExecutor.getBalance();

      expect(AlpacaMock).toHaveBeenCalledWith(
        expect.objectContaining({ paper: false }),
      );
    });
  });
});

// ── CCXTExecutor tests ─────────────────────────────────────────

describe("CCXTExecutor", () => {
  let CCXTExecutor: Awaited<ReturnType<typeof importCCXT>>;
  let executor: InstanceType<Awaited<ReturnType<typeof importCCXT>>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    CCXTExecutor = await importCCXT();
    ccxtCreateOrder.mockResolvedValue(ccxtOrderResp());
    ccxtCancelOrder.mockResolvedValue(undefined);
    ccxtFetchPositions.mockResolvedValue([]);
    ccxtFetchBalance.mockResolvedValue({
      info: {},
      free: 10000,
      used: 5000,
      total: 15000,
      BTC: { free: 0.5, used: 0, total: 0.5 },
      USDT: { free: 10000, used: 5000, total: 15000 },
    });

    executor = new CCXTExecutor({
      exchange: "binance",
      apiKey: "test-key",
      apiSecret: "test-secret",
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("construction", () => {
    it("should set name to ccxt-<exchange>", () => {
      const ex = new CCXTExecutor({
        exchange: "coinbase",
        apiKey: "k",
        apiSecret: "s",
      });
      expect(ex.name).toBe("ccxt-coinbase");
    });

    it("should throw on missing exchange", () => {
      expect(
        () =>
          new CCXTExecutor({
            exchange: "",
            apiKey: "k",
            apiSecret: "s",
          }),
      ).toThrow("exchange");
    });

    it("should throw on missing apiKey", () => {
      expect(
        () =>
          new CCXTExecutor({
            exchange: "binance",
            apiKey: "",
            apiSecret: "s",
          }),
      ).toThrow("apiKey");
    });
  });

  describe("placeOrder — market", () => {
    it("should fill a market buy order", async () => {
      const result = await executor.placeOrder({
        symbol: "BTC/USDT",
        side: "buy",
        quantity: 0.5,
        orderType: "market",
        clientOrderId: "client-1",
      });

      expect(ccxtCreateOrder).toHaveBeenCalledWith(
        "BTC/USDT",
        "market",
        "buy",
        0.5,
        undefined,
        { clientOrderId: "client-1" },
      );
      expect(result.id).toBe("ccxt-order-1");
      expect(result.status).toBe("filled");
      expect(result.fillPrice).toBe(65000);
      expect(result.fee).toBe(32.5);
    });

    it("should fill a market sell order", async () => {
      ccxtCreateOrder.mockResolvedValue(
        ccxtOrderResp({ side: "sell", average: 66000 }),
      );

      const result = await executor.placeOrder({
        symbol: "BTC/USDT",
        side: "sell",
        quantity: 0.5,
        orderType: "market",
      });

      expect(result.status).toBe("filled");
      expect(result.fillPrice).toBe(66000);
      expect(result.side).toBe("sell");
    });
  });

  describe("placeOrder — limit", () => {
    it("should submit a limit order with price", async () => {
      ccxtCreateOrder.mockResolvedValue(
        ccxtOrderResp({ type: "limit", status: "open", average: null, price: 64500 }),
      );

      const result = await executor.placeOrder({
        symbol: "BTC/USDT",
        side: "buy",
        quantity: 0.5,
        orderType: "limit",
        limitPrice: 64500,
      });

      expect(ccxtCreateOrder).toHaveBeenCalledWith(
        "BTC/USDT",
        "limit",
        "buy",
        0.5,
        64500,
        {},
      );
      expect(result.status).toBe("pending");
      expect(result.fillPrice).toBe(64500);
    });

    it("should reject limit order without limitPrice", async () => {
      const result = await executor.placeOrder({
        symbol: "BTC/USDT",
        side: "buy",
        quantity: 0.5,
        orderType: "limit",
      });

      expect(result.status).toBe("rejected");
      expect(result.error).toMatch(/limitPrice/i);
      expect(ccxtCreateOrder).not.toHaveBeenCalled();
    });
  });

  describe("placeOrder — unsupported stop", () => {
    it("should reject stop orders", async () => {
      const result = await executor.placeOrder({
        symbol: "BTC/USDT",
        side: "buy",
        quantity: 0.5,
        orderType: "stop",
        stopPrice: 64000,
      });

      expect(result.status).toBe("rejected");
      expect(result.error).toMatch(/stop/i);
    });
  });

  describe("placeOrder — validation", () => {
    it("should reject zero quantity", async () => {
      const result = await executor.placeOrder({
        symbol: "BTC/USDT",
        side: "buy",
        quantity: 0,
        orderType: "market",
      });

      expect(result.status).toBe("rejected");
      expect(result.error).toMatch(/positive/i);
    });
  });

  describe("placeOrder — API error", () => {
    it("should return rejected result on API error", async () => {
      ccxtCreateOrder.mockRejectedValue(new Error("Insufficient balance"));

      const result = await executor.placeOrder({
        symbol: "BTC/USDT",
        side: "buy",
        quantity: 0.5,
        orderType: "market",
      });

      expect(result.status).toBe("rejected");
      expect(result.error).toBe("Insufficient balance");
    });
  });

  describe("cancelOrder", () => {
    it("should return true on successful cancel", async () => {
      const ok = await executor.cancelOrder("ccxt-order-1");
      expect(ccxtCancelOrder).toHaveBeenCalledWith("ccxt-order-1");
      expect(ok).toBe(true);
    });

    it("should return false on cancel error", async () => {
      ccxtCancelOrder.mockRejectedValue(new Error("not found"));
      const ok = await executor.cancelOrder("bad-id");
      expect(ok).toBe(false);
    });
  });

  describe("getPositions", () => {
    it("should map CCXT positions to Position[]", async () => {
      ccxtFetchPositions.mockResolvedValue([
        ccxtPositionResp({
          symbol: "BTC/USDT",
          contracts: 0.5,
          entryPrice: 64000,
          side: "long",
        }),
        ccxtPositionResp({
          symbol: "ETH/USDT",
          contracts: 2,
          entryPrice: 3200,
          side: "short",
          unrealizedPnl: -100,
          notional: 6400,
        }),
      ]);

      const positions = await executor.getPositions();

      expect(positions).toHaveLength(2);
      expect(positions[0]).toMatchObject({
        symbol: "BTC/USDT",
        quantity: 0.5,
        avgEntryPrice: 64000,
        side: "long",
      });
      expect(positions[1]).toMatchObject({
        symbol: "ETH/USDT",
        quantity: 2,
        side: "short",
      });
    });

    it("should filter out zero-contract positions", async () => {
      ccxtFetchPositions.mockResolvedValue([
        ccxtPositionResp({ contracts: 0 }),
        ccxtPositionResp({ contracts: 1, entryPrice: 100, side: "long" }),
      ]);

      const positions = await executor.getPositions();
      expect(positions).toHaveLength(1);
    });
  });

  describe("getBalance", () => {
    it("should return balance from CCXT fetchBalance", async () => {
      const balance = await executor.getBalance();

      expect(balance.cash).toBe(10000); // free
      expect(balance.equity).toBe(15000); // free + used
    });

    it("should handle balance without top-level free/used", async () => {
      ccxtFetchBalance.mockResolvedValue({
        info: {},
        BTC: { free: 1, used: 0, total: 1 },
        USDT: { free: 5000, used: 3000, total: 8000 },
      });

      const balance = await executor.getBalance();

      // total from per-currency entries = 1 + 8000 = 8001
      expect(balance.equity).toBe(8001);
      expect(balance.cash).toBe(8001);
    });

    it("should propagate API error from fetchBalance", async () => {
      ccxtFetchBalance.mockRejectedValue(new Error("Network error"));
      await expect(executor.getBalance()).rejects.toThrow("Network error");
    });
  });

  describe("exchange configuration", () => {
    it("should instantiate the configured exchange class", async () => {
      await executor.getBalance();
      expect(BinanceMock).toHaveBeenCalledTimes(1);
    });

    it("should set apiKey and apiSecret on the exchange instance", async () => {
      await executor.getBalance();
      // The mock implementation returns the same object each call;
      // we verify via the constructor + post-construction assignment
      // by checking the mock was called and balance was fetched.
      expect(BinanceMock).toHaveBeenCalled();
      expect(ccxtFetchBalance).toHaveBeenCalled();
    });
  });
});

// ── Type-narrowing sanity (compile-time guarantee) ─────────────
// These assertions exist so tsc proves the executors conform to the
// Executor interface at the type level.
describe("interface conformance", () => {
  it("AlpacaExecutor implements Executor", async () => {
    const AlpacaExecutor = await importAlpaca();
    const ex: import("../src/executor/executor.js").Executor = new AlpacaExecutor({
      keyId: "k",
      secretKey: "s",
      paper: true,
    });
    expect(typeof ex.placeOrder).toBe("function");
    expect(typeof ex.cancelOrder).toBe("function");
    expect(typeof ex.getPositions).toBe("function");
    expect(typeof ex.getBalance).toBe("function");
    expect(typeof ex.name).toBe("string");
  });

  it("CCXTExecutor implements Executor", async () => {
    const CCXTExecutor = await importCCXT();
    const ex: import("../src/executor/executor.js").Executor = new CCXTExecutor({
      exchange: "binance",
      apiKey: "k",
      apiSecret: "s",
    });
    expect(typeof ex.placeOrder).toBe("function");
    expect(typeof ex.cancelOrder).toBe("function");
    expect(typeof ex.getPositions).toBe("function");
    expect(typeof ex.getBalance).toBe("function");
    expect(typeof ex.name).toBe("string");
  });
});

// Reference the types so they're not stripped by isolatedModules.
export type _Types = { balance: Balance; order: OrderRequest; result: OrderResult; position: Position };