/**
 * PriceCache tests — src/market/stock-price-cache.ts (fleet-ops-b3u).
 *
 * The cache refreshes crypto quotes via MarketDataService and stock quotes
 * via Yahoo Finance's public chart endpoint (global fetch). All network
 * and DB access is mocked; the SQLite schema is real (in-memory).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { openDatabase, closeDatabase, type DbClient } from "../src/db/database.js";
import { PriceCache } from "../src/market/stock-price-cache.js";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

function yahooResponse(price: number) {
  return {
    ok: true,
    json: async () => ({ chart: { result: [{ meta: { regularMarketPrice: price } }] } }),
  };
}

function makeMarketData(quotes: Record<string, { price: number } | Error> = {}) {
  return {
    getQuote: vi.fn(async (sym: string) => {
      const q = quotes[sym];
      if (q instanceof Error) throw q;
      if (q) return { symbol: sym, ...q };
      return { symbol: sym, price: 100, timestamp: new Date().toISOString(), source: "ccxt" };
    }),
    getBars: vi.fn(async () => []),
    getSnapshot: vi.fn(async () => []),
  };
}

describe("PriceCache", () => {
  let db: DbClient;

  beforeEach(async () => {
    fetchMock.mockReset();
    db = await openDatabase({ path: ":memory:" });
    await db.run(
      "INSERT INTO agent_positions (agent_id, symbol, quantity, avg_entry_price, side, updated_at) " +
        "VALUES ('agent-1', 'AAPL', 10, 185, 'long', datetime('now'))",
    );
  });

  afterEach(async () => {
    await closeDatabase(db);
  });

  it("get returns null for unknown symbols", () => {
    const cache = new PriceCache({ db, marketData: makeMarketData() as any });
    expect(cache.get("NOPE")).toBeNull();
  });

  it("refreshes crypto watch symbols through MarketDataService", async () => {
    const marketData = makeMarketData({ "BTC/USDT": { price: 42_000 } });
    const cache = new PriceCache({ db, marketData: marketData as any, watchSymbols: ["BTC/USDT"] });
    await cache.refresh();
    expect(marketData.getQuote).toHaveBeenCalledWith("BTC/USDT");
    expect(cache.get("BTC/USDT")).toBe(42_000);
  });

  it("ignores crypto quotes with non-positive prices", async () => {
    const marketData = makeMarketData({ "DOGE/USD": { price: 0 } });
    const cache = new PriceCache({ db, marketData: marketData as any, watchSymbols: ["DOGE/USD"] });
    await cache.refresh();
    expect(cache.get("DOGE/USD")).toBeNull();
  });

  it("keeps last known price when the quote fetch throws", async () => {
    const marketData = makeMarketData({ "BTC/USDT": { price: 50_000 } });
    const cache = new PriceCache({ db, marketData: marketData as any, watchSymbols: ["BTC/USDT"] });
    await cache.refresh();
    expect(cache.get("BTC/USDT")).toBe(50_000);

    const broken = makeMarketData({ "BTC/USDT": new Error("exchange down") });
    const cache2 = new PriceCache({ db, marketData: broken as any, watchSymbols: ["BTC/USDT"] });
    // Re-use the populated prices map by refreshing the same instance
    const cacheAlt = cache;
    (cacheAlt as any).marketData = broken;
    await cacheAlt.refresh();
    expect(cacheAlt.get("BTC/USDT")).toBe(50_000);
  });

  it("fetches held stock positions via Yahoo and caches them", async () => {
    fetchMock.mockResolvedValue(yahooResponse(185.5));
    const cache = new PriceCache({ db, marketData: makeMarketData() as any });
    await cache.refresh();
    expect(fetchMock).toHaveBeenCalled();
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("query1.finance.yahoo.com/v8/finance/chart/AAPL");
    expect(cache.get("AAPL")).toBe(185.5);
  });

  it("keeps last known stock price when Yahoo returns null", async () => {
    fetchMock.mockResolvedValue(yahooResponse(200));
    const cache = new PriceCache({ db, marketData: makeMarketData() as any });
    await cache.refresh();
    expect(cache.get("AAPL")).toBe(200);

    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ chart: { result: [] } }) });
    await cache.refresh();
    expect(cache.get("AAPL")).toBe(200);
  });

  it("refresh is a no-op while another refresh is in flight", async () => {
    const marketData = makeMarketData({ "BTC/USDT": { price: 1 } });
    const cache = new PriceCache({ db, marketData: marketData as any, watchSymbols: ["BTC/USDT"] });
    const p1 = cache.refresh();
    const p2 = cache.refresh();
    await Promise.all([p1, p2]);
    expect(marketData.getQuote).toHaveBeenCalledTimes(1);
  });

  it("falls back to the watch list when the positions query fails", async () => {
    const brokenDb = {
      backend: "sqlite",
      run: async () => {},
      exec: async () => {},
      get: async () => null,
      all: async () => {
        throw new Error("table missing");
      },
    } as any;
    const marketData = makeMarketData({ "BTC/USDT": { price: 3 } });
    const cache = new PriceCache({
      db: brokenDb,
      marketData: marketData as any,
      watchSymbols: ["BTC/USDT"],
    });
    await cache.refresh();
    expect(cache.get("BTC/USDT")).toBe(3);
  });

  it("addWatchSymbol includes new symbols on the next refresh", async () => {
    const marketData = makeMarketData({ "ETH/USD": { price: 2_500 } });
    const cache = new PriceCache({ db, marketData: marketData as any });
    cache.addWatchSymbol("ETH/USD");
    expect(cache.get("ETH/USD")).toBeNull();
    await cache.refresh();
    expect(cache.get("ETH/USD")).toBe(2_500);
  });

  describe("fetchStockQuote", () => {
    it("returns the regular market price on success", async () => {
      fetchMock.mockResolvedValue(yahooResponse(99.25));
      expect(await PriceCache.fetchStockQuote("MSFT")).toBe(99.25);
    });

    it("returns null on non-OK HTTP status", async () => {
      fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
      expect(await PriceCache.fetchStockQuote("MSFT")).toBeNull();
    });

    it("returns null when the response has no price", async () => {
      fetchMock.mockResolvedValue({ ok: true, json: async () => ({ chart: {} }) });
      expect(await PriceCache.fetchStockQuote("MSFT")).toBeNull();
    });

    it("returns null for non-positive or non-numeric prices", async () => {
      fetchMock.mockResolvedValueOnce(yahooResponse(0));
      expect(await PriceCache.fetchStockQuote("MSFT")).toBeNull();
      fetchMock.mockResolvedValueOnce(yahooResponse(-5));
      expect(await PriceCache.fetchStockQuote("MSFT")).toBeNull();
    });

    it("returns null when fetch throws (timeout, network)", async () => {
      fetchMock.mockRejectedValue(new Error("network down"));
      expect(await PriceCache.fetchStockQuote("MSFT")).toBeNull();
    });
  });

  describe("start/stop lifecycle", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("refreshes immediately, then on the interval, then stops", async () => {
      const marketData = makeMarketData({ "BTC/USDT": { price: 10 } });
      const cache = new PriceCache({
        db,
        marketData: marketData as any,
        intervalMs: 5_000,
        watchSymbols: ["BTC/USDT"],
      });

      cache.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(marketData.getQuote).toHaveBeenCalledTimes(1);
      expect(cache.get("BTC/USDT")).toBe(10);

      await vi.advanceTimersByTimeAsync(5_000);
      expect(marketData.getQuote).toHaveBeenCalledTimes(2);

      cache.stop();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(marketData.getQuote).toHaveBeenCalledTimes(2);
    });

    it("start is idempotent and stop is safe when never started", () => {
      const cache = new PriceCache({ db, marketData: makeMarketData() as any, intervalMs: 60_000 });
      cache.start();
      cache.start(); // second call must not create a second timer
      cache.stop();
      cache.stop();
      expect(cache.get("BTC/USDT")).toBeNull();
    });
  });
});
