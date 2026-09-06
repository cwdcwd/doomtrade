/**
 * alpaca-data.ts — Alpaca market data adapter for stocks.
 *
 * Wraps @alpacahq/alpaca-trade-api v4 to fetch quotes, bars, and snapshots.
 */

import { Alpaca, timeFrame, TimeFrameUnit } from "@alpacahq/alpaca-trade-api";
import type { MarketDataService, Quote, Bar, Snapshot, Timeframe } from "./market.js";

export class AlpacaMarketData implements MarketDataService {
  private client: Alpaca;

  constructor(keyId: string, secretKey: string, paper: boolean) {
    this.client = new Alpaca({
      keyId,
      secret: secretKey,
      paper,
    });
  }

  async getQuote(symbol: string): Promise<Quote> {
    const trades = await this.client.marketData.getStockTradesFor(symbol, {
      start: new Date(Date.now() - 60_000),
      end: new Date(),
    });
    const trade = trades[trades.length - 1];
    if (!trade) throw new Error(`No quote data for ${symbol}`);

    return {
      symbol,
      price: trade.price,
      timestamp: new Date(trade.timestamp).toISOString(),
      source: "alpaca",
    };
  }

  async getBars(symbol: string, timeframe: Timeframe, range: string): Promise<Bar[]> {
    const days = parseRangeDays(range);
    const start = new Date();
    start.setDate(start.getDate() - days);

    const tf = timeframeToAlpaca(timeframe);
    const bars = await this.client.marketData.getStockBarsFor(symbol, {
      timeframe: tf,
      start,
    });

    return bars.map((bar) => ({
      symbol,
      timestamp: new Date(bar.timestamp).toISOString(),
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: bar.volume,
      source: "alpaca" as const,
    }));
  }

  async getSnapshot(symbols: string[]): Promise<Snapshot[]> {
    // MarketDataClient doesn't expose snapshots directly — fetch
    // the latest trade for each symbol as a fallback.
    const results: Snapshot[] = [];
    for (const symbol of symbols) {
      try {
        const trades = await this.client.marketData.getStockTradesFor(symbol, {
          start: new Date(Date.now() - 5 * 60_000),
          end: new Date(),
        });
        const trade = trades[trades.length - 1];
        if (trade) {
          results.push({
            symbol,
            price: trade.price,
            timestamp: new Date(trade.timestamp).toISOString(),
            source: "alpaca",
          });
        }
      } catch {
        // Skip symbols with no data
      }
    }
    return results;
  }
}

/**
 * Convert our Timeframe enum to an Alpaca TimeFrameString.
 */
function timeframeToAlpaca(tf: Timeframe) {
  switch (tf) {
    case "1Min": return timeFrame(1, TimeFrameUnit.Minute);
    case "5Min": return timeFrame(5, TimeFrameUnit.Minute);
    case "15Min": return timeFrame(15, TimeFrameUnit.Minute);
    case "1Hour": return timeFrame(1, TimeFrameUnit.Hour);
    case "1Day": return timeFrame(1, TimeFrameUnit.Day);
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