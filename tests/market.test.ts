import { describe, it, expect } from "vitest";
import {
  isCryptoSymbol,
  isStockSymbol,
  QuoteSchema,
  BarSchema,
  SnapshotSchema,
} from "../src/market/market.js";

describe("symbol detection", () => {
  it("detects crypto symbols with slash", () => {
    expect(isCryptoSymbol("BTC/USDT")).toBe(true);
    expect(isCryptoSymbol("ETH/USD")).toBe(true);
    expect(isCryptoSymbol("SOL/USDC")).toBe(true);
  });

  it("detects stock symbols without slash", () => {
    expect(isStockSymbol("AAPL")).toBe(true);
    expect(isStockSymbol("TSLA")).toBe(true);
    expect(isStockSymbol("GOOGL")).toBe(true);
  });

  it("stock symbols are not crypto", () => {
    expect(isCryptoSymbol("AAPL")).toBe(false);
  });

  it("crypto symbols are not stock", () => {
    expect(isStockSymbol("BTC/USDT")).toBe(false);
  });

  it("lowercase is not a stock symbol", () => {
    expect(isStockSymbol("aapl")).toBe(false);
  });
});

describe("Quote schema validation", () => {
  it("validates a correct quote", () => {
    const quote = {
      symbol: "AAPL",
      price: 150.25,
      timestamp: new Date().toISOString(),
      source: "alpaca",
    };
    expect(QuoteSchema.safeParse(quote).success).toBe(true);
  });

  it("rejects negative price", () => {
    const quote = {
      symbol: "AAPL",
      price: -1,
      timestamp: new Date().toISOString(),
      source: "alpaca",
    };
    expect(QuoteSchema.safeParse(quote).success).toBe(false);
  });

  it("rejects invalid source", () => {
    const quote = {
      symbol: "AAPL",
      price: 150,
      timestamp: new Date().toISOString(),
      source: "bloomberg",
    };
    expect(QuoteSchema.safeParse(quote).success).toBe(false);
  });

  it("accepts optional bid/ask", () => {
    const quote = {
      symbol: "BTC/USDT",
      price: 65000,
      bid: 64990,
      ask: 65010,
      timestamp: new Date().toISOString(),
      source: "ccxt",
    };
    expect(QuoteSchema.safeParse(quote).success).toBe(true);
  });
});

describe("Bar schema validation", () => {
  it("validates a correct bar", () => {
    const bar = {
      symbol: "AAPL",
      timestamp: new Date().toISOString(),
      open: 150,
      high: 155,
      low: 149,
      close: 153,
      volume: 1000000,
      source: "alpaca",
    };
    expect(BarSchema.safeParse(bar).success).toBe(true);
  });

  it("rejects missing volume", () => {
    const bar = {
      symbol: "AAPL",
      timestamp: new Date().toISOString(),
      open: 150,
      high: 155,
      low: 149,
      close: 153,
      source: "alpaca",
    };
    expect(BarSchema.safeParse(bar).success).toBe(false);
  });
});

describe("Snapshot schema validation", () => {
  it("validates a correct snapshot", () => {
    const snap = {
      symbol: "BTC/USDT",
      price: 65000,
      change: 500,
      changePct: 0.77,
      volume: 1000,
      timestamp: new Date().toISOString(),
      source: "ccxt",
    };
    expect(SnapshotSchema.safeParse(snap).success).toBe(true);
  });

  it("accepts minimal snapshot without optional fields", () => {
    const snap = {
      symbol: "AAPL",
      price: 150,
      timestamp: new Date().toISOString(),
      source: "alpaca",
    };
    expect(SnapshotSchema.safeParse(snap).success).toBe(true);
  });
});