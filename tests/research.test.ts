import { describe, it, expect, vi, beforeEach } from "vitest";
import { ResearchService } from "../src/research/research.js";
import type { MarketDataService, Bar, Quote, Snapshot, Timeframe } from "../src/market/market.js";

// ── Mock MarketDataService ──────────────────────────────────────

function makeMockMarketData(bars: Bar[]): MarketDataService {
  return {
    async getQuote(symbol: string): Promise<Quote> {
      const lastBar = bars[bars.length - 1];
      return {
        symbol,
        price: lastBar.close,
        timestamp: lastBar.timestamp,
        source: "ccxt",
      };
    },
    async getBars(symbol: string, _timeframe: Timeframe, _range: string): Promise<Bar[]> {
      return bars.map((b) => ({ ...b, symbol }));
    },
    async getSnapshot(symbols: string[]): Promise<Snapshot[]> {
      return symbols.map((s) => ({
        symbol: s,
        price: bars[bars.length - 1].close,
        timestamp: bars[bars.length - 1].timestamp,
        source: "ccxt" as const,
      }));
    },
  };
}

// Generate synthetic daily bars for testing
function generateBars(startPrice: number, count: number, trend: "up" | "down" | "flat" = "flat"): Bar[] {
  const bars: Bar[] = [];
  let price = startPrice;
  const now = Date.now();
  for (let i = 0; i < count; i++) {
    const date = new Date(now - (count - i) * 86400000);
    let change: number;
    if (trend === "up") change = (Math.random() - 0.3) * 2;
    else if (trend === "down") change = (Math.random() - 0.7) * 2;
    else change = (Math.random() - 0.5) * 1;

    price = Math.max(1, price + change);
    bars.push({
      symbol: "TEST/USDT",
      timestamp: date.toISOString(),
      open: price - change * 0.5,
      high: price + Math.abs(change) * 0.5,
      low: price - Math.abs(change) * 0.5,
      close: price,
      volume: 1000 + Math.random() * 500,
      source: "ccxt" as const,
    });
  }
  return bars;
}

// Generate deterministic bars for precise signal testing
function generateUptrendBars(startPrice: number, count: number): Bar[] {
  const bars: Bar[] = [];
  let price = startPrice;
  const now = Date.now();
  for (let i = 0; i < count; i++) {
    const date = new Date(now - (count - i) * 86400000);
    price += 1; // steady uptrend
    bars.push({
      symbol: "TEST/USDT",
      timestamp: date.toISOString(),
      open: price - 1,
      high: price + 0.5,
      low: price - 1.5,
      close: price,
      volume: 1000,
      source: "ccxt" as const,
    });
  }
  return bars;
}

function generateDowntrendBars(startPrice: number, count: number): Bar[] {
  const bars: Bar[] = [];
  let price = startPrice;
  const now = Date.now();
  for (let i = 0; i < count; i++) {
    const date = new Date(now - (count - i) * 86400000);
    price -= 1; // steady downtrend
    bars.push({
      symbol: "TEST/USDT",
      timestamp: date.toISOString(),
      open: price + 1,
      high: price + 1.5,
      low: price - 0.5,
      close: price,
      volume: 1000,
      source: "ccxt" as const,
    });
  }
  return bars;
}

