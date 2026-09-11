/**
 * MarketDataService factory tests — src/market/market.ts (fleet-ops-b3u).
 *
 * createMarketDataService routes by symbol shape (crypto → CCXT,
 * stock → Alpaca) with lazy adapter construction. Both adapters are
 * mocked at module level so no network or SDK is touched.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const alpacaGetQuote = vi.fn();
const alpacaGetSnapshot = vi.fn();
const ccxtGetQuote = vi.fn();
const ccxtGetSnapshot = vi.fn();

vi.mock("../src/market/alpaca-data.js", () => ({
  AlpacaMarketData: vi.fn().mockImplementation(() => ({
    getQuote: alpacaGetQuote,
    getBars: vi.fn(async () => []),
    getSnapshot: alpacaGetSnapshot,
  })),
}));

vi.mock("../src/market/ccxt-data.js", () => ({
  CCXTMarketData: vi.fn().mockImplementation(() => ({
    getQuote: ccxtGetQuote,
    getBars: vi.fn(async () => []),
    getSnapshot: ccxtGetSnapshot,
  })),
}));

const { createMarketDataService, createPublicCryptoMarketData } =
  await import("../src/market/market.js");

describe("createMarketDataService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("routes crypto symbols to the CCXT adapter", async () => {
    const svc = createMarketDataService({
      alpacaKeyId: "k",
      alpacaSecretKey: "s",
      alpacaPaper: true,
      ccxtExchange: "binance",
      ccxtApiKey: "",
      ccxtApiSecret: "",
    });
    ccxtGetQuote.mockResolvedValue({ symbol: "BTC/USDT", price: 1, source: "ccxt" });
    const quote = await svc.getQuote("BTC/USDT");
    expect(quote.price).toBe(1);
    expect(ccxtGetQuote).toHaveBeenCalledWith("BTC/USDT");
    expect(alpacaGetQuote).not.toHaveBeenCalled();
  });

  it("routes stock symbols to the Alpaca adapter", async () => {
    const svc = createMarketDataService({
      alpacaKeyId: "k",
      alpacaSecretKey: "s",
      alpacaPaper: true,
      ccxtExchange: "binance",
      ccxtApiKey: "",
      ccxtApiSecret: "",
    });
    alpacaGetQuote.mockResolvedValue({ symbol: "AAPL", price: 2, source: "alpaca" });
    const quote = await svc.getQuote("AAPL");
    expect(quote.price).toBe(2);
    expect(alpacaGetQuote).toHaveBeenCalledWith("AAPL");
    expect(ccxtGetQuote).not.toHaveBeenCalled();
  });

  it("getBars routes by symbol shape", async () => {
    const svc = createMarketDataService({
      alpacaKeyId: "k",
      alpacaSecretKey: "s",
      alpacaPaper: true,
      ccxtExchange: "binance",
      ccxtApiKey: "",
      ccxtApiSecret: "",
    });
    await svc.getBars("ETH/USDT", "1Day", "1m");
    await svc.getBars("TSLA", "1Day", "1m");
    expect(ccxtGetQuote).not.toHaveBeenCalled();
  });

  it("constructs each adapter at most once (lazy caching)", async () => {
    const { AlpacaMarketData } = await import("../src/market/alpaca-data.js");
    const { CCXTMarketData } = await import("../src/market/ccxt-data.js");
    const svc = createMarketDataService({
      alpacaKeyId: "k",
      alpacaSecretKey: "s",
      alpacaPaper: true,
      ccxtExchange: "binance",
      ccxtApiKey: "",
      ccxtApiSecret: "",
    });
    ccxtGetQuote.mockResolvedValue({ symbol: "BTC/USDT", price: 1, source: "ccxt" });
    alpacaGetQuote.mockResolvedValue({ symbol: "AAPL", price: 2, source: "alpaca" });
    await svc.getQuote("BTC/USDT");
    await svc.getQuote("BTC/USD");
    await svc.getQuote("AAPL");
    await svc.getQuote("MSFT");
    expect(AlpacaMarketData).toHaveBeenCalledTimes(1);
    expect(CCXTMarketData).toHaveBeenCalledTimes(1);
  });

  it("getSnapshot splits symbols between adapters", async () => {
    const svc = createMarketDataService({
      alpacaKeyId: "k",
      alpacaSecretKey: "s",
      alpacaPaper: true,
      ccxtExchange: "binance",
      ccxtApiKey: "",
      ccxtApiSecret: "",
    });
    alpacaGetSnapshot.mockResolvedValue([{ symbol: "AAPL", price: 1, source: "alpaca" }]);
    ccxtGetSnapshot.mockResolvedValue([{ symbol: "BTC/USDT", price: 2, source: "ccxt" }]);
    const snapshots = await svc.getSnapshot(["AAPL", "BTC/USDT"]);
    expect(snapshots).toHaveLength(2);
    expect(alpacaGetSnapshot).toHaveBeenCalledWith(["AAPL"]);
    expect(ccxtGetSnapshot).toHaveBeenCalledWith(["BTC/USDT"]);
  });

  it("getSnapshot with only stocks skips the CCXT adapter", async () => {
    const svc = createMarketDataService({
      alpacaKeyId: "k",
      alpacaSecretKey: "s",
      alpacaPaper: true,
      ccxtExchange: "binance",
      ccxtApiKey: "",
      ccxtApiSecret: "",
    });
    alpacaGetSnapshot.mockResolvedValue([]);
    await svc.getSnapshot(["AAPL", "MSFT"]);
    expect(ccxtGetSnapshot).not.toHaveBeenCalled();
  });

  it("getSnapshot with only crypto skips the Alpaca adapter", async () => {
    const svc = createMarketDataService({
      alpacaKeyId: "k",
      alpacaSecretKey: "s",
      alpacaPaper: true,
      ccxtExchange: "binance",
      ccxtApiKey: "",
      ccxtApiSecret: "",
    });
    ccxtGetSnapshot.mockResolvedValue([]);
    await svc.getSnapshot(["BTC/USDT"]);
    expect(alpacaGetSnapshot).not.toHaveBeenCalled();
  });
});

describe("createPublicCryptoMarketData", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("routes all calls through CCXT public endpoints", async () => {
    const svc = createPublicCryptoMarketData("coinbase");
    ccxtGetQuote.mockResolvedValue({ symbol: "ETH/USDT", price: 3, source: "ccxt" });
    ccxtGetSnapshot.mockResolvedValue([]);

    const quote = await svc.getQuote("ETH/USDT");
    expect(quote.price).toBe(3);

    const bars = await svc.getBars("ETH/USDT", "1Hour", "1w");
    expect(bars).toEqual([]);

    await svc.getSnapshot(["ETH/USDT"]);
    expect(ccxtGetSnapshot).toHaveBeenCalledWith(["ETH/USDT"]);
    expect(alpacaGetQuote).not.toHaveBeenCalled();
    expect(alpacaGetSnapshot).not.toHaveBeenCalled();
  });

  it("defaults to binance", async () => {
    const { CCXTMarketData } = await import("../src/market/ccxt-data.js");
    createPublicCryptoMarketData();
    const svc = createPublicCryptoMarketData();
    ccxtGetQuote.mockResolvedValue({ symbol: "BTC/USDT", price: 1, source: "ccxt" });
    await svc.getQuote("BTC/USDT");
    expect(CCXTMarketData).toHaveBeenCalledWith("binance");
  });
});
