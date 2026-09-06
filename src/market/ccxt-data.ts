/**
 * ccxt-data.ts — CCXT market data adapter for crypto.
 *
 * Wraps the ccxt library to fetch quotes, bars, and snapshots
 * from 100+ crypto exchanges using a unified API.
 */

import ccxt from "ccxt";
import type { MarketDataService, Quote, Bar, Snapshot, Timeframe } from "./market.js";

export class CCXTMarketData implements MarketDataService {
  private exchange: ccxt.Exchange;

  constructor(exchangeId: string, apiKey: string, apiSecret: string) {
    const ExchangeClass = (ccxt as unknown as Record<string, typeof ccxt.Exchange>)[exchangeId];
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

    return ohlcv.map((candle) => ({
      symbol,
      timestamp: new Date(candle[0]).toISOString(),
      open: candle[1],
      high: candle[2],
      low: candle[3],
      close: candle[4],
      volume: candle[5],
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