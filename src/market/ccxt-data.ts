/**
 * ccxt-data.ts — CCXT market data adapter for crypto.
 *
 * Wraps the ccxt library to fetch quotes, bars, and snapshots
 * from 100+ crypto exchanges using a unified API.
 *
 * Public endpoints (fetchTicker, fetchOHLCV) do NOT require API keys,
 * so this adapter works in sim mode to provide real crypto prices
 * without authentication.
 *
 * Uses dynamic import (like the executor) so the ccxt package is only
 * loaded when this adapter is actually instantiated.
 */

import type { MarketDataService, Quote, Bar, Snapshot, Timeframe } from "./market.js";

// ── Structural types for the slice of ccxt we use ───────────────

interface CCXTTicker {
  symbol: string;
  last: number | undefined;
  close: number | undefined;
  bid: number | undefined;
  ask: number | undefined;
  change: number | undefined;
  percentage: number | undefined;
  baseVolume: number | undefined;
  timestamp: number | undefined;
}

interface CCXTOHLCV {
  0: number; // timestamp
  1: number; // open
  2: number; // high
  3: number; // low
  4: number; // close
  5: number; // volume
}

interface CCXTExchangeInstance {
  fetchTicker(symbol: string): Promise<CCXTTicker>;
  fetchOHLCV(symbol: string, timeframe: string, since?: number, limit?: number): Promise<CCXTOHLCV[]>;
  apiKey: string;
  secret: string;
  enableRateLimit: boolean;
}

type CCXTExchangeConstructor = new (config?: Record<string, unknown>) => CCXTExchangeInstance;

interface CCXTLibrary {
  [exchangeId: string]: CCXTExchangeConstructor;
}

// ── Dynamic loader (mirrors executor pattern) ───────────────────

let libCache: CCXTLibrary | null = null;

async function loadLib(): Promise<CCXTLibrary> {
  if (libCache) return libCache;
  try {
    // @ts-ignore — optional dependency, may not be installed
    const mod = (await import("ccxt")) as unknown;
    const lib = mod as unknown as CCXTLibrary;
    if (lib && typeof lib === "object") {
      libCache = lib;
      return libCache;
    }
  } catch {
    // fall through
  }
  throw new Error(
    "ccxt is not installed. Install it with `npm install ccxt` to use CCXTMarketData.",
  );
}

// ── Adapter ─────────────────────────────────────────────────────

export class CCXTMarketData implements MarketDataService {
  private exchange: CCXTExchangeInstance | null = null;
  private readonly exchangeId: string;
  private readonly apiKey: string;
  private readonly apiSecret: string;

  /**
   * @param exchangeId  CCXT exchange id, e.g. "binance", "coinbase", "kraken"
   * @param apiKey      Optional — public endpoints work without keys
   * @param apiSecret   Optional — public endpoints work without keys
   */
  constructor(exchangeId: string, apiKey?: string, apiSecret?: string) {
    if (!exchangeId) throw new Error("CCXTMarketData requires an exchange id");
    this.exchangeId = exchangeId;
    this.apiKey = apiKey ?? "";
    this.apiSecret = apiSecret ?? "";
  }

  /** Lazily instantiate the configured CCXT exchange. */
  private async getExchange(): Promise<CCXTExchangeInstance> {
    if (this.exchange) return this.exchange;
    const lib = await loadLib();
    const ExchangeCtor = lib[this.exchangeId];
    if (!ExchangeCtor || typeof ExchangeCtor !== "function") {
      throw new Error(
        `Unknown CCXT exchange "${this.exchangeId}". Check the exchange id against the ccxt documentation.`,
      );
    }
    this.exchange = new ExchangeCtor({
      apiKey: this.apiKey || undefined,
      secret: this.apiSecret || undefined,
      enableRateLimit: true,
    });
    return this.exchange;
  }

  async getQuote(symbol: string): Promise<Quote> {
    const ex = await this.getExchange();
    const ticker = await ex.fetchTicker(symbol);
    const price = ticker.last ?? ticker.close ?? 0;
    if (price <= 0) throw new Error(`No price data for ${symbol} on ${this.exchangeId}`);
    return {
      symbol,
      price,
      bid: ticker.bid,
      ask: ticker.ask,
      timestamp: new Date(ticker.timestamp ?? Date.now()).toISOString(),
      source: "ccxt",
    };
  }

  async getBars(symbol: string, timeframe: Timeframe, range: string): Promise<Bar[]> {
    const ex = await this.getExchange();

    const tfMap: Record<Timeframe, string> = {
      "1Min": "1m",
      "5Min": "5m",
      "15Min": "15m",
      "1Hour": "1h",
      "1Day": "1d",
    };

    const days = parseRangeDays(range);
    const since = Date.now() - days * 24 * 60 * 60 * 1000;

    const ohlcv = await ex.fetchOHLCV(symbol, tfMap[timeframe], since);

    return ohlcv.map((candle): Bar => ({
      symbol,
      timestamp: new Date(candle[0] ?? Date.now()).toISOString(),
      open: Number(candle[1] ?? 0),
      high: Number(candle[2] ?? 0),
      low: Number(candle[3] ?? 0),
      close: Number(candle[4] ?? 0),
      volume: Number(candle[5] ?? 0),
      source: "ccxt" as const,
    }));
  }

  async getSnapshot(symbols: string[]): Promise<Snapshot[]> {
    const ex = await this.getExchange();
    const results: Snapshot[] = [];
    for (const symbol of symbols) {
      const ticker = await ex.fetchTicker(symbol);
      const price = ticker.last ?? ticker.close ?? 0;
      if (price > 0) {
        results.push({
          symbol,
          price,
          change: ticker.change,
          changePct: ticker.percentage,
          volume: ticker.baseVolume,
          timestamp: new Date(ticker.timestamp ?? Date.now()).toISOString(),
          source: "ccxt",
        });
      }
    }
    return results;
  }
}

function parseRangeDays(range: string): number {
  const match = range.match(/^(\d+)([dwmy])$/);
  if (!match) return 30;
  const n = parseInt(match[1], 10);
  const unit = match[2];
  switch (unit) {
    case "d": return n;
    case "w": return n * 7;
    case "m": return n * 30;
    case "y": return n * 365;
    default: return 30;
  }
}