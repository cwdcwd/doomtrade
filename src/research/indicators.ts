/**
 * indicators.ts — Technical indicators computed from bar data.
 *
 * Pure functions — no external dependencies, no I/O.
 * Each indicator takes an array of numbers (typically closing prices
 * from Bar[]) and returns the indicator value(s).
 *
 * Implemented:
 *   - SMA (Simple Moving Average) — any period
 *   - EMA (Exponential Moving Average) — any period
 *   - RSI (Relative Strength Index) — Wilder's smoothing
 */

// ── SMA ─────────────────────────────────────────────────────────

/**
 * Compute the Simple Moving Average over a window.
 *
 * @param values  Ordered series (oldest first), typically closing prices
 * @param period  Lookback window (e.g. 20, 50)
 * @returns       The latest SMA value, or null if not enough data
 */
export function sma(values: number[], period: number): number | null {
  if (period <= 0) throw new Error("SMA period must be positive");
  if (values.length < period) return null;

  let sum = 0;
  for (let i = values.length - period; i < values.length; i++) {
    sum += values[i];
  }
  return sum / period;
}

/**
 * Compute SMA for every point in the series — returns an array aligned
 * with the input. The first `period - 1` entries are null (insufficient data).
 */
export function smaSeries(values: number[], period: number): (number | null)[] {
  if (period <= 0) throw new Error("SMA period must be positive");
  const result: (number | null)[] = [];

  let runningSum = 0;
  for (let i = 0; i < values.length; i++) {
    runningSum += values[i];
    if (i >= period) {
      runningSum -= values[i - period];
    }
    if (i >= period - 1) {
      result.push(runningSum / period);
    } else {
      result.push(null);
    }
  }
  return result;
}

// ── EMA ─────────────────────────────────────────────────────────

/**
 * Compute the Exponential Moving Average.
 *
 * EMA uses a multiplier: k = 2 / (period + 1).
 * The first EMA value is seeded with the SMA of the first `period` values.
 *
 * @returns The latest EMA value, or null if not enough data.
 */
export function ema(values: number[], period: number): number | null {
  if (period <= 0) throw new Error("EMA period must be positive");
  if (values.length < period) return null;

  const k = 2 / (period + 1);

  // Seed with SMA of first `period` values
  let seedSum = 0;
  for (let i = 0; i < period; i++) seedSum += values[i];
  let prevEma = seedSum / period;

  // Walk forward from index `period` to end
  for (let i = period; i < values.length; i++) {
    prevEma = values[i] * k + prevEma * (1 - k);
  }
  return prevEma;
}

/**
 * Compute EMA for every point in the series.
 * First `period - 1` entries are null.
 */
export function emaSeries(values: number[], period: number): (number | null)[] {
  if (period <= 0) throw new Error("EMA period must be positive");
  const result: (number | null)[] = [];
  const k = 2 / (period + 1);

  let prevEma: number | null = null;

  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) {
      result.push(null);
      continue;
    }

    if (prevEma === null) {
      // Seed with SMA
      let sum = 0;
      for (let j = i - period + 1; j <= i; j++) sum += values[j];
      prevEma = sum / period;
    } else {
      prevEma = values[i] * k + prevEma * (1 - k);
    }
    result.push(prevEma);
  }
  return result;
}

// ── RSI ─────────────────────────────────────────────────────────

/**
 * Compute the Relative Strength Index using Wilder's smoothing.
 *
 * RSI = 100 - 100 / (1 + RS)
 * RS = Average Gain / Average Loss over the period
 * Wilder's smoothing: avgGain = (prevAvgGain * (period - 1) + currentGain) / period
 *
 * @param values  Ordered series (oldest first), typically closing prices
 * @param period  Lookback window (conventionally 14)
 * @returns       RSI value [0, 100], or null if not enough data
 */
export function rsi(values: number[], period: number): number | null {
  if (period <= 0) throw new Error("RSI period must be positive");
  if (values.length < period + 1) return null;

  // Calculate initial price changes
  const changes: number[] = [];
  for (let i = 1; i < values.length; i++) {
    changes.push(values[i] - values[i - 1]);
  }

  // First average gain/loss over the first `period` changes
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 0; i < period; i++) {
    if (changes[i] > 0) avgGain += changes[i];
    else avgLoss += Math.abs(changes[i]);
  }
  avgGain /= period;
  avgLoss /= period;

  // Wilder's smoothing for remaining changes
  for (let i = period; i < changes.length; i++) {
    const gain = changes[i] > 0 ? changes[i] : 0;
    const loss = changes[i] < 0 ? Math.abs(changes[i]) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100; // all gains, no losses
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/**
 * Compute RSI for every point in the series.
 * First `period` entries are null (need period + 1 data points for first RSI).
 */
export function rsiSeries(values: number[], period: number): (number | null)[] {
  if (period <= 0) throw new Error("RSI period must be positive");
  const result: (number | null)[] = [];

  // Need at least period + 1 values for first RSI
  for (let i = 0; i < values.length; i++) {
    if (i < period) {
      result.push(null);
      continue;
    }

    // Slice up to current index and compute RSI
    const slice = values.slice(0, i + 1);
    const rsiVal = rsi(slice, period);
    result.push(rsiVal);
  }
  return result;
}

// ── Convenience: detect crossover signals ───────────────────────

export type Signal = "buy" | "sell" | "neutral";

/**
 * Detect SMA crossover signal: fast SMA crosses above/below slow SMA.
 * - "buy"  when fast SMA crosses above slow SMA (golden cross)
 * - "sell" when fast SMA crosses below slow SMA (death cross)
 * - "neutral" otherwise
 *
 * @param fastPeriod  e.g. 20
 * @param slowPeriod  e.g. 50
 * @param values      Ordered closing prices (oldest first)
 */
export function smaCrossover(values: number[], fastPeriod: number, slowPeriod: number): Signal {
  if (values.length < slowPeriod + 1) return "neutral";

  const fastNow = sma(values, fastPeriod);
  const slowNow = sma(values, slowPeriod);
  const fastPrev = sma(values.slice(0, -1), fastPeriod);
  const slowPrev = sma(values.slice(0, -1), slowPeriod);

  if (fastNow === null || slowNow === null || fastPrev === null || slowPrev === null) {
    return "neutral";
  }

  // Golden cross: fast crosses above slow
  if (fastPrev <= slowPrev && fastNow > slowNow) return "buy";
  // Death cross: fast crosses below slow
  if (fastPrev >= slowPrev && fastNow < slowNow) return "sell";

  return "neutral";
}

/**
 * RSI signal: oversold / overbought zones.
 * - "buy"    when RSI < 30 (oversold)
 * - "sell"   when RSI > 70 (overbought)
 * - "neutral" otherwise
 *
 * @param values     Ordered closing prices (oldest first)
 * @param period     RSI period (conventionally 14)
 * @param oversold   Threshold below which = buy signal (default 30)
 * @param overbought Threshold above which = sell signal (default 70)
 */
export function rsiSignal(
  values: number[],
  period: number,
  oversold: number = 30,
  overbought: number = 70,
): Signal {
  const rsiVal = rsi(values, period);
  if (rsiVal === null) return "neutral";
  if (rsiVal < oversold) return "buy";
  if (rsiVal > overbought) return "sell";
  return "neutral";
}
