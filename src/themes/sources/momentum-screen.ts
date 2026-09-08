/**
 * MomentumScreenSignalSource — screens a universe of symbols using
 * ResearchService.analyze() to compute technical indicators and produce
 * buy/sell signals based on a scoring method.
 *
 * Scoring methods:
 * - "sma-crossover" — SMA20/50 crossover signal
 * - "rsi"            — RSI oversold/overbought
 * - "combined"       — SMA crossover takes priority, RSI confirms
 *
 * Returns ThemeSignals for every symbol in the universe, tagged with
 * the indicator values and a human-readable reason.
 */

import type { SignalSource } from "../signal-source.js";
import type { ThemeSignal } from "../theme.js";
import type { ResearchService, TechnicalAnalysis } from "../../research/research.js";
import type { Timeframe } from "../../market/market.js";

export type MomentumMethod = "sma-crossover" | "rsi" | "combined";

export interface MomentumScreenConfig {
  /** Symbol universe to screen (e.g. ["AAPL", "NVDA", "TSLA"]). */
  universe: string[];
  /** Bar timeframe (default "1Day"). */
  timeframe?: Timeframe;
  /** Lookback range (default "6m"). */
  range?: string;
  /** Scoring method (default "combined"). */
  method?: MomentumMethod;
  /** RSI oversold threshold (default 30). */
  rsiOversold?: number;
  /** RSI overbought threshold (default 70). */
  rsiOverbought?: number;
}

interface ScreenResult {
  analysis: TechnicalAnalysis;
  signal: "buy" | "sell" | "hold";
  score: number;
}

export class MomentumScreenSignalSource implements SignalSource {
  readonly name = "momentum-screen";

  private research: ResearchService;
  private config: Required<MomentumScreenConfig>;

  constructor(research: ResearchService, config: MomentumScreenConfig) {
    this.research = research;
    this.config = {
      universe: config.universe,
      timeframe: config.timeframe ?? "1Day",
      range: config.range ?? "6m",
      method: config.method ?? "combined",
      rsiOversold: config.rsiOversold ?? 30,
      rsiOverbought: config.rsiOverbought ?? 70,
    };
  }

  /**
   * Screen the universe: fetch bars, compute indicators, produce signals.
   * Symbols that fail to fetch are silently skipped (errors logged via console).
   */
  async fetchSignals(): Promise<ThemeSignal[]> {
    const results = await this.screenAll();

    return results.map(({ analysis, signal }) => {
      const ind = analysis.indicators;
      const parts: string[] = [
        `${analysis.symbol} at $${analysis.lastPrice.toFixed(2)}`,
      ];
      if (ind.sma20 !== null) parts.push(`SMA20=$${ind.sma20.toFixed(2)}`);
      if (ind.sma50 !== null) parts.push(`SMA50=$${ind.sma50.toFixed(2)}`);
      if (ind.rsi14 !== null) parts.push(`RSI14=${ind.rsi14.toFixed(1)}`);

      const sigLabel = analysis.signals[this.config.method === "rsi" ? "rsi" : "smaCrossover"];
      if (this.config.method === "combined") {
        parts.push(`Signal: ${analysis.signals.combined.toUpperCase()}`);
      } else if (this.config.method === "rsi") {
        parts.push(`Signal: ${analysis.signals.rsi.toUpperCase()}`);
      } else {
        parts.push(`Signal: ${analysis.signals.smaCrossover.toUpperCase()}`);
      }

      return {
        symbol: analysis.symbol,
        action: signal,
        priceAtSignal: analysis.lastPrice,
        reason: parts.join(", "),
        metadata: {
          sma20: ind.sma20,
          sma50: ind.sma50,
          rsi14: ind.rsi14,
          method: this.config.method,
          timeframe: this.config.timeframe,
          range: this.config.range,
        },
      };
    });
  }

  /**
   * Screen every symbol in the universe, returning results with scores.
   * Buy signals get score +1, sell signals get score -1, hold gets 0.
   * Sorted by absolute score descending (strongest signals first).
   */
  async screenAll(): Promise<ScreenResult[]> {
    const results: ScreenResult[] = [];

    for (const symbol of this.config.universe) {
      try {
        const analysis = await this.research.analyze(
          symbol,
          this.config.timeframe,
          this.config.range,
        );

        const signal = this.resolveSignal(analysis);
        const score = signal === "buy" ? 1 : signal === "sell" ? -1 : 0;

        results.push({ analysis, signal, score });
      } catch (err) {
        // Skip symbols that fail to fetch — common for illiquid or delisted
        console.warn(
          `MomentumScreen: skipping ${symbol}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Sort: buys first (score desc), then holds, then sells
    results.sort((a, b) => b.score - a.score);

    return results;
  }

  /**
   * Resolve a TechnicalAnalysis into a buy/sell/hold signal using the
   * configured scoring method.
   */
  private resolveSignal(analysis: TechnicalAnalysis): "buy" | "sell" | "hold" {
    const { signals } = analysis;
    let raw: "buy" | "sell" | "neutral";

    if (this.config.method === "sma-crossover") {
      raw = signals.smaCrossover;
    } else if (this.config.method === "rsi") {
      raw = signals.rsi;
    } else {
      // combined
      raw = signals.combined;
    }

    // Apply RSI thresholds when method includes RSI
    if (this.config.method === "rsi" || this.config.method === "combined") {
      const rsiVal = analysis.indicators.rsi14;
      if (rsiVal !== null) {
        if (rsiVal < this.config.rsiOversold) raw = "buy";
        if (rsiVal > this.config.rsiOverbought) raw = "sell";
      }
    }

    return raw === "neutral" ? "hold" : raw;
  }

  /**
   * Get only the buy signals from the screen — convenience for strategies
   * that only care about long entries.
   */
  async fetchBuySignals(): Promise<ThemeSignal[]> {
    const all = await this.fetchSignals();
    return all.filter((s) => s.action === "buy");
  }

  /**
   * Get only the sell signals from the screen.
   */
  async fetchSellSignals(): Promise<ThemeSignal[]> {
    const all = await this.fetchSignals();
    return all.filter((s) => s.action === "sell");
  }
}