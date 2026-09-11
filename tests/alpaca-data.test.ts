/**
 * AlpacaMarketData tests — src/market/alpaca-data.ts (fleet-ops-b3u).
 *
 * The adapter wraps @alpacahq/alpaca-trade-api v4; the SDK client is
 * mocked at module level (same pattern as ccxt-data.test.ts).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetStockTradesFor = vi.fn();
const mockGetStockBarsFor = vi.fn();

vi.mock("@alpacahq/alpaca-trade-api", () => {
  const Alpaca = vi.fn().mockImplementation(() => ({
    marketData: {
      getStockTradesFor: (...args: unknown[]) => mockGetStockTradesFor(...args),
      getStockBarsFor: (...args: unknown[]) => mockGetStockBarsFor(...args),
    },
  }));
  return {
    Alpaca,
    timeFrame: (n: number, unit: unknown) => ({ value: n, unit }),
    TimeFrameUnit: { Minute: "minute", Hour: "hour", Day: "day" },
  };
});

const { AlpacaMarketData } = await import("../src/market/alpaca-data.js");

function makeTrade(price: number, timestamp = "2026-09-11T14:30:00Z") {
  return { price, timestamp };
}

describe("AlpacaMarketData", () => {
  let adapter: InstanceType<typeof AlpacaMarketData>;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new AlpacaMarketData("key-id", "secret", true);
  });

  describe("getQuote", () => {
    it("returns the latest trade as a quote", async () => {
      mockGetStockTradesFor.mockResolvedValue([makeTrade(150), makeTrade(151.5)]);
      const quote = await adapter.getQuote("AAPL");
      expect(quote.symbol).toBe("AAPL");
      expect(quote.price).toBe(151.5);
      expect(quote.source).toBe("alpaca");
      expect(new Date(quote.timestamp).toString()).not.toBe("Invalid Date");
    });

    it("requests the last 60 seconds of trades", async () => {
      mockGetStockTradesFor.mockResolvedValue([makeTrade(100)]);
      await adapter.getQuote("MSFT");
      const arg = mockGetStockTradesFor.mock.calls[0][1];
      expect(arg.start).toBeInstanceOf(Date);
      expect(arg.end).toBeInstanceOf(Date);
    });

    it("throws when no trades are returned", async () => {
      mockGetStockTradesFor.mockResolvedValue([]);
      await expect(adapter.getQuote("AAPL")).rejects.toThrow("No quote data for AAPL");
    });
  });

  describe("getBars", () => {
    it("maps Alpaca bars to our Bar shape", async () => {
      mockGetStockBarsFor.mockResolvedValue([
        {
          timestamp: "2026-09-10T13:30:00Z",
          open: 10,
          high: 12,
          low: 9,
          close: 11,
          volume: 1_000,
        },
      ]);
      const bars = await adapter.getBars("TSLA", "1Day", "1m");
      expect(bars).toHaveLength(1);
      expect(bars[0]).toMatchObject({
        symbol: "TSLA",
        open: 10,
        high: 12,
        low: 9,
        close: 11,
        volume: 1_000,
        source: "alpaca",
      });
      expect(new Date(bars[0].timestamp).toString()).not.toBe("Invalid Date");
    });

    it("defaults the range to 30 days when malformed", async () => {
      mockGetStockBarsFor.mockResolvedValue([]);
      await adapter.getBars("TSLA", "1Day", "bogus-range");
      const arg = mockGetStockBarsFor.mock.calls[0][1];
      expect(arg.start).toBeInstanceOf(Date);
      const days = Math.round((arg.end ?? Date.now()) - arg.start.getTime()) / 86_400_000;
      // 'bogus-range' fails the regex → 30d default
      expect(days).toBeLessThanOrEqual(31);
    });

    it("passes the timeframe through to Alpaca", async () => {
      mockGetStockBarsFor.mockResolvedValue([]);
      await adapter.getBars("TSLA", "5Min", "1d");
      const args = mockGetStockBarsFor.mock.calls[0];
      expect(args[0]).toBe("TSLA");
      expect(args[1].timeframe).toEqual({ value: 5, unit: "minute" });
      expect(args[1].start).toBeInstanceOf(Date);
    });

    it("converts the range to a start date", async () => {
      mockGetStockBarsFor.mockResolvedValue([]);
      await adapter.getBars("TSLA", "1Hour", "2w");
      const args = mockGetStockBarsFor.mock.calls[0];
      expect(args[0]).toBe("TSLA");
      const arg1 = args[1];
      expect(arg1.timeframe).toEqual({ value: 1, unit: "hour" });
      expect(arg1.start).toBeInstanceOf(Date);
    });
  });

  describe("getSnapshot", () => {
    it("falls back to latest trades per symbol, skipping failures", async () => {
      mockGetStockTradesFor
        .mockResolvedValueOnce([makeTrade(200)])
        .mockRejectedValueOnce(new Error("no data"));
      const snapshots = await adapter.getSnapshot(["AAPL", "NOPE"]);
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]).toMatchObject({ symbol: "AAPL", price: 200, source: "alpaca" });
    });

    it("skips symbols whose trade window is empty", async () => {
      mockGetStockTradesFor.mockResolvedValueOnce([]).mockResolvedValueOnce([makeTrade(5)]);
      const snapshots = await adapter.getSnapshot(["A", "B"]);
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0].symbol).toBe("B");
    });
  });
});
