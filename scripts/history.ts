/**
 * history.ts — CLI for reviewing trade history and performance analytics.
 *
 * Usage:
 *   npx tsx scripts/history.ts                          # full history + analytics
 *   npx tsx scripts/history.ts --symbol BTC/USDT        # filter by symbol
 *   npx tsx scripts/history.ts --limit 20               # limit trades shown
 *   npx tsx scripts/history.ts --start 2026-09-01       # date range start
 *   npx tsx scripts/history.ts --end 2026-09-06         # date range end
 *   npx tsx scripts/history.ts --trades-only            # just trades table
 *   npx tsx scripts/history.ts --analytics-only         # just performance analytics
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
  tradesOnly: boolean;
  analyticsOnly: boolean;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    return idx >= 0 ? args[idx + 1] : undefined;
  };

  const symbol = get("--symbol");
  const limitStr = get("--limit");
  const startDate = get("--start");
  const endDate = get("--end");
  const tradesOnly = args.includes("--trades-only");
  const analyticsOnly = args.includes("--analytics-only");

  return {
    symbol,
    limit: limitStr ? parseInt(limitStr, 10) : 100,
    startDate,
    endDate,
    tradesOnly,
    analyticsOnly,
  };
}

function formatMoney(n: number): string {
  const sign = n >= 0 ? "+" : "";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

function formatPlainMoney(n: number): string {
  return `$${n.toFixed(2)}`;
}

interface TradeRow {
  id: string;
  timestamp: string;
  symbol: string;
  side: string;
  quantity: number;
  orderType: string;
  fillPrice: number | null;
  status: string;
  fee: number;
  realizedPnl: number;
  mode: string;
  executor: string;
}

interface AnalyticsData {
  tradeCount: number;
  filledCount: number;
  pendingCount: number;
  rejectedCount: number;
  cancelledCount: number;
  winLoss: {
    wins: number;
    losses: number;
    breakeven: number;
    totalClosed: number;
    winRate: number;
  };
  pnl: {
    totalRealized: number;
    totalFees: number;
    netPnl: number;
    grossProfit: number;
    grossLoss: number;
    avgWin: number;
    avgLoss: number;
    profitFactor: number;
  };
  equity: {
    startEquity: number;
    endEquity: number;
    maxEquity: number;
    minEquity: number;
    drawdownPct: number;
  };
}

async function fetchTrades(args: Args): Promise<void> {
  const params = new URLSearchParams();
  if (args.symbol) params.set("symbol", args.symbol);
  if (args.startDate) params.set("startDate", args.startDate);
  if (args.endDate) params.set("endDate", args.endDate);
  params.set("limit", String(args.limit));

  const url = `${BASE_URL}/api/trades?${params.toString()}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    console.error(`GET /api/trades failed: ${resp.status}`);
    return;
  }

  const data = await resp.json() as { trades: TradeRow[]; count: number; mode: string };
  const trades = data.trades ?? [];

  console.log("=== Trade History ===");
  console.log(`Mode: ${data.mode}`);
  console.log(`Total: ${data.count} trades (showing ${trades.length})`);

  if (args.symbol) console.log(`Filter: symbol=${args.symbol}`);
  if (args.startDate || args.endDate) {
    console.log(`Date range: ${args.startDate ?? "beginning"} → ${args.endDate ?? "now"}`);
  }

  if (trades.length === 0) {
    console.log("\nNo trades found.");
    return;
  }

  // Table header
  console.log("");
  const fmt = (s: string, w: number) => s.length > w ? s.slice(0, w - 1) + "…" : s.padEnd(w);
  console.log(
    `  ${fmt("Date", 20)}  ${fmt("Symbol", 12)}  ${fmt("Side", 5)}  ${fmt("Qty", 10)}  ${fmt("Fill Price", 12)}  ${fmt("Fee", 10)}  ${fmt("P&L", 12)}  ${fmt("Status", 10)}  ${fmt("Executor", 10)}`,
  );
  console.log(`  ${"─".repeat(103)}`);

  for (const t of trades) {
    const date = new Date(t.timestamp).toLocaleString();
    const pnlStr = t.realizedPnl !== 0 ? formatMoney(t.realizedPnl) : "—";
    const fillStr = t.fillPrice !== null ? formatPlainMoney(t.fillPrice) : "—";
    const feeStr = t.fee > 0 ? formatPlainMoney(t.fee) : "—";
    console.log(
      `  ${fmt(date, 20)}  ${fmt(t.symbol, 12)}  ${fmt(t.side.toUpperCase(), 5)}  ${fmt(String(t.quantity), 10)}  ${fmt(fillStr, 12)}  ${fmt(feeStr, 10)}  ${fmt(pnlStr, 12)}  ${fmt(t.status, 10)}  ${fmt(t.executor, 10)}`,
    );
  }
}

async function fetchAnalytics(args: Args): Promise<void> {
  const params = new URLSearchParams();
  if (args.symbol) params.set("symbol", args.symbol);
  if (args.startDate) params.set("startDate", args.startDate);
  if (args.endDate) params.set("endDate", args.endDate);

  const url = `${BASE_URL}/api/trades/analytics?${params.toString()}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    console.error(`GET /api/trades/analytics failed: ${resp.status}`);
    return;
  }

  const data = await resp.json() as { analytics: AnalyticsData; mode: string };
  const a = data.analytics;

  console.log("\n=== Performance Analytics ===");
  console.log(`Mode: ${data.mode}`);

  // Trade counts
  console.log("\n— Trade Counts —");
  console.log(`  Total trades:    ${a.tradeCount}`);
  console.log(`  Filled:          ${a.filledCount}`);
  console.log(`  Pending:         ${a.pendingCount}`);
  console.log(`  Rejected:        ${a.rejectedCount}`);
  console.log(`  Cancelled:       ${a.cancelledCount}`);

  // Win/Loss
  console.log("\n— Win/Loss —");
  const totalClosed = a.winLoss.totalClosed;
  if (totalClosed > 0) {
    console.log(`  Wins:            ${a.winLoss.wins}`);
    console.log(`  Losses:          ${a.winLoss.losses}`);
    console.log(`  Breakeven:       ${a.winLoss.breakeven}`);
    console.log(`  Win rate:        ${a.winLoss.winRate.toFixed(1)}%`);
  } else {
    console.log("  No closed trades with realized P&L yet.");
  }

  // P&L
  console.log("\n— P&L —");
  console.log(`  Gross profit:    ${formatPlainMoney(a.pnl.grossProfit)}`);
  console.log(`  Gross loss:      ${formatPlainMoney(Math.abs(a.pnl.grossLoss))}`);
  console.log(`  Total realized:  ${formatMoney(a.pnl.totalRealized)}`);
  console.log(`  Total fees:      ${formatPlainMoney(a.pnl.totalFees)}`);
  console.log(`  Net P&L:         ${formatMoney(a.pnl.netPnl)}`);
  if (a.pnl.avgWin > 0) console.log(`  Avg win:         ${formatPlainMoney(a.pnl.avgWin)}`);
  if (a.pnl.avgLoss < 0) console.log(`  Avg loss:        ${formatPlainMoney(Math.abs(a.pnl.avgLoss))}`);
  const pfStr = a.pnl.profitFactor === Infinity ? "∞" : a.pnl.profitFactor.toFixed(2);
  console.log(`  Profit factor:   ${pfStr}`);

  // Equity curve
  console.log("\n— Equity Curve —");
  if (a.equity.startEquity > 0 || a.equity.endEquity > 0) {
    console.log(`  Start equity:    ${formatPlainMoney(a.equity.startEquity)}`);
    console.log(`  Current equity:  ${formatPlainMoney(a.equity.endEquity)}`);
    console.log(`  Max equity:      ${formatPlainMoney(a.equity.maxEquity)}`);
    console.log(`  Min equity:      ${formatPlainMoney(a.equity.minEquity)}`);
    console.log(`  Max drawdown:    ${a.equity.drawdownPct.toFixed(2)}%`);
    const totalReturn = a.equity.startEquity > 0
      ? ((a.equity.endEquity - a.equity.startEquity) / a.equity.startEquity) * 100
      : 0;
    console.log(`  Total return:    ${formatMoney(totalReturn)}%`);
  } else {
    console.log("  No equity history yet (no portfolio checkpoints recorded).");
  }
}

async function main() {
  const args = parseArgs();

  if (args.analyticsOnly) {
    await fetchAnalytics(args);
  } else if (args.tradesOnly) {
    await fetchTrades(args);
  } else {
    await fetchTrades(args);
    await fetchAnalytics(args);
  }
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});