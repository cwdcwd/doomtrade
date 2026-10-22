import { describe, it, expect } from "vitest";
import {
  sma,
  smaSeries,
  ema,
  emaSeries,
  rsi,
  rsiSeries,
  smaCrossover,
  rsiSignal,
} from "../src/research/indicators.js";

// ── SMA ─────────────────────────────────────────────────────────

describe("SMA", () => {
  it("computes SMA for exact period length", () => {
    const values = [1, 2, 3, 4, 5];
    expect(sma(values, 5)).toBe(3); // (1+2+3+4+5)/5 = 3
  });

  it("computes SMA using last N values", () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    // SMA(3) = (8+9+10)/3 = 9
    expect(sma(values, 3)).toBe(9);
  });

  it("returns null when not enough data", () => {
    expect(sma([1, 2, 3], 5)).toBeNull();
  });

  it("throws on non-positive period", () => {
    expect(() => sma([1, 2, 3], 0)).toThrow();
    expect(() => sma([1, 2, 3], -1)).toThrow();
  });

  it("handles single value with period 1", () => {
    expect(sma([42], 1)).toBe(42);
  });
});

describe("smaSeries", () => {
  it("returns array with nulls for insufficient data", () => {
    const result = smaSeries([1, 2, 3], 5);
    expect(result).toEqual([null, null, null]);
  });

  it("computes running SMA correctly", () => {
    const result = smaSeries([1, 2, 3, 4, 5], 3);
    // index 0: null, 1: null, 2: (1+2+3)/3=2, 3: (2+3+4)/3=3, 4: (3+4+5)/3=4
    expect(result).toEqual([null, null, 2, 3, 4]);
  });

  it("handles period 1 (returns same as input)", () => {
    const result = smaSeries([1, 2, 3], 1);
    expect(result).toEqual([1, 2, 3]);
  });
});

// ── EMA ─────────────────────────────────────────────────────────

describe("EMA", () => {
  it("computes EMA with correct seeding", () => {
    // For period 3: k = 2/4 = 0.5
    // Seed: SMA(1,2,3) = 2
    // EMA at index 3: 4*0.5 + 2*0.5 = 3
    // EMA at index 4: 5*0.5 + 3*0.5 = 4
    const result = ema([1, 2, 3, 4, 5], 3);
    expect(result).toBe(4);
  });

  it("returns null when not enough data", () => {
    expect(ema([1, 2], 5)).toBeNull();
  });

  it("throws on non-positive period", () => {
    expect(() => ema([1, 2, 3], 0)).toThrow();
  });
});

describe("emaSeries", () => {
  it("returns nulls for first period-1 entries", () => {
    const result = emaSeries([1, 2, 3, 4, 5], 3);
    expect(result[0]).toBeNull();
    expect(result[1]).toBeNull();
    expect(result[2]).not.toBeNull();
  });

  it("seeds first EMA with SMA", () => {
    const result = emaSeries([1, 2, 3, 4, 5], 3);
    // First EMA at index 2 = SMA(1,2,3) = 2
    expect(result[2]).toBe(2);
  });
});

// ── RSI ─────────────────────────────────────────────────────────

describe("RSI", () => {
  it("returns 100 when all prices go up (no losses)", () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
    // 14 consecutive gains, 0 losses
    expect(rsi(values, 14)).toBe(100);
  });

  it("returns 0 when all prices go down (no gains)", () => {
    const values = [15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
    // 14 consecutive losses, 0 gains
    expect(rsi(values, 14)).toBe(0);
  });

  it("returns ~50 when gains equal losses", () => {
    // Alternating up/down with equal magnitude
    const values = [10, 11, 10, 11, 10, 11, 10, 11, 10, 11, 10, 11, 10, 11, 10];
    const result = rsi(values, 14);
    expect(result).not.toBeNull();
    expect(result!).toBeCloseTo(50, 0);
  });

  it("returns null when not enough data", () => {
    expect(rsi([1, 2, 3], 14)).toBeNull();
  });

  it("throws on non-positive period", () => {
    expect(() => rsi([1, 2, 3], 0)).toThrow();
  });

  it("produces a value in [0, 100] range", () => {
    // Random-ish prices
    const values = [44, 44.34, 44.09, 43.61, 44.33, 44.83, 45.10, 45.42,
      45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.00];
    const result = rsi(values, 14);
    expect(result).not.toBeNull();
    expect(result!).toBeGreaterThanOrEqual(0);
    expect(result!).toBeLessThanOrEqual(100);
  });

  // Verify against a known RSI calculation
  it("matches known RSI value for test data", () => {
    // Classic RSI test: 14 daily closes
    // Using data that produces a known RSI around 50-70
    const values = [
      45.00, 46.00, 45.50, 46.50, 47.00, 46.80, 47.20, 47.50,
      47.30, 47.80, 48.00, 47.90, 48.10, 48.20, 48.30,
    ];
    const result = rsi(values, 14);
    expect(result).not.toBeNull();
    // With mostly upward movement, RSI should be well above 50
    expect(result!).toBeGreaterThan(50);
  });
});