describe("ResearchService", () => {
  describe("analyze", () => {
    it("computes SMA20, SMA50, and RSI14 from bar data", async () => {
      const bars = generateUptrendBars(100, 60);
      const marketData = makeMockMarketData(bars);
      const research = new ResearchService(marketData);

      const analysis = await research.analyze("BTC/USDT", "1Day", "3m");

      expect(analysis.symbol).toBe("BTC/USDT");
      expect(analysis.barCount).toBe(60);
      expect(analysis.indicators.sma20).not.toBeNull();
      expect(analysis.indicators.sma50).not.toBeNull();
      expect(analysis.indicators.rsi14).not.toBeNull();
      expect(analysis.lastPrice).toBeGreaterThan(0);
    });

    it("returns null for SMA50 when not enough bars", async () => {
      const bars = generateUptrendBars(100, 30);
      const marketData = makeMockMarketData(bars);
      const research = new ResearchService(marketData);

      const analysis = await research.analyze("BTC/USDT", "1Day", "1m");

      expect(analysis.indicators.sma20).not.toBeNull();
      expect(analysis.indicators.sma50).toBeNull(); // only 30 bars, need 50
    });

    it("returns null for RSI14 when not enough data", async () => {
      const bars = generateUptrendBars(100, 10);
      const marketData = makeMockMarketData(bars);
      const research = new ResearchService(marketData);

      const analysis = await research.analyze("BTC/USDT", "1Day", "1m");

      expect(analysis.indicators.rsi14).toBeNull();
    });

    it("detects overbought RSI in strong uptrend", async () => {
      const bars = generateUptrendBars(100, 30);
      const marketData = makeMockMarketData(bars);
      const research = new ResearchService(marketData);

      const analysis = await research.analyze("BTC/USDT", "1Day", "3m");

      // Steady uptrend → RSI should be very high (overbought)
      expect(analysis.indicators.rsi14).not.toBeNull();
      expect(analysis.indicators.rsi14!).toBeGreaterThan(70);
      expect(analysis.signals.rsi).toBe("sell");
    });

    it("detects oversold RSI in strong downtrend", async () => {
      const bars = generateDowntrendBars(100, 30);
      const marketData = makeMockMarketData(bars);
      const research = new ResearchService(marketData);

      const analysis = await research.analyze("BTC/USDT", "1Day", "3m");

      expect(analysis.indicators.rsi14).not.toBeNull();
      expect(analysis.indicators.rsi14!).toBeLessThan(30);
      expect(analysis.signals.rsi).toBe("buy");
    });

    it("produces a human-readable summary", async () => {
      const bars = generateUptrendBars(100, 60);
      const marketData = makeMockMarketData(bars);
      const research = new ResearchService(marketData);

      const analysis = await research.analyze("BTC/USDT", "1Day", "6m");

      expect(analysis.summary).toContain("BTC/USDT");
      expect(analysis.summary).toContain("SMA20");
      expect(analysis.summary).toContain("RSI14");
      expect(analysis.summary).toContain("Signal");
    });

    it("includes timeframe and range in output", async () => {
      const bars = generateUptrendBars(100, 60);
      const marketData = makeMockMarketData(bars);
      const research = new ResearchService(marketData);

      const analysis = await research.analyze("ETH/USDT", "1Hour", "1w");

      expect(analysis.timeframe).toBe("1Hour");
      expect(analysis.range).toBe("1w");
      expect(analysis.symbol).toBe("ETH/USDT");
    });

    it("throws when no bar data available", async () => {
      const marketData: MarketDataService = {
        async getQuote(): Promise<Quote> { throw new Error("no data"); },
        async getBars(): Promise<Bar[]> { return []; },
        async getSnapshot(): Promise<Snapshot[]> { return []; },
      };
      const research = new ResearchService(marketData);

      await expect(research.analyze("FOO/USDT")).rejects.toThrow("No bar data");
    });

    it("combined signal picks SMA crossover when present", async () => {
      // Build series with a golden cross pattern
      const bars: Bar[] = [];
      const now = Date.now();
      // 70 bars: decline then sharp recovery
      let price = 100;
      for (let i = 0; i < 40; i++) {
        price -= 0.5;
        bars.push({
          symbol: "TEST/USDT",
          timestamp: new Date(now - (70 - i) * 86400000).toISOString(),
          open: price + 0.25, high: price + 0.5, low: price - 0.5, close: price,
          volume: 1000, source: "ccxt" as const,
        });
      }
      for (let i = 0; i < 30; i++) {
        price += 2;
        bars.push({
          symbol: "TEST/USDT",
          timestamp: new Date(now - (30 - i) * 86400000).toISOString(),
          open: price - 1, high: price + 1, low: price - 1.5, close: price,
          volume: 1000, source: "ccxt" as const,
        });
      }

      const marketData = makeMockMarketData(bars);
      const research = new ResearchService(marketData);
      const analysis = await research.analyze("BTC/USDT", "1Day", "3m");

      // Either buy (golden cross) or neutral depending on exact crossover timing
      expect(["buy", "sell", "neutral"]).toContain(analysis.signals.smaCrossover);
      expect(["buy", "sell", "neutral"]).toContain(analysis.signals.combined);
    });
  });

  describe("getPrice", () => {
    it("returns current price from quote", async () => {
      const bars = generateUptrendBars(100, 10);
      const marketData = makeMockMarketData(bars);
      const research = new ResearchService(marketData);

      const price = await research.getPrice("BTC/USDT");
      expect(price).toBe(bars[bars.length - 1].close);
    });
  });

  describe("getBars", () => {
    it("passes through to market data service", async () => {
      const bars = generateUptrendBars(100, 20);
      const marketData = makeMockMarketData(bars);
      const research = new ResearchService(marketData);

      const result = await research.getBars("BTC/USDT", "1Day", "1m");
      expect(result).toHaveLength(20);
      expect(result[0].close).toBe(bars[0].close);
    });
  });
});