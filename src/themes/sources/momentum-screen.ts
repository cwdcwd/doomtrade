/**
 * MomentumScreenSignalSource — screens a universe of symbols for momentum
 * signals using technical indicators (SMA crossover, RSI, or combined).
 *
 * Unlike CongressTradesSignalSource (which fetches from an external API),
 * this source pulls historical bar data from MarketDataService and
 * computes indicators locally.
 *
 * Signal logic:
 *   - sma-crossover: buy when fast SMA crosses above slow SMA (golden cross),
 *     sell when fast SMA crosses below slow SMA (death cross).
 *   - rsi: buy when RSI < 30 (oversold), sell when RSI > 70 (overbought).
 *   - combined: buy when both sma-crossover and rsi agree on buy,
 *     sell when both agree on sell, hold otherwise.
 *
 * Since SignalSource.fetchSignals() takes no context parameter, the
 * MarketDataService and universe/indicator config are injected via the
 * constructor.
 */

import type { SignalSource } from "../signal-source.js";
import type { ThemeSignal } from "../theme.js";
import type { MarketDataService, Bar, Timeframe } from "../../market/market.js";
import { smaCrossover, rsiSignal, combinedSignal, type Signal } from "../../research/indicators.js";

// ── Config types ───────────────────────────────────────────────

/** Indicator type for momentum screening. */
export type IndicatorType = "sma-crossover" | "rsi" | "combined";

/** SMA crossover indicator config. */
export interface SmaCrossoverConfig {
  type: "sma-crossover";
  periods: { fast: number; slow: number };
}

/** RSI indicator config. */
export interface RsiConfig {
  type: "rsi";
  period: number;
  /** Oversold threshold (default 30). */
  oversold?: number;
  /** Overbought threshold (default 70). */
  overbought?: number;
}

/** Combined indicator config (uses both SMA crossover and RSI). */
export interface CombinedConfig {
  type: "combined";
  periods: { fast: number; slow: number };
  rsiPeriod: number;
  /**
   * How many recent bars to search for the SMA crossover (default 5).
   * v2 (doomtrade-hyi): the cross may have occurred anywhere within this
   * window — not only on the exact latest bar. RSI acts as a gate, not a
   * second concurrent requirement.
   */
  crossWindow?: number;
  oversold?: number;
  overbought?: number;
}

export type IndicatorConfig = SmaCrossoverConfig | RsiConfig | CombinedConfig;

export interface MomentumScreenConfig {
  /** Universe of symbols to screen. */
  universe: string[];
  /** Indicator configuration. */
  indicator: IndicatorConfig;
  /** Bar timeframe (default "1Day"). */
  timeframe?: Timeframe;
  /** Bar range (default "6m"). */
  range?: string;
}

// ── Signal source implementation ───────────────────────────────

export class MomentumScreenSignalSource implements SignalSource {
  readonly name = "momentum-screen";

  private marketData: MarketDataService;
  private universe: string[];
  private indicator: IndicatorConfig;
  private timeframe: Timeframe;
  private range: string;

  constructor(marketData: MarketDataService, config: MomentumScreenConfig) {
    this.marketData = marketData;
    this.universe = config.universe;
    this.indicator = config.indicator;
    this.timeframe = config.timeframe ?? "1Day";
    this.range = config.range ?? "6m";
  }

  async fetchSignals(): Promise<ThemeSignal[]> {
    const signals: ThemeSignal[] = [];

    for (const symbol of this.universe) {
      try {
        const bars = await this.marketData.getBars(symbol, this.timeframe, this.range);
        if (bars.length === 0) continue;

        const closes = bars.map((b: Bar) => b.close);
        const lastPrice = closes[closes.length - 1];

        const signal = this.computeSignal(symbol, closes);
        if (signal === null) continue;

        signals.push(signal);
      } catch {
        // Skip symbols that error out — don't abort the entire screen
        continue;
      }
    }

    return signals;
  }

  /**
   * Compute a ThemeSignal for a symbol based on the configured indicator
   * and its closing-price series.
   *
   * Returns null if the signal is "neutral" and should be omitted from
   * the output (strategies only care about actionable buy/sell signals).
   * For "combined" mode, returns a "hold" signal when indicators disagree
   * so the strategy can see the full state.
   */
  private computeSignal(symbol: string, closes: number[]): ThemeSignal | null {
    const ind = this.indicator;

    if (ind.type === "sma-crossover") {
      const { fast, slow } = ind.periods;
      const sig = smaCrossover(closes, fast, slow);
      return this.toThemeSignal(
        symbol,
        sig,
        closes,
        "sma-crossover",
        `SMA(${fast}/${slow}) crossover`,
      );
    }

    if (ind.type === "rsi") {
      const period = ind.period;
      const sig = rsiSignal(closes, period, ind.oversold ?? 30, ind.overbought ?? 70);
      return this.toThemeSignal(symbol, sig, closes, "rsi", `RSI(${period})`);
    }

    // combined — v2 (doomtrade-hyi): cross within window + RSI gate
    const { fast, slow } = ind.periods;
    const sig = combinedSignal(closes, {
      fastPeriod: fast,
      slowPeriod: slow,
      rsiPeriod: ind.rsiPeriod,
      crossWindow: ind.crossWindow ?? 5,
      overbought: ind.overbought ?? 70,
      oversold: ind.oversold ?? 30,
    });

    let action: "buy" | "sell" | "hold";
    let reason: string;

    if (sig === "buy" || sig === "sell") {
      action = sig;
      reason =
        sig === "buy"
          ? `Combined: SMA(${fast}/${slow}) golden cross within ${ind.crossWindow ?? 5} bars + RSI(${ind.rsiPeriod}) not overbought`
          : `Combined: SMA(${fast}/${slow}) death cross within ${ind.crossWindow ?? 5} bars + RSI(${ind.rsiPeriod}) not oversold`;
    } else {
      // No actionable combined signal — emit hold so the strategy has
      // full visibility (previous versions emitted hold on disagreement)
      action = "hold";
      reason = `Combined: no cross within ${ind.crossWindow ?? 5}-bar window or RSI gate vetoed`;
    }

    const lastPrice = closes[closes.length - 1];

    return {
      symbol,
      action,
      priceAtSignal: lastPrice,
      reason,
      metadata: {
        indicator: "combined",
        combinedSignal: sig,
        crossWindow: ind.crossWindow ?? 5,
        fastPeriod: fast,
        slowPeriod: slow,
        rsiPeriod: ind.rsiPeriod,
      },
    };
  }

  /**
   * Convert an indicator Signal ("buy"/"sell"/"neutral") to a ThemeSignal.
   * Returns null for "neutral" — those symbols have no actionable signal.
   */
  private toThemeSignal(
    symbol: string,
    sig: Signal,
    closes: number[],
    indicatorName: string,
    label: string,
  ): ThemeSignal | null {
    if (sig === "neutral") return null;

    const lastPrice = closes[closes.length - 1];
    const reason = sig === "buy" ? `${label}: bullish signal` : `${label}: bearish signal`;

    return {
      symbol,
      action: sig, // "buy" | "sell"
      priceAtSignal: lastPrice,
      reason,
      metadata: {
        indicator: indicatorName,
        signal: sig,
      },
    };
  }
}