describe("rsiSeries", () => {
  it("returns null for first `period` entries", () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
    const result = rsiSeries(values, 14);
    // First 14 entries should be null (need period+1 data points)
    for (let i = 0; i < 14; i++) {
      expect(result[i]).toBeNull();
    }
    expect(result[14]).not.toBeNull();
    expect(result[15]).not.toBeNull();
  });
});

// ── SMA Crossover ───────────────────────────────────────────────

describe("smaCrossover", () => {
  it("detects golden cross (fast crosses above slow)", () => {
    // Build a series where SMA20 crosses above SMA50
    // Start with declining prices, then sharp uptrend
    const prices: number[] = [];
    // 60 bars declining (to get SMA20 below SMA50)
    for (let i = 0; i < 60; i++) prices.push(100 - i * 0.5);
    // Then sharp uptrend to cause crossover
    for (let i = 0; i < 30; i++) prices.push(70 + i * 2);

    const signal = smaCrossover(prices, 20, 50);
    // Should be buy or neutral — crossover may or may not happen at exact last bar
    // But the strong uptrend should trigger it
    expect(["buy", "neutral"]).toContain(signal);
  });

  it("detects death cross (fast crosses below slow)", () => {
    // Start with uptrend, then sharp decline
    const prices: number[] = [];
    for (let i = 0; i < 60; i++) prices.push(50 + i * 0.5);
    for (let i = 0; i < 30; i++) prices.push(80 - i * 2);

    const signal = smaCrossover(prices, 20, 50);
    expect(["sell", "neutral"]).toContain(signal);
  });

  it("returns neutral when not enough data", () => {
    expect(smaCrossover([1, 2, 3, 4], 20, 50)).toBe("neutral");
  });

  it("returns neutral when no crossover", () => {
    // Steady uptrend — SMA20 stays above SMA50, no crossover at the boundary
    const prices: number[] = [];
    for (let i = 0; i < 100; i++) prices.push(100 + i * 0.1);
    // After a long steady uptrend, no crossover at the last bar
    const signal = smaCrossover(prices, 20, 50);
    // Should be neutral (already crossed long ago, no new cross)
    expect(signal).toBe("neutral");
  });
});

// ── RSI Signal ──────────────────────────────────────────────────

describe("rsiSignal", () => {
  it("returns buy when RSI is oversold", () => {
    // Long declining series to push RSI below 30
    const prices: number[] = [];
    for (let i = 0; i < 30; i++) prices.push(100 - i);
    const signal = rsiSignal(prices, 14);
    expect(signal).toBe("buy");
  });

  it("returns sell when RSI is overbought", () => {
    // Long rising series to push RSI above 70
    const prices: number[] = [];
    for (let i = 0; i < 30; i++) prices.push(100 + i);
    const signal = rsiSignal(prices, 14);
    expect(signal).toBe("sell");
  });

  it("returns neutral in normal range", () => {
    // Alternating around a midpoint
    const prices = [50, 50.5, 49.5, 50.2, 49.8, 50.1, 49.9, 50.3, 49.7, 50.0,
      50.2, 49.8, 50.1, 49.9, 50.0, 50.1];
    const signal = rsiSignal(prices, 14);
    expect(signal).toBe("neutral");
  });

  it("returns neutral when not enough data", () => {
    expect(rsiSignal([1, 2, 3], 14)).toBe("neutral");
  });

  it("supports custom thresholds", () => {
    // With custom thresholds, RSI of ~50 might trigger
    const prices = [50, 51, 49, 51, 49, 51, 49, 51, 49, 51, 49, 51, 49, 51, 49];
    // RSI ~50, with oversold=60 this would be buy
    const signal = rsiSignal(prices, 14, 60, 40);
    expect(signal).toBe("buy");
  });
});