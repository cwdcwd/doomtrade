/**
 * Unit tests for AlpacaExecutor with a MOCKED Alpaca SDK.
 * No real API calls are made — the Alpaca client is mocked via vi.mock.
 */

import { describe, it, expect, beforeEach, vi, type MockInstance } from "vitest";

// ── Mock the Alpaca SDK module ──────────────────────────────────
// We mock the entire module so importing `Alpaca` gives us a fake constructor.

interface MockOrderResponse {
  id: string;
  status: string;
  filledQty: string;
  filledAvgPrice: string | null;
  createdAt: string;
  clientOrderId?: string;
}

interface MockAccount {
  cash: string;
  equity: string;
  lastEquity: string;
  portfolioValue: string;
}

interface MockPosition {
  symbol: string;
  qty: string;
  avgEntryPrice: string;
  side: string;
  unrealizedPl: string;
  marketValue: string;
  currentPrice: string;
}

/**
 * Build a mock Alpaca client with controllable responses.
 */
function createMockClient(opts: {
  orderResponse?: MockOrderResponse;
  accountResponse?: MockAccount;
  positionsResponse?: MockPosition[];
  orderError?: Error;
  cancelError?: Error;
  positionsError?: Error;
  accountError?: Error;
}) {
  const market = vi.fn().mockImplementation(async () => {
    if (opts.orderError) throw opts.orderError;
    return opts.orderResponse ?? {
      id: "test-order-id",
      status: "filled",
      filledQty: "100",
      filledAvgPrice: "185.50",
      createdAt: "2025-01-01T00:00:00Z",
    };
  });

  const limit = vi.fn().mockImplementation(async () => {
    if (opts.orderError) throw opts.orderError;
    return opts.orderResponse ?? {
      id: "test-order-id",
      status: "filled",
      filledQty: "100",
      filledAvgPrice: "180.00",
      createdAt: "2025-01-01T00:00:00Z",
    };
  });

  const stop = vi.fn().mockImplementation(async () => {
    if (opts.orderError) throw opts.orderError;
    return opts.orderResponse ?? {
      id: "test-order-id",
      status: "pending",
      filledQty: "0",
      filledAvgPrice: null,
      createdAt: "2025-01-01T00:00:00Z",
    };
  });

  const deleteOrderByOrderID = vi.fn().mockImplementation(async () => {
    if (opts.cancelError) throw opts.cancelError;
    return undefined;
  });

  const getAllOpenPositions = vi.fn().mockImplementation(async () => {
    if (opts.positionsError) throw opts.positionsError;
    return opts.positionsResponse ?? [];
  });

  const getAccount = vi.fn().mockImplementation(async () => {
    if (opts.accountError) throw opts.accountError;
    return opts.accountResponse ?? {
      cash: "50000.00",
      equity: "100000.00",
      lastEquity: "95000.00",
      portfolioValue: "100000.00",
    };
  });

  const orders = { market, limit, stop, deleteOrderByOrderID };
  const positions = { getAllOpenPositions };
  const account = { getAccount };

  return {
    trading: { orders, positions, account },
    // expose for assertion
    _mocks: { market, limit, stop, deleteOrderByOrderID, getAllOpenPositions, getAccount },
  };
}

