/**
 * research.ts — CLI for researching a symbol before making a trading decision.
 *
 * Usage:
 *   npx tsx scripts/research.ts --symbol AAPL
 *   npx tsx scripts/research.ts --symbol BTC/USDT
 *   npx tsx scripts/research.ts --symbol AAPL --price 150  # manual price if no API keys
 *
 * Fetches:
 *   - Current price (via API or --price flag)
 *   - Recent bars for trend analysis (via API if available)
 *   - Computes simple technical indicators: SMA(20), SMA(50), RSI(14)
 *
 * Environment:
 *   DOOMTRADE_URL — base URL of the DoomTrade API (default: http://localhost:3000)
 */

const BASE_URL = process.env.DOOMTRADE_URL ?? "http://localhost:3000";

interface Args {
  symbol: string;
  price?: number;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    return idx >= 0 ? args[idx + 1] : undefined;
  };

  const symbol = get("--symbol");
  const price = get("--price");

  if (!symbol) {
    console.error("Usage: research.ts --symbol <SYM> [--price <N>]");
    process.exit(1);
  }

  return {
    symbol,
    price: price ? parseFloat(price) : undefined,
  };
}

// ── Technical Indicators ───────────────────────────────────────

function sma(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function rsi(closes: number[], period: number = 14): number | null {
  if (closes.length < period + 1) return null;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function formatMoney(n: number): string {
  return `$${n.toFixed(2)}`;
}

function formatSignal(value: number, threshold: number, aboveLabel: string, belowLabel: string): string {
  return value > threshold ? aboveLabel : value < -threshold ? belowLabel : "neutral";
}

// ── Main ───────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();
  console.log(`=== Research: ${args.symbol} ===\n`);

  let currentPrice: number | undefined = args.price;
  let priceSource = "manual";

  if (!currentPrice) {
    try {
      const resp = await fetch(`${BASE_URL}/api/market/quote/${encodeURIComponent(args.symbol)}`);
      if (resp.ok) {
        const data = await resp.json();
        currentPrice = data.quote.price;
        priceSource = "live";
      } else {
        console.log(`Could not fetch live price (API returned ${resp.status}). Use --price to specify manually.`);
      }
    } catch {
      console.log("Could not connect to API. Use --price to specify manually.");
    }
  }

  if (currentPrice) {
    console.log(`Current Price: ${formatMoney(currentPrice)} (${priceSource})`);
  }

  let bars: Array<{ close: number; timestamp: string; high: number; low: number; volume: number }> = [];
  try {
    const resp = await fetch(`${BASE_URL}/api/market/bars/${encodeURIComponent(args.symbol)}?timeframe=1Day&range=90d`);
    if (resp.ok) {
      const data = await resp.json();
      bars = data.bars ?? [];
    }
  } catch {
    // Bars not available
  }

  if (bars.length > 0) {
    console.log(`\nBars: ${bars.length} daily candles (last 90 days)`);

    const closes = bars.map((b) => b.close);
    const sma20 = sma(closes, 20);
    const sma50 = sma(closes, 50);
    const rsi14 = rsi(closes, 14);

    console.log("\n=== Technical Indicators ===");
    if (sma20) {
      console.log(`SMA(20): ${formatMoney(sma20)}`);
      if (currentPrice) {
        const diff = currentPrice - sma20;
        const pct = (diff / sma20) * 100;
        console.log(`  Price vs SMA20: ${diff > 0 ? "+" : ""}${formatMoney(diff)} (${pct.toFixed(2)}%) — ${formatSignal(pct, 1, "ABOVE (bullish)", "BELOW (bearish)")}`);
      }
    } else {
      console.log("SMA(20): insufficient data");
    }

    if (sma50) {
      console.log(`SMA(50): ${formatMoney(sma50)}`);
      if (currentPrice) {
        const diff = currentPrice - sma50;
        const pct = (diff / sma50) * 100;
        console.log(`  Price vs SMA50: ${diff > 0 ? "+" : ""}${formatMoney(diff)} (${pct.toFixed(2)}%) — ${formatSignal(pct, 1, "ABOVE (bullish)", "BELOW (bearish)")}`);
      }
    } else {
      console.log("SMA(50): insufficient data (need 50 bars)");
    }

    if (rsi14 !== null) {
      const rsiSignal = rsi14 > 70 ? "OVERBOUGHT" : rsi14 < 30 ? "OVERSOLD" : "neutral";
      console.log(`RSI(14): ${rsi14.toFixed(1)} — ${rsiSignal}`);
    } else {
      console.log("RSI(14): insufficient data (need 15 bars)");
    }

    if (bars.length >= 5) {
      const recent = bars.slice(-5);
      const trend = recent[recent.length - 1].close - recent[0].close;
      const trendPct = (trend / recent[0].close) * 100;
      console.log(`\n5-day trend: ${trend > 0 ? "+" : ""}${formatMoney(trend)} (${trendPct.toFixed(2)}%)`);

      const high = Math.max(...recent.map((b) => b.high));
      const low = Math.min(...recent.map((b) => b.low));
      console.log(`5-day range: ${formatMoney(low)} - ${formatMoney(high)}`);
    }

    if (bars.length > 0) {
      const high = Math.max(...bars.map((b) => b.high));
      const low = Math.min(...bars.map((b) => b.low));
      console.log(`\nPeriod high: ${formatMoney(high)}`);
      console.log(`Period low: ${formatMoney(low)}`);
    }
  } else {
    console.log("\nNo historical bars available (set API keys for technical analysis).");
  }

  console.log("\n=== Summary ===");
  if (currentPrice) {
    console.log(`Symbol: ${args.symbol}`);
    console.log(`Price: ${formatMoney(currentPrice)}`);
    console.log(`Source: ${priceSource}`);
    if (bars.length === 0) {
      console.log("Technical analysis: unavailable (no API keys)");
    }
    console.log(`\nTo trade: npx tsx scripts/trade.ts --symbol ${args.symbol} --action buy --qty 10 --price ${currentPrice} --rationale "Your rationale here"`);
  } else {
    console.log("No price available. Use --price to specify manually.");
  }
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
