/**
 * Unit tests for CCXTExecutor with a MOCKED CCXT exchange object.
 * No real API calls are made — the exchange is a mock with vi.fn() methods.
 */

import { describe, it, expect, vi } from "vitest";

// ── Mock CCXT exchange factory ─────────────────────────────────

interface MockCCXTOrder {
  id: string;
  clientOrderId?: string;
  status: string;
  average?: number | null;
  price?: number | null;
  fee?: { cost?: number } | null;
  datetime?: string;
}

interface MockCCXTBalanceResponse {
  info: unknown;
  timestamp?: number;
  datetime?: string;
  free: Record<string, number>;
  used: Record<string, number>;
  total: Record<string, number>;
  [key: string]: unknown;
}

interface MockMarket {
  quote: string;
}

/**
 * Build a mock CCXT exchange instance with controllable responses.
 */
function createMockExchange(opts: {
  orderResponse?: MockCCXTOrder;
  orderError?: Error;
  cancelError?: Error;
  balanceResponse?: MockCCXTBalanceResponse;
  balanceError?: Error;
  markets?: Record<string, MockMarket>;
}) {
  const createOrder = vi.fn().mockImplementation(async () => {
    if (opts.orderError) throw opts.orderError;
    return (
      opts.orderResponse ?? {
        id: "ccxt-order-123",
        status: "closed",
        average: 65000.0,
        fee: { cost: 6.5 },
        datetime: "2025-06-01T12:00:00.000Z",
      }
    );
  });

  const cancelOrder = vi.fn().mockImplementation(async () => {
    if (opts.cancelError) throw opts.cancelError;
    return { id: "ccxt-order-123", status: "canceled" };
  });

  const fetchBalance = vi.fn().mockImplementation(async () => {
    if (opts.balanceError) throw opts.balanceError;
    return (
      opts.balanceResponse ?? {
        info: {},
        free: { BTC: 0.5, USDT: 50000 },
        used: { BTC: 0, USDT: 1000 },
        total: { BTC: 0.5, USDT: 51000 },
      }
    );
  });

  return {
    createOrder,
    cancelOrder,
    fetchBalance,
    markets: opts.markets ?? {
      "BTC/USDT": { quote: "USDT" },
      "ETH/USDT": { quote: "USDT" },
    },
    _mocks: { createOrder, cancelOrder, fetchBalance },
  };
}

describe("CCXTExecutor", () => {
  async function createExecutor(opts: Record<string, unknown> = {}) {
    const { CCXTExecutor } = await import("../src/executor/ccxt.js");
    const exchange = createMockExchange(opts) as unknown as Awaited<
      ReturnType<typeof import("ccxt")>["Exchange"]
    >;
    const executor = new CCXTExecutor({ exchange, initialCash: 100000 });
    return { executor, exchange };
  }

  describe("executor name", () => {
    it("should have name 'ccxt'", async () => {
      const { executor } = await createExecutor();
      expect(executor.name).toBe("ccxt");
    });
  });

  describe("placeOrder — market orders", () => {
    it("should fill a market buy order and return correct OrderResult", async () => {
      const { executor } = await createExecutor({
        orderResponse: {
          id: "ccxt-1",
          status: "closed",
          average: 65000.0,
          fee: { cost: 6.5 },
          datetime: "2025-06-01T12:00:00.000Z",
        },
      });

      const result = await executor.placeOrder({
        symbol: "BTC/USDT",
        side: "buy",
        quantity: 0.1,
        orderType: "market",
      });

      expect(result.status).toBe("filled");
      expect(result.id).toBe("ccxt-1");
      expect(result.symbol).toBe("BTC/USDT");
      expect(result.side).toBe("buy");
      expect(result.orderType).toBe("market");
      expect(result.quantity).toBe(0.1);
      expect(result.fillPrice).toBe(65000.0);
      expect(result.fee).toBe(6.5);
    });

    it("should call createOrder with correct args for market order", async () => {
      const exchange = createMockExchange({});
      const { CCXTExecutor } = await import("../src/executor/ccxt.js");
      const executor = new CCXTExecutor({
        exchange: exchange as unknown as Awaited<
          ReturnType<typeof import("ccxt")>["Exchange"]
        >,
      });

      await executor.placeOrder({
        symbol: "BTC/USDT",
        side: "buy",
        quantity: 0.5,
        orderType: "market",
      });

      expect(exchange._mocks.createOrder).toHaveBeenCalledWith(
        "BTC/USDT",
        "market",
        "buy",
        0.5,
        undefined,
        {},
      );
    });

    it("should return pending for open orders", async () => {
      const { executor } = await createExecutor({
        orderResponse: {
          id: "ccxt-2",
          status: "open",
          average: null,
          fee: null,
          datetime: "2025-06-01T12:00:00.000Z",
        },
      });

      const result = await executor.placeOrder({
        symbol: "BTC/USDT",
        side: "buy",
        quantity: 0.1,
        orderType: "market",
      });

      expect(result.status).toBe("pending");
      expect(result.fillPrice).toBeNull();
    });
  });

  describe("placeOrder — limit orders", () => {
    it("should call createOrder with correct limit price", async () => {
      const exchange = createMockExchange({});
      const { CCXTExecutor } = await import("../src/executor/ccxt.js");
      const executor = new CCXTExecutor({
        exchange: exchange as unknown as Awaited<
          ReturnType<typeof import("ccxt")>["Exchange"]
        >,
      });

      await executor.placeOrder({
        symbol: "BTC/USDT",
        side: "buy",
        quantity: 0.1,
        orderType: "limit",
        limitPrice: 64000.0,
      });

      expect(exchange._mocks.createOrder).toHaveBeenCalledWith(
        "BTC/USDT",
        "limit",
        "buy",
        0.1,
        64000.0,
        {},
      );
    });

    it("should reject limit order without limitPrice", async () => {
      const { executor } = await createExecutor();

      const result = await executor.placeOrder({
        symbol: "BTC/USDT",
        side: "buy",
        quantity: 0.1,
        orderType: "limit",
      });

      expect(result.status).toBe("rejected");
      expect(result.error).toContain("limitPrice");
    });
  });

  describe("placeOrder — stop orders", () => {
    it("should reject stop orders with a clear error message", async () => {
      const { executor } = await createExecutor();

      const result = await executor.placeOrder({
        symbol: "BTC/USDT",
        side: "buy",
        quantity: 0.1,
        orderType: "stop",
        stopPrice: 63000.0,
      });

      expect(result.status).toBe("rejected");
      expect(result.error).toContain("Stop orders are not supported");
      expect(result.error).toContain("CCXTExecutor");
    });

    it("should not call createOrder for stop orders", async () => {
      const exchange = createMockExchange({});
      const { CCXTExecutor } = await import("../src/executor/ccxt.js");
      const executor = new CCXTExecutor({
        exchange: exchange as unknown as Awaited<
          ReturnType<typeof import("ccxt")>["Exchange"]
        >,
      });

      await executor.placeOrder({
        symbol: "BTC/USDT",
        side: "buy",
        quantity: 0.1,
        orderType: "stop",
        stopPrice: 63000.0,
      });

      expect(exchange._mocks.createOrder).not.toHaveBeenCalled();
    });
  });

  describe("placeOrder — clientOrderId", () => {
    it("should pass clientOrderId in params when provided", async () => {
      const exchange = createMockExchange({});
      const { CCXTExecutor } = await import("../src/executor/ccxt.js");
      const executor = new CCXTExecutor({
        exchange: exchange as unknown as Awaited<
          ReturnType<typeof import("ccxt")>["Exchange"]
        >,
      });

      await executor.placeOrder({
        symbol: "BTC/USDT",
        side: "buy",
        quantity: 0.1,
        orderType: "market",
        clientOrderId: "my-order-id",
      });

      expect(exchange._mocks.createOrder).toHaveBeenCalledWith(
        "BTC/USDT",
        "market",
        "buy",
        0.1,
        undefined,
        { clientOrderId: "my-order-id" },
      );
    });
  });

  describe("placeOrder — validation", () => {
    it("should reject order with zero quantity", async () => {
      const { executor } = await createExecutor();

      const result = await executor.placeOrder({
        symbol: "BTC/USDT",
        side: "buy",
        quantity: 0,
        orderType: "market",
      });

      expect(result.status).toBe("rejected");
      expect(result.error).toContain("Quantity must be positive");
    });

    it("should reject order with negative quantity", async () => {
      const { executor } = await createExecutor();

      const result = await executor.placeOrder({
        symbol: "BTC/USDT",
        side: "buy",
        quantity: -5,
        orderType: "market",
      });

      expect(result.status).toBe("rejected");
      expect(result.error).toContain("Quantity must be positive");
    });
  });

  describe("placeOrder — error handling", () => {
    it("should return rejected OrderResult on SDK error", async () => {
      const { executor } = await createExecutor({
        orderError: new Error("Insufficient funds"),
      });

      const result = await executor.placeOrder({
        symbol: "BTC/USDT",
        side: "buy",
        quantity: 10,
        orderType: "market",
      });

      expect(result.status).toBe("rejected");
      expect(result.error).toContain("CCXT order failed");
      expect(result.error).toContain("Insufficient funds");
      expect(result.fillPrice).toBeNull();
    });

    it("should not throw on SDK errors — always returns OrderResult", async () => {
      const { executor } = await createExecutor({
        orderError: new Error("Network timeout"),
      });

      const result = await executor.placeOrder({
        symbol: "BTC/USDT",
        side: "buy",
        quantity: 1,
        orderType: "market",
      });

      expect(result).toBeDefined();
      expect(result.status).toBe("rejected");
    });
  });

  describe("cancelOrder", () => {
    it("should return true on successful cancellation", async () => {
      const { executor } = await createExecutor();

      const result = await executor.cancelOrder("order-123");
      expect(result).toBe(true);
    });

    it("should return false on cancellation error", async () => {
      const { executor } = await createExecutor({
        cancelError: new Error("Order not found"),
      });

      const result = await executor.cancelOrder("nonexistent");
      expect(result).toBe(false);
    });
  });

  describe("getPositions", () => {
    it("should return positions from exchange balance", async () => {
      const { executor } = await createExecutor({
        balanceResponse: {
          info: {},
          free: { BTC: 0.5, USDT: 50000 },
          used: { BTC: 0, USDT: 1000 },
          total: { BTC: 0.5, USDT: 51000 },
        },
      });

      const positions = await executor.getPositions();

      expect(positions).toHaveLength(2);

      const btc = positions.find((p) => p.symbol === "BTC");
      expect(btc).toBeDefined();
      expect(btc!.quantity).toBe(0.5);
      expect(btc!.side).toBe("long");

      const usdt = positions.find((p) => p.symbol === "USDT");
      expect(usdt).toBeDefined();
      expect(usdt!.quantity).toBe(51000);
    });

    it("should filter out zero-quantity balances", async () => {
      const { executor } = await createExecutor({
        balanceResponse: {
          info: {},
          free: { BTC: 0, ETH: 2, USDT: 50000 },
          used: { BTC: 0, ETH: 0, USDT: 0 },
          total: { BTC: 0, ETH: 2, USDT: 50000 },
        },
      });

      const positions = await executor.getPositions();

      expect(positions).toHaveLength(2);
      expect(positions.find((p) => p.symbol === "BTC")).toBeUndefined();
    });

    it("should return empty array on API error", async () => {
      const { executor } = await createExecutor({
        balanceError: new Error("API unavailable"),
      });

      const positions = await executor.getPositions();
      expect(positions).toEqual([]);
    });
  });

  describe("getBalance", () => {
    it("should return balance with cash as quote currency free balance", async () => {
      const { executor } = await createExecutor({
        balanceResponse: {
          info: {},
          free: { BTC: 0.5, USDT: 50000 },
          used: { BTC: 0, USDT: 1000 },
          total: { BTC: 0.5, USDT: 51000 },
        },
      });

      const balance = await executor.getBalance();

      expect(balance.cash).toBe(50000); // USDT free balance
      expect(balance.equity).toBe(51000.5); // sum of total: 0.5 + 51000 = 51000.5
      expect(balance.initialCash).toBe(100000); // from constructor
      expect(balance.peakEquity).toBe(100000); // max(initial, equity)
    });

    it("should throw on balance API error", async () => {
      const { executor } = await createExecutor({
        balanceError: new Error("Auth failed"),
      });

      await expect(executor.getBalance()).rejects.toThrow("CCXT getBalance failed");
    });

    it("should use initialCash from config when provided", async () => {
      const { CCXTExecutor } = await import("../src/executor/ccxt.js");
      const exchange = createMockExchange({}) as unknown as Awaited<
        ReturnType<typeof import("ccxt")>["Exchange"]
      >;
      const executor = new CCXTExecutor({ exchange, initialCash: 50000 });

      const balance = await executor.getBalance();

      expect(balance.initialCash).toBe(50000);
    });

    it("should detect quote currency from markets", async () => {
      const exchange = createMockExchange({
        balanceResponse: {
          info: {},
          free: { BTC: 1, USD: 25000 },
          used: { BTC: 0, USD: 0 },
          total: { BTC: 1, USD: 25000 },
        },
        markets: {
          "BTC/USD": { quote: "USD" },
          "ETH/USD": { quote: "USD" },
        },
      });
      const { CCXTExecutor } = await import("../src/executor/ccxt.js");
      const executor = new CCXTExecutor({
        exchange: exchange as unknown as Awaited<
          ReturnType<typeof import("ccxt")>["Exchange"]
        >,
      });

      const balance = await executor.getBalance();

      expect(balance.cash).toBe(25000); // USD free balance
    });
  });

  describe("status mapping", () => {
    it("should map 'closed' to 'filled'", async () => {
      const { executor } = await createExecutor({
        orderResponse: {
          id: "order-1",
          status: "closed",
          average: 65000,
          fee: { cost: 6.5 },
          datetime: "2025-06-01T12:00:00.000Z",
        },
      });

      const result = await executor.placeOrder({
        symbol: "BTC/USDT",
        side: "buy",
        quantity: 0.1,
        orderType: "market",
      });

      expect(result.status).toBe("filled");
    });

    it("should map 'canceled' to 'cancelled'", async () => {
      const { executor } = await createExecutor({
        orderResponse: {
          id: "order-1",
          status: "canceled",
          average: null,
          fee: null,
          datetime: "2025-06-01T12:00:00.000Z",
        },
      });

      const result = await executor.placeOrder({
        symbol: "BTC/USDT",
        side: "buy",
        quantity: 0.1,
        orderType: "market",
      });

      expect(result.status).toBe("cancelled");
    });

    it("should map 'expired' to 'rejected'", async () => {
      const { executor } = await createExecutor({
        orderResponse: {
          id: "order-1",
          status: "expired",
          average: null,
          fee: null,
          datetime: "2025-06-01T12:00:00.000Z",
        },
      });

      const result = await executor.placeOrder({
        symbol: "BTC/USDT",
        side: "buy",
        quantity: 0.1,
        orderType: "market",
      });

      expect(result.status).toBe("rejected");
    });
  });
});