/**
 * Market API route tests — src/api/routes/market.ts (fleet-ops-b3u).
 *
 * supertest over the market router with a fake MarketDataService.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import supertest from "supertest";
import { openDatabase, closeDatabase, type DbClient } from "../src/db/database.js";
import { createMarketRouter } from "../src/api/routes/market.js";
import type { AppState } from "../src/api/routes/types.js";

function makeMarketData() {
  return {
    getQuote: vi.fn(async (symbol: string) => ({
      symbol,
      price: 100,
      timestamp: new Date().toISOString(),
      source: "ccxt",
    })),
    getBars: vi.fn(async (symbol: string) => [
      {
        symbol,
        timestamp: new Date().toISOString(),
        open: 1,
        high: 2,
        low: 0.5,
        close: 1.5,
        volume: 10,
        source: "ccxt",
      },
    ]),
    getSnapshot: vi.fn(async (symbols: string[]) =>
      symbols.map((symbol) => ({
        symbol,
        price: 100,
        timestamp: new Date().toISOString(),
        source: "ccxt",
      })),
    ),
  };
}

let db: DbClient;

beforeEach(async () => {
  db = await openDatabase({ path: ":memory:" });
});

afterEach(async () => {
  await closeDatabase(db);
});

describe("Market API routes", () => {
  it("returns 503 when market data is unavailable", async () => {
    const app = express();
    app.use(
      "/api",
      createMarketRouter({
        decisionStore: {} as any,
        tradeEngine: {} as any,
        portfolio: {} as any,
        config: {} as any,
        currentMode: "sim",
        modeChangedAt: Date.now(),
        db,
      }),
    );
    const resp = await supertest(app).get("/api/market/quote?symbol=BTC/USDT");
    expect(resp.status).toBe(503);
    expect(resp.body.error).toBe("Market data service not available");
  });

  it("returns 503 (path-param quote variant)", async () => {
    const app = express();
    app.use(
      "/api",
      createMarketRouter({
        decisionStore: {} as any,
        tradeEngine: {} as any,
        portfolio: {} as any,
        config: {} as any,
        currentMode: "sim",
        modeChangedAt: Date.now(),
        db,
      }),
    );
    // NOTE: crypto symbols contain "/" — the path-param route only
    // matches single-segment symbols, so use a stock ticker here.
    const resp = await supertest(app).get("/api/market/quote/AAPL");
    expect(resp.status).toBe(503);
    expect(resp.body.error).toBe("Market data service unavailable");
  });

  it("GET /market/quote returns the quote", async () => {
    const marketData = makeMarketData();
    const app = makeApp(marketData);
    const resp = await supertest(app).get("/api/market/quote?symbol=BTC/USDT");
    expect(resp.status).toBe(200);
    expect(resp.body.quote.symbol).toBe("BTC/USDT");
    expect(resp.body.quote.price).toBe(100);
    expect(marketData.getQuote).toHaveBeenCalledWith("BTC/USDT");
  });

  it("GET /market/quote requires a symbol", async () => {
    const resp = await supertest(makeApp(makeMarketData())).get("/api/market/quote");
    expect(resp.status).toBe(400);
    expect(resp.body.error).toBe("Validation failed");
  });

  it("GET /market/quote returns 500 when the service throws", async () => {
    const marketData = makeMarketData();
    marketData.getQuote.mockRejectedValue(new Error("exchange down"));
    const resp = await supertest(makeApp(marketData)).get("/api/market/quote?symbol=BTC/USDT");
    expect(resp.status).toBe(500);
    expect(resp.body.error).toBe("Failed to fetch quote");
  });

  it("GET /market/bars returns bars with defaults applied", async () => {
    const marketData = makeMarketData();
    const resp = await supertest(makeApp(marketData)).get("/api/market/bars?symbol=ETH/USDT");
    expect(resp.status).toBe(200);
    expect(resp.body.bars).toHaveLength(1);
    expect(resp.body.count).toBe(1);
    expect(marketData.getBars).toHaveBeenCalledWith("ETH/USDT", "1Day", "1m");
  });

  it("GET /market/bars rejects an invalid timeframe", async () => {
    const resp = await supertest(makeApp(makeMarketData())).get(
      "/api/market/bars?symbol=ETH/USDT&timeframe=2Min",
    );
    expect(resp.status).toBe(400);
  });

  it("GET /market/bars returns 500 when the service throws", async () => {
    const marketData = makeMarketData();
    marketData.getBars.mockRejectedValue(new Error("no bars"));
    const resp = await supertest(makeApp(marketData)).get("/api/market/bars?symbol=ETH/USDT");
    expect(resp.status).toBe(500);
  });

  it("GET /market/snapshot splits symbols and returns snapshots", async () => {
    const marketData = makeMarketData();
    const resp = await supertest(makeApp(marketData)).get(
      "/api/market/snapshot?symbols=BTC/USDT,ETH/USDT",
    );
    expect(resp.status).toBe(200);
    expect(resp.body.snapshots).toHaveLength(2);
    expect(marketData.getSnapshot).toHaveBeenCalledWith(["BTC/USDT", "ETH/USDT"]);
  });

  it("GET /market/snapshot requires symbols", async () => {
    const resp = await supertest(makeApp(makeMarketData())).get("/api/market/snapshot?symbols=");
    expect(resp.status).toBe(400);
    expect(resp.body.error).toContain("symbols query parameter required");
  });

  it("GET /market/snapshot returns 500 on service error", async () => {
    const marketData = makeMarketData();
    marketData.getSnapshot.mockRejectedValue(new Error("down"));
    const resp = await supertest(makeApp(marketData)).get("/api/market/snapshot?symbols=BTC/USDT");
    expect(resp.status).toBe(500);
  });

  it("GET /market/quote/:symbol returns the quote (path variant)", async () => {
    const marketData = makeMarketData();
    const resp = await supertest(makeApp(marketData)).get("/api/market/quote/AAPL");
    expect(resp.status).toBe(200);
    expect(resp.body.quote.symbol).toBe("AAPL");
    expect(resp.body.mode).toBe("sim");
  });

  it("GET /market/quote/:symbol returns 502 on service error", async () => {
    const marketData = makeMarketData();
    marketData.getQuote.mockRejectedValue(new Error("down"));
    const resp = await supertest(makeApp(marketData)).get("/api/market/quote/AAPL");
    expect(resp.status).toBe(502);
    expect(resp.body.error).toBe("Failed to fetch quote");
  });

  it("GET /market/bars/:symbol applies query defaults (path variant)", async () => {
    const marketData = makeMarketData();
    const resp = await supertest(makeApp(marketData)).get("/api/market/bars/AAPL");
    expect(resp.status).toBe(200);
    expect(resp.body.timeframe).toBe("1Day");
    expect(resp.body.range).toBe("30d");
    expect(marketData.getBars).toHaveBeenCalledWith("AAPL", "1Day", "30d");
  });

  it("GET /market/bars/:symbol honours explicit query params (path variant)", async () => {
    const marketData = makeMarketData();
    const resp = await supertest(makeApp(marketData)).get(
      "/api/market/bars/AAPL?timeframe=1Hour&range=1w",
    );
    expect(resp.status).toBe(200);
    expect(marketData.getBars).toHaveBeenCalledWith("AAPL", "1Hour", "1w");
  });

  it("GET /market/bars/:symbol returns 502 on service error (path variant)", async () => {
    const marketData = makeMarketData();
    marketData.getBars.mockRejectedValue(new Error("down"));
    const resp = await supertest(makeApp(marketData)).get("/api/market/bars/AAPL");
    expect(resp.status).toBe(502);
  });
});

function makeApp(marketData: object) {
  const state: AppState = {
    decisionStore: {} as any,
    tradeEngine: {} as any,
    portfolio: {} as any,
    config: {} as any,
    currentMode: "sim",
    modeChangedAt: Date.now(),
    db,
    marketData: marketData as any,
  };
  const app = express();
  app.use(express.json());
  app.use("/api", createMarketRouter(state));
  return app;
}
