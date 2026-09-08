/**
 * history.ts — CLI for trade history and performance analytics.
 *
 * Usage:
 *   npx tsx scripts/history.ts                          # show trade history + analytics
 *   npx tsx scripts/history.ts --symbol AAPL            # filter by symbol
 *   npx tsx scripts/history.ts --limit 50               # limit number of trades
 *   npx tsx scripts/history.ts --start 2026-09-01       # date range start (ISO)
 *   npx tsx scripts/history.ts --end 2026-09-30         # date range end (ISO)
 *   npx tsx scripts/history.ts --analytics              # show only analytics summary
 *   npx tsx scripts/history.ts --equity                 # show equity curve
 *
 * Environment:
 *   DOOMTRADE_URL — base URL of the DoomTrade API (default: http://localhost:3000)
 */

const BASE_URL = process.env.DOOMTRADE_URL ?? "http://localhost:3000";

interface Args {
  symbol?: string;
  limit: number;
  startDate?: string;
  endDate?: string;
  analyticsOnly: boolean;
  equityCurve: boolean;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    return idx >= 0 ? args[idx + 1] : undefined;
  };

  return {
    symbol: get("--symbol"),
    limit: get("--limit") ? parseInt(get("--limit")!, 10) : 100,
    startDate: get("--start"),
    endDate: get("--end"),
    analyticsOnly: args.includes("--analytics"),
    equityCurve: args.includes("--equity"),
  };
}

async function fetchJson(path: string): Promise<Record<string, unknown>> {
  const resp = await fetch(`${BASE_URL}${path}`);
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    console.error(`GET ${path} failed: ${resp.status} ${text}`);
    process.exit(1);
  }
  return resp.json() as Promise<Record<string, unknown>>;
}

function buildQueryString(args: Args, extra?: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  if (args.symbol) params.set("symbol", args.symbol);
  if (args.startDate) params.set("startDate", args.startDate);
  if (args.endDate) params.set("endDate", args.endDate);
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      if (v !== undefined) params.set(k, v);
    }
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

function formatMoney(n: number): string {
  return `$${n.toFixed(2)}`;
}

function formatPct(n: number): string {
  return `${n.toFixed(2)}%`;
}

async function showAnalytics(args: Args): Promise<void> {
  const qs = buildQueryString(args);
  const data = await fetchJson(`/api/trades/analytics${qs}`);
  const a = data.analytics as {
    totalTrades: number;
    wins: number;
    losses: number;
    winRate: number;
    avgReturn: number;
    totalPnl: number;
    sharpeRatio: number;
    maxDrawdownPct: number;
  };

  console.log("\n=== Performance Analytics ===");
  console.log(`Total Trades:  ${a.totalTrades}`);
  console.log(`Wins:          ${a.wins}`);
  console.log(`Losses:        ${a.losses}`);
  console.log(`Win Rate:      ${formatPct(a.winRate * 100)}`);
  console.log(`Avg Return:    ${formatMoney(a.avgReturn)}`);
  console.log(`Total P&L:     ${formatMoney(a.totalPnl)}`);
  console.log(`Sharpe Ratio:  ${a.sharpeRatio.toFixed(3)}`);
  console.log(`Max Drawdown:  ${formatPct(a.maxDrawdownPct)}`);
}

async function showTradeHistory(args: Args): Promise<void> {
  const qs = buildQueryString(args, { limit: String(args.limit) });
  const data = await fetchJson(`/api/trades${qs}`);
  const trades = data.trades as Array<{
    id: string;
    symbol: string;
    side: string;
    quantity: number;
    fillPrice: number | null;
    status: string;
    fee: number;
    realizedPnl: number;
    timestamp: string;
  }>;

  console.log("\n=== Trade History ===");
  console.log(`Total: ${data.count} trades${args.symbol ? ` for ${args.symbol}` : ""}\n`);

  if (trades.length === 0) {
    console.log("No trades found.");
    return;
  }

  // Table header
  const header = `${"Timestamp".padEnd(26)} ${"Symbol".padEnd(10)} ${"Side".padEnd(6)} ${"Qty".padStart(10)} ${"Fill Price".padStart(12)} ${"P&L".padStart(12)} ${"Status".padEnd(10)}`;
  console.log(header);
  console.log("-".repeat(header.length));

  for (const t of trades) {
    const ts = t.timestamp.slice(0, 23);
    const pnl = t.realizedPnl !== 0 ? formatMoney(t.realizedPnl) : "-";
    console.log(
      `${ts.padEnd(26)} ${t.symbol.padEnd(10)} ${t.side.padEnd(6)} ${String(t.quantity).padStart(10)} ${(t.fillPrice ? formatMoney(t.fillPrice) : "-").padStart(12)} ${pnl.padStart(12)} ${t.status.padEnd(10)}`,
    );
  }
}

async function showEquityCurve(args: Args): Promise<void> {
  const qs = buildQueryString(args, { limit: "1000" });
  const data = await fetchJson(`/api/portfolio/history${qs}`);
  const history = data.history as Array<{
    timestamp: string;
    equity: number;
    cash: number;
    positionsValue: number;
    unrealizedPnl: number;
    realizedPnl: number;
  }>;

  console.log("\n=== Equity Curve ===");
  console.log(`Total points: ${data.count}\n`);

  if (history.length === 0) {
    console.log("No portfolio history found.");
    return;
  }

  const header = `${"Timestamp".padEnd(26)} ${"Equity".padStart(14)} ${"Cash".padStart(14)} ${"Positions".padStart(14)} ${"Unrealized P&L".padStart(16)} ${"Realized P&L".padStart(14)}`;
  console.log(header);
  console.log("-".repeat(header.length));

  for (const h of history) {
    const ts = h.timestamp.slice(0, 23);
    console.log(
      `${ts.padEnd(26)} ${formatMoney(h.equity).padStart(14)} ${formatMoney(h.cash).padStart(14)} ${formatMoney(h.positionsValue).padStart(14)} ${formatMoney(h.unrealizedPnl).padStart(16)} ${formatMoney(h.realizedPnl).padStart(14)}`,
    );
  }

  // Summary
  const first = history[0];
  const last = history[history.length - 1];
  const totalReturn = last.equity - first.equity;
  const totalReturnPct = first.equity > 0 ? (totalReturn / first.equity) * 100 : 0;
  console.log(`\nTotal Return: ${formatMoney(totalReturn)} (${formatPct(totalReturnPct)})`);
}

async function main() {
  const args = parseArgs();

  console.log(`DoomTrade — Trade History & Analytics`);
  console.log(`API: ${BASE_URL}`);

  if (args.equityCurve) {
    await showEquityCurve(args);
  } else if (args.analyticsOnly) {
    await showAnalytics(args);
  } else {
    await showTradeHistory(args);
    await showAnalytics(args);
  }
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});