import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the ccxt module before importing the adapter
const mockFetchTicker = vi.fn();
const mockFetchOHLCV = vi.fn();

vi.mock("ccxt", () => {
  class MockExchange {
    apiKey: string = "";
    secret: string = "";
    enableRateLimit: boolean = true;

    async fetchTicker(symbol: string) {
      return mockFetchTicker(symbol);
    }

    async fetchOHLCV(symbol: string, timeframe: string, since?: number) {
      return mockFetchOHLCV(symbol, timeframe, since);
    }
  }

  const lib = {
    binance: MockExchange,
    coinbase: MockExchange,
    kraken: MockExchange,
  };

  return {
    default: lib,
    ...lib,
  };
});

// Import after mock
const { CCXTMarketData } = await import("../src/market/ccxt-data.js");

describe("CCXTMarketData", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("constructor without API keys (public mode)", () => {
    it("constructs without throwing when no API keys provided", () => {
      const adapter = new CCXTMarketData("binance");
      expect(adapter).toBeDefined();
    });

    it("constructs with empty string keys", () => {
      const adapter = new CCXTMarketData("coinbase", "", "");
      expect(adapter).toBeDefined();
    });

    it("throws on empty exchange id", () => {
      expect(() => new CCXTMarketData("")).toThrow("requires an exchange id");
    });
  });

  describe("constructor with API keys", () => {
    it("constructs with API keys", () => {
      const adapter = new CCXTMarketData("binance", "key123", "secret456");
      expect(adapter).toBeDefined();
    });
  });

  describe("getQuote", () => {
    it("fetches a quote without API keys (public endpoint)", async () => {
      const ts = Date.now();
      mockFetchTicker.mockResolvedValue({
        symbol: "BTC/USDT",
        last: 65000,
        close: 65000,
        bid: 64990,
        ask: 65010,
        change: 500,
        percentage: 0.77,
        baseVolume: 1000,
        timestamp: ts,
      });

      const adapter = new CCXTMarketData("binance");
      const quote = await adapter.getQuote("BTC/USDT");

      expect(quote.symbol).toBe("BTC/USDT");
      expect(quote.price).toBe(65000);
      expect(quote.bid).toBe(64990);
      expect(quote.ask).toBe(65010);
      expect(quote.source).toBe("ccxt");
      expect(quote.timestamp).toBe(new Date(ts).toISOString());
    });

    it("uses close price when last is undefined", async () => {
      mockFetchTicker.mockResolvedValue({
        symbol: "ETH/USDT",
        last: undefined,
        close: 3500,
        bid: 3495,
        ask: 3505,
        timestamp: Date.now(),
      });

      const adapter = new CCXTMarketData("binance");
      const quote = await adapter.getQuote("ETH/USDT");
      expect(quote.price).toBe(3500);
    });

    it("throws when price is zero or negative", async () => {
      mockFetchTicker.mockResolvedValue({
        symbol: "FOO/USDT",
        last: 0,
        close: 0,
        timestamp: Date.now(),
      });

      const adapter = new CCXTMarketData("binance");
      await expect(adapter.getQuote("FOO/USDT")).rejects.toThrow("No price data");
    });
  });

  describe("getBars", () => {
    it("fetches OHLCV bars", async () => {
      const ts1 = Date.now() - 86400000;
      const ts2 = Date.now();

      mockFetchOHLCV.mockResolvedValue([
        [ts1, 64000, 64500, 63800, 64200, 500],
        [ts2, 64200, 65100, 64100, 65000, 600],
      ]);

      const adapter = new CCXTMarketData("binance");
      const bars = await adapter.getBars("BTC/USDT", "1Day", "30d");

      expect(bars).toHaveLength(2);
      expect(bars[0]).toEqual({
        symbol: "BTC/USDT",
        timestamp: new Date(ts1).toISOString(),
        open: 64000,
        high: 64500,
        low: 63800,
        close: 64200,
        volume: 500,
        source: "ccxt",
      });
      expect(bars[1].close).toBe(65000);
    });

    it("maps timeframe correctly", async () => {
      mockFetchOHLCV.mockResolvedValue([]);

      const adapter = new CCXTMarketData("binance");
      await adapter.getBars("BTC/USDT", "1Hour", "1d");

      // Check that fetchOHLCV was called with the mapped timeframe "1h"
      expect(mockFetchOHLCV).toHaveBeenCalledWith("BTC/USDT", "1h", expect.any(Number));
    });
  });

  describe("getSnapshot", () => {
    it("fetches snapshots for multiple symbols", async () => {
      mockFetchTicker
        .mockResolvedValueOnce({
          symbol: "BTC/USDT",
          last: 65000,
          close: 65000,
          change: 500,
          percentage: 0.77,
          baseVolume: 1000,
          timestamp: Date.now(),
        })
        .mockResolvedValueOnce({
          symbol: "ETH/USDT",
          last: 3500,
          close: 3500,
          change: 50,
          percentage: 1.45,
          baseVolume: 2000,
          timestamp: Date.now(),
        });

      const adapter = new CCXTMarketData("binance");
      const snapshots = await adapter.getSnapshot(["BTC/USDT", "ETH/USDT"]);

      expect(snapshots).toHaveLength(2);
      expect(snapshots[0].symbol).toBe("BTC/USDT");
      expect(snapshots[0].price).toBe(65000);
      expect(snapshots[0].changePct).toBe(0.77);
      expect(snapshots[1].symbol).toBe("ETH/USDT");
      expect(snapshots[1].price).toBe(3500);
    });

    it("skips symbols with no price data", async () => {
      mockFetchTicker.mockResolvedValue({
        symbol: "FOO/USDT",
        last: 0,
        close: 0,
        timestamp: Date.now(),
      });

      const adapter = new CCXTMarketData("binance");
      const snapshots = await adapter.getSnapshot(["FOO/USDT"]);
      expect(snapshots).toHaveLength(0);
    });
  });

  describe("unknown exchange", () => {
    it("throws on unknown exchange id", async () => {
      const adapter = new CCXTMarketData("nonexistent");
      await expect(adapter.getQuote("BTC/USDT")).rejects.toThrow();
    });
  });
});

// ── createPublicCryptoMarketData factory ────────────────────────

describe("createPublicCryptoMarketData", () => {
  it("creates a market data service without API keys", async () => {
    const { createPublicCryptoMarketData } = await import("../src/market/market.js");

    mockFetchTicker.mockResolvedValue({
      symbol: "BTC/USDT",
      last: 65000,
      close: 65000,
      timestamp: Date.now(),
    });

    const service = createPublicCryptoMarketData("binance");
    const quote = await service.getQuote("BTC/USDT");
    expect(quote.price).toBe(65000);
    expect(quote.source).toBe("ccxt");
  });

  it("defaults to binance exchange", async () => {
    const { createPublicCryptoMarketData } = await import("../src/market/market.js");
    // Just verify it doesn't throw — the exchange is lazily loaded
    const service = createPublicCryptoMarketData();
    expect(service).toBeDefined();
  });
});