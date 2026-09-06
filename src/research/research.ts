/**
 * research.ts — Research module: fetch market data, compute indicators,
 * produce analysis for trading decisions.
 *
 * Combines MarketDataService (bars data) with technical indicators
 * (SMA, RSI) to generate signals that agents can use in their
 * decision-making rationale.
 */

import type { MarketDataService, Bar, Timeframe } from "../market/market.js";
import {
  sma,
  rsi,
  smaCrossover,
  rsiSignal,
  type Signal,
} from "./indicators.js";

// ── Types ───────────────────────────────────────────────────────

export interface TechnicalAnalysis {
  symbol: string;
  timeframe: Timeframe;
  range: string;
  barCount: number;
  lastPrice: number;
  indicators: {
    sma20: number | null;
    sma50: number | null;
    rsi14: number | null;
  };
  signals: {
    smaCrossover: Signal;
    rsi: Signal;
    combined: Signal;
  };
  /** Human-readable summary for agent decision rationale */
  summary: string;
  timestamp: string;
}

// ── Research Service ────────────────────────────────────────────

export class ResearchService {
  private marketData: MarketDataService;

  constructor(marketData: MarketDataService) {
    this.marketData = marketData;
  }

  /**
   * Fetch bars and compute technical analysis for a symbol.
   *
   * @param symbol    Trading symbol (e.g. "BTC/USDT", "AAPL")
   * @param timeframe Bar timeframe (default "1Day")
   * @param range     Range string like "3m", "6m", "1y" (default "6m")
   * @returns         TechnicalAnalysis with SMA 20/50, RSI 14, and signals
   */
  async analyze(
    symbol: string,
    timeframe: Timeframe = "1Day",
    range: string = "6m",
  ): Promise<TechnicalAnalysis> {
    const bars = await this.marketData.getBars(symbol, timeframe, range);
    if (bars.length === 0) {
      throw new Error(`No bar data for ${symbol} (${timeframe}, ${range})`);
    }

    const closes = bars.map((b) => b.close);
    const lastPrice = closes[closes.length - 1];

    // Compute indicators
    const sma20 = sma(closes, 20);
    const sma50 = sma(closes, 50);
    const rsi14 = rsi(closes, 14);

    // Compute signals
    const smaXover = smaCrossover(closes, 20, 50);
    const rsiSig = rsiSignal(closes, 14);

    // Combined signal: SMA crossover takes priority, RSI confirms
    let combined: Signal = "neutral";
    if (smaXover !== "neutral") {
      combined = smaXover;
    } else if (rsiSig !== "neutral") {
      combined = rsiSig;
    }

    // Build summary
    const parts: string[] = [
      `${symbol} at $${lastPrice.toFixed(2)}`,
    ];
    if (sma20 !== null) parts.push(`SMA20=$${sma20.toFixed(2)}`);
    if (sma50 !== null) parts.push(`SMA50=$${sma50.toFixed(2)}`);
    if (rsi14 !== null) parts.push(`RSI14=${rsi14.toFixed(1)}`);

    if (smaXover === "buy") parts.push("Golden cross (SMA20 above SMA50)");
    else if (smaXover === "sell") parts.push("Death cross (SMA20 below SMA50)");

    if (rsiSig === "buy") parts.push("RSI oversold");
    else if (rsiSig === "sell") parts.push("RSI overbought");

    parts.push(`Signal: ${combined.toUpperCase()}`);

    return {
      symbol,
      timeframe,
      range,
      barCount: bars.length,
      lastPrice,
      indicators: { sma20, sma50, rsi14 },
      signals: {
        smaCrossover: smaXover,
        rsi: rsiSig,
        combined,
      },
      summary: parts.join(", "),
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Fetch current price for a symbol via the market data service.
   * Convenience method for decision priceAtDecision.
   */
  async getPrice(symbol: string): Promise<number> {
    const quote = await this.marketData.getQuote(symbol);
    return quote.price;
  }

  /**
   * Get the latest bars for a symbol without computing indicators.
   */
  async getBars(symbol: string, timeframe: Timeframe = "1Day", range: string = "1m"): Promise<Bar[]> {
    return this.marketData.getBars(symbol, timeframe, range);
  }
}