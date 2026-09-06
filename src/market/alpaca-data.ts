/**
 * alpaca-data.ts — Alpaca market data adapter for stocks.
 *
 * Wraps @alpacahq/alpaca-trade-api v4 to fetch quotes, bars, and snapshots.
 */

import { Alpaca, TimeFrame } from "@alpacahq/alpaca-trade-api";
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
    const trade = await this.client.marketData.getStockTradesLatest({
      symbols: [symbol],
    });
    const data = trade.get(symbol);
    if (!data) throw new Error(`No quote data for ${symbol}`);

    return {
      symbol,
      price: data.p,
      timestamp: new Date(data.t).toISOString(),
      source: "alpaca",
    };
  }

  async getBars(symbol: string, timeframe: Timeframe, range: string): Promise<Bar[]> {
    const days = parseRangeDays(range);
    const start = new Date();
    start.setDate(start.getDate() - days);

    const tfMap: Record<Timeframe, TimeFrame> = {
      "1Min": TimeFrame.Minute,
      "5Min": TimeFrame.Min5,
      "15Min": TimeFrame.Min15,
      "1Hour": TimeFrame.Hour,
      "1Day": TimeFrame.Day,
    };

    const bars = await this.client.marketData.getStockBarsFor(symbol, {
      timeframe: tfMap[timeframe],
      start,
    });

    return bars.map((bar) => ({
      symbol,
      timestamp: new Date(bar.t).toISOString(),
      open: bar.o,
      high: bar.h,
      low: bar.l,
      close: bar.c,
      volume: bar.v,
      source: "alpaca" as const,
    }));
  }

  async getSnapshot(symbols: string[]): Promise<Snapshot[]> {
    const snapshots = await this.client.marketData.getStocksSnapshots({ symbols: symbols.join(",") });
    const results: Snapshot[] = [];

    for (const [symbol, snap] of snapshots) {
      results.push({
        symbol,
        price: snap.latestTrade.p,
        change: snap.dailyBar ? snap.dailyBar.c - snap.prevDailyBar.c : undefined,
        changePct: snap.dailyBar && snap.prevDailyBar
          ? ((snap.dailyBar.c - snap.prevDailyBar.c) / snap.prevDailyBar.c) * 100
          : undefined,
        volume: snap.dailyBar?.v,
        timestamp: new Date(snap.latestTrade.t).toISOString(),
        source: "alpaca",
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