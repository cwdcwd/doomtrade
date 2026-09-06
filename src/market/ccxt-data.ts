/**
 * ccxt-data.ts — CCXT market data adapter for crypto.
 *
 * Wraps the ccxt library to fetch quotes, bars, and snapshots
 * from 100+ crypto exchanges using a unified API.
 */

import ccxt, { type Exchange } from "ccxt";
import type { MarketDataService, Quote, Bar, Snapshot, Timeframe } from "./market.js";

export class CCXTMarketData implements MarketDataService {
  private exchange: Exchange;

  constructor(exchangeId: string, apiKey: string, apiSecret: string) {
    const ExchangeClass = (ccxt as unknown as Record<string, new (config?: Record<string, unknown>) => Exchange>)[exchangeId];
    if (!ExchangeClass) throw new Error(`Unknown exchange: ${exchangeId}`);

    this.exchange = new ExchangeClass({
      apiKey: apiKey || undefined,
      secret: apiSecret || undefined,
      enableRateLimit: true,
    });
  }

  async getQuote(symbol: string): Promise<Quote> {
    const ticker = await this.exchange.fetchTicker(symbol);
    return {
      symbol,
      price: ticker.last ?? ticker.close ?? 0,
      bid: ticker.bid,
      ask: ticker.ask,
      timestamp: new Date(ticker.timestamp ?? Date.now()).toISOString(),
      source: "ccxt",
    };
  }

  async getBars(symbol: string, timeframe: Timeframe, range: string): Promise<Bar[]> {
    const tfMap: Record<Timeframe, string> = {
      "1Min": "1m",
      "5Min": "5m",
      "15Min": "15m",
      "1Hour": "1h",
      "1Day": "1d",
    };

    const days = parseRangeDays(range);
    const since = Date.now() - days * 24 * 60 * 60 * 1000;

    const ohlcv = await this.exchange.fetchOHLCV(symbol, tfMap[timeframe], since);

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
    const results: Snapshot[] = [];
    for (const symbol of symbols) {
      const ticker = await this.exchange.fetchTicker(symbol);
      results.push({
        symbol,
        price: ticker.last ?? ticker.close ?? 0,
        change: ticker.change,
        changePct: ticker.percentage,
        volume: ticker.baseVolume,
        timestamp: new Date(ticker.timestamp ?? Date.now()).toISOString(),
        source: "ccxt",
      });
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