describe("AlpacaExecutor", () => {
  // We'll build the executor with the mock client directly (no module mock needed).

  async function createExecutor(clientOverrides: Record<string, unknown> = {}) {
    const { AlpacaExecutor } = await import("../src/executor/alpaca.js");
    const client = createMockClient(clientOverrides) as unknown as Awaited<
      ReturnType<typeof import("@alpacahq/alpaca-trade-api")>["Alpaca"]
    >;
    const executor = new AlpacaExecutor({ client });
    return { executor, client };
  }

  describe("executor name", () => {
    it("should have name 'alpaca'", async () => {
      const { executor } = await createExecutor();
      expect(executor.name).toBe("alpaca");
    });
  });

  describe("placeOrder — market orders", () => {
    it("should fill a market buy order and return correct OrderResult", async () => {
      const { executor } = await createExecutor({
        orderResponse: {
          id: "alpaca-123",
          status: "filled",
          filledQty: "100",
          filledAvgPrice: "185.50",
          createdAt: "2025-06-01T12:00:00Z",
        },
      });

      const result = await executor.placeOrder({
        symbol: "AAPL",
        side: "buy",
        quantity: 100,
        orderType: "market",
      });

      expect(result.status).toBe("filled");
      expect(result.id).toBe("alpaca-123");
      expect(result.symbol).toBe("AAPL");
      expect(result.side).toBe("buy");
      expect(result.orderType).toBe("market");
      expect(result.quantity).toBe(100);
      expect(result.fillPrice).toBe(185.50);
      expect(result.fee).toBe(0);
    });

    it("should pass clientOrderId to the SDK", async () => {
      const client = createMockClient({});
      const { AlpacaExecutor } = await import("../src/executor/alpaca.js");
      const executor = new AlpacaExecutor({
        client: client as unknown as Awaited<
          ReturnType<typeof import("@alpacahq/alpaca-trade-api")>["Alpaca"]
        >,
      });

      await executor.placeOrder({
        symbol: "AAPL",
        side: "buy",
        quantity: 50,
        orderType: "market",
        clientOrderId: "my-client-id",
      });

      expect(client._mocks.market).toHaveBeenCalledWith(
        expect.objectContaining({
          clientOrderId: "my-client-id",
          symbol: "AAPL",
          side: "buy",
          qty: 50,
        }),
      );
    });

    it("should return pending status for non-filled orders", async () => {
      const { executor } = await createExecutor({
        orderResponse: {
          id: "alpaca-456",
          status: "new",
          filledQty: "0",
          filledAvgPrice: null,
          createdAt: "2025-06-01T12:00:00Z",
        },
      });

      const result = await executor.placeOrder({
        symbol: "AAPL",
        side: "buy",
        quantity: 100,
        orderType: "market",
      });

      expect(result.status).toBe("pending");
      expect(result.fillPrice).toBeNull();
    });
  });

  describe("placeOrder — limit orders", () => {
    it("should submit a limit order with the correct limit price", async () => {
      const client = createMockClient({});
      const { AlpacaExecutor } = await import("../src/executor/alpaca.js");
      const executor = new AlpacaExecutor({
        client: client as unknown as Awaited<
          ReturnType<typeof import("@alpacahq/alpaca-trade-api")>["Alpaca"]
        >,
      });

      const result = await executor.placeOrder({
        symbol: "AAPL",
        side: "buy",
        quantity: 100,
        orderType: "limit",
        limitPrice: 180.0,
      });

      expect(result.status).toBe("filled");
      expect(client._mocks.limit).toHaveBeenCalledWith(
        expect.objectContaining({
          limitPrice: 180.0,
          qty: 100,
          symbol: "AAPL",
        }),
      );
    });

    it("should reject limit order without limitPrice", async () => {
      const { executor } = await createExecutor();

      const result = await executor.placeOrder({
        symbol: "AAPL",
        side: "buy",
        quantity: 100,
        orderType: "limit",
      });

      expect(result.status).toBe("rejected");
      expect(result.error).toContain("limitPrice");
    });
  });

  describe("placeOrder — stop orders", () => {
    it("should submit a stop order with the correct stop price", async () => {
      const client = createMockClient({});
      const { AlpacaExecutor } = await import("../src/executor/alpaca.js");
      const executor = new AlpacaExecutor({
        client: client as unknown as Awaited<
          ReturnType<typeof import("@alpacahq/alpaca-trade-api")>["Alpaca"]
        >,
      });

      const result = await executor.placeOrder({
        symbol: "AAPL",
        side: "sell",
        quantity: 100,
        orderType: "stop",
        stopPrice: 175.0,
      });

      expect(result.status).toBe("pending"); // stop defaults to pending in mock
      expect(client._mocks.stop).toHaveBeenCalledWith(
        expect.objectContaining({
          stopPrice: 175.0,
          qty: 100,
          symbol: "AAPL",
        }),
      );
    });

    it("should reject stop order without stopPrice", async () => {
      const { executor } = await createExecutor();

      const result = await executor.placeOrder({
        symbol: "AAPL",
        side: "sell",
        quantity: 100,
        orderType: "stop",
      });

      expect(result.status).toBe("rejected");
      expect(result.error).toContain("stopPrice");
    });
  });

  describe("placeOrder — validation", () => {
    it("should reject order with zero quantity", async () => {
      const { executor } = await createExecutor();

      const result = await executor.placeOrder({
        symbol: "AAPL",
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
        symbol: "AAPL",
        side: "buy",
        quantity: -10,
        orderType: "market",
      });

      expect(result.status).toBe("rejected");
      expect(result.error).toContain("Quantity must be positive");
    });
  });

  describe("placeOrder — error handling", () => {
    it("should return rejected OrderResult on SDK error", async () => {
      const { executor } = await createExecutor({
        orderError: new Error("Insufficient buying power"),
      });

      const result = await executor.placeOrder({
        symbol: "AAPL",
        side: "buy",
        quantity: 100,
        orderType: "market",
      });

      expect(result.status).toBe("rejected");
      expect(result.error).toContain("Alpaca order failed");
      expect(result.error).toContain("Insufficient buying power");
      expect(result.fillPrice).toBeNull();
    });

    it("should not throw on SDK errors — always returns OrderResult", async () => {
      const { executor } = await createExecutor({
        orderError: new Error("Network timeout"),
      });

      // Should not throw
      const result = await executor.placeOrder({
        symbol: "AAPL",
        side: "buy",
        quantity: 100,
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
    it("should return mapped positions from Alpaca", async () => {
      const { executor } = await createExecutor({
        positionsResponse: [
          {
            symbol: "AAPL",
            qty: "100",
            avgEntryPrice: "185.00",
            side: "long",
            unrealizedPl: "500.00",
            marketValue: "19000.00",
            currentPrice: "190.00",
          },
          {
            symbol: "MSFT",
            qty: "50",
            avgEntryPrice: "400.00",
            side: "long",
            unrealizedPl: "1000.00",
            marketValue: "21000.00",
            currentPrice: "420.00",
          },
        ],
      });

      const positions = await executor.getPositions();

      expect(positions).toHaveLength(2);
      expect(positions[0].symbol).toBe("AAPL");
      expect(positions[0].quantity).toBe(100);
      expect(positions[0].avgEntryPrice).toBe(185.00);
      expect(positions[0].side).toBe("long");
      expect(positions[0].unrealizedPnl).toBe(500.00);
      expect(positions[0].marketValue).toBe(19000.00);
    });

    it("should map short positions correctly", async () => {
      const { executor } = await createExecutor({
        positionsResponse: [
          {
            symbol: "TSLA",
            qty: "200",
            avgEntryPrice: "250.00",
            side: "short",
            unrealizedPl: "-500.00",
            marketValue: "49000.00",
            currentPrice: "245.00",
          },
        ],
      });

      const positions = await executor.getPositions();

      expect(positions).toHaveLength(1);
      expect(positions[0].side).toBe("short");
    });

    it("should return empty array on API error", async () => {
      const { executor } = await createExecutor({
        positionsError: new Error("API unavailable"),
      });

      const positions = await executor.getPositions();
      expect(positions).toEqual([]);
    });

    it("should filter out zero-quantity positions", async () => {
      const { executor } = await createExecutor({
        positionsResponse: [
          {
            symbol: "AAPL",
            qty: "100",
            avgEntryPrice: "185.00",
            side: "long",
            unrealizedPl: "500.00",
            marketValue: "19000.00",
            currentPrice: "190.00",
          },
          {
            symbol: "GOOGL",
            qty: "0",
            avgEntryPrice: "140.00",
            side: "long",
            unrealizedPl: "0.00",
            marketValue: "0.00",
            currentPrice: "140.00",
          },
        ],
      });

      const positions = await executor.getPositions();
      expect(positions).toHaveLength(1);
      expect(positions[0].symbol).toBe("AAPL");
    });
  });

  describe("getBalance", () => {
    it("should return mapped balance from Alpaca account", async () => {
      const { executor } = await createExecutor({
        accountResponse: {
          cash: "50000.00",
          equity: "100000.00",
          lastEquity: "95000.00",
          portfolioValue: "102000.00",
        },
      });

      const balance = await executor.getBalance();

      expect(balance.cash).toBe(50000.00);
      expect(balance.equity).toBe(100000.00);
      expect(balance.initialCash).toBe(95000.00);
      expect(balance.peakEquity).toBe(102000.00);
    });

    it("should throw on account API error", async () => {
      const { executor } = await createExecutor({
        accountError: new Error("Auth failed"),
      });

      await expect(executor.getBalance()).rejects.toThrow("Alpaca getBalance failed");
    });

    it("should handle missing account fields with defaults", async () => {
      const { executor } = await createExecutor({
        accountResponse: {
          cash: "50000.00",
          equity: "100000.00",
          lastEquity: "0",
          portfolioValue: "0",
        },
      });

      const balance = await executor.getBalance();

      // lastEquity is "0" which is falsy → falls back to equity
      expect(balance.initialCash).toBe(100000.00);
      // portfolioValue is "0" which is falsy → falls back to equity
      expect(balance.peakEquity).toBe(100000.00);
    });
  });

  describe("status mapping", () => {
    it("should map 'canceled' to 'cancelled'", async () => {
      const { executor } = await createExecutor({
        orderResponse: {
          id: "order-1",
          status: "canceled",
          filledQty: "0",
          filledAvgPrice: null,
          createdAt: "2025-06-01T12:00:00Z",
        },
      });

      const result = await executor.placeOrder({
        symbol: "AAPL",
        side: "buy",
        quantity: 100,
        orderType: "market",
      });

      expect(result.status).toBe("cancelled");
    });

    it("should map 'rejected' to 'rejected'", async () => {
      const { executor } = await createExecutor({
        orderResponse: {
          id: "order-1",
          status: "rejected",
          filledQty: "0",
          filledAvgPrice: null,
          createdAt: "2025-06-01T12:00:00Z",
        },
      });

      const result = await executor.placeOrder({
        symbol: "AAPL",
        side: "buy",
        quantity: 100,
        orderType: "market",
      });

      expect(result.status).toBe("rejected");
    });

    it("should map 'partially_filled' to 'pending'", async () => {
      const { executor } = await createExecutor({
        orderResponse: {
          id: "order-1",
          status: "partially_filled",
          filledQty: "50",
          filledAvgPrice: "185.00",
          createdAt: "2025-06-01T12:00:00Z",
        },
      });

      const result = await executor.placeOrder({
        symbol: "AAPL",
        side: "buy",
        quantity: 100,
        orderType: "market",
      });

      expect(result.status).toBe("pending");
      expect(result.fillPrice).toBe(185.00);
    });
  });
});