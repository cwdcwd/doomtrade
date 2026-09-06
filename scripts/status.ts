/**
 * status.ts — CLI for fetching current portfolio, positions, and decisions.
 *
 * Usage:
 *   npx tsx scripts/status.ts              # show everything
 *   npx tsx scripts/status.ts --portfolio  # just portfolio
 *   npx tsx scripts/status.ts --decisions  # just recent decisions
 *   npx tsx scripts/status.ts --positions  # just open positions
 *
 * Environment:
 *   DOOMTRADE_URL — base URL of the DoomTrade API (default: http://localhost:3000)
 */

const BASE_URL = process.env.DOOMTRADE_URL ?? "http://localhost:3000";

async function fetchJson(path: string): Promise<Record<string, unknown>> {
  const resp = await fetch(`${BASE_URL}${path}`);
  if (!resp.ok) {
    console.error(`GET ${path} failed: ${resp.status}`);
    return {};
  }
  return resp.json();
}

function formatMoney(n: number): string {
  return `$${n.toFixed(2)}`;
}

async function showPortfolio() {
  const data = await fetchJson("/api/portfolio") as { portfolio?: Record<string, unknown>; pnl?: Record<string, number>; mode?: string };
  if (!data.portfolio) return;

  const p = data.portfolio as {
    equity: number; cash: number; positionsValue: number;
    positionCount: number; exposurePct: number; positions: Array<{
      symbol: string; quantity: number; avgEntryPrice: number;
      unrealizedPnl: number; marketValue: number;
    }>;
  };
  const pnl = data.pnl as { unrealized: number; realized: number; total: number; totalPct: number };

  console.log("=== Portfolio ===");
  console.log(`Mode: ${data.mode}`);
  console.log(`Equity: ${formatMoney(p.equity)}`);
  console.log(`Cash: ${formatMoney(p.cash)}`);
  console.log(`Positions Value: ${formatMoney(p.positionsValue)}`);
  console.log(`Exposure: ${p.exposurePct.toFixed(2)}%`);
  console.log(`Open Positions: ${p.positionCount}`);
  console.log(`\nP&L:`);
  console.log(`  Unrealized: ${formatMoney(pnl.unrealized)}`);
  console.log(`  Realized: ${formatMoney(pnl.realized)}`);
  console.log(`  Total: ${formatMoney(pnl.total)} (${pnl.totalPct.toFixed(2)}%)`);

  if (p.positions.length > 0) {
    console.log(`\nPositions:`);
    for (const pos of p.positions) {
      const pnlStr = pos.unrealizedPnl >= 0 ? `+${formatMoney(pos.unrealizedPnl)}` : formatMoney(pos.unrealizedPnl);
      console.log(`  ${pos.symbol}: ${pos.quantity} @ ${formatMoney(pos.avgEntryPrice)} | MV: ${formatMoney(pos.marketValue)} | P&L: ${pnlStr}`);
    }
  }
}

async function showDecisions() {
  const data = await fetchJson("/api/decisions?limit=10") as {
    decisions: Array<{
      id: string; timestamp: string; agent: string; symbol: string;
      action: string; quantity: number; priceAtDecision: number;
      rationale: string; confidence: number; mode: string;
    }>;
    count: number;
  };

  console.log("=== Recent Decisions ===");
  if (!data.decisions || data.decisions.length === 0) {
    console.log("No decisions yet.");
    return;
  }

  for (const d of data.decisions) {
    const time = new Date(d.timestamp).toLocaleString();
    console.log(`  [${time}] ${d.agent} ${d.action.toUpperCase()} ${d.quantity} ${d.symbol} @ ${formatMoney(d.priceAtDecision)} (conf: ${d.confidence}/10) [${d.mode}]`);
    if (d.rationale) console.log(`    → ${d.rationale}`);
  }
}

async function showPositions() {
  const data = await fetchJson("/api/positions") as {
    positions: Array<{
      symbol: string; quantity: number; avgEntryPrice: number;
      side: string; unrealizedPnl: number; marketValue: number;
    }>;
    count: number;
  };

  console.log("=== Open Positions ===");
  if (!data.positions || data.positions.length === 0) {
    console.log("No open positions.");
    return;
  }

  for (const p of data.positions) {
    const pnlStr = p.unrealizedPnl >= 0 ? `+${formatMoney(p.unrealizedPnl)}` : formatMoney(p.unrealizedPnl);
    console.log(`  ${p.symbol} (${p.side}): ${p.quantity} @ ${formatMoney(p.avgEntryPrice)} | MV: ${formatMoney(p.marketValue)} | P&L: ${pnlStr}`);
  }
}

async function main() {
  const filter = process.argv[2];

  if (filter === "--portfolio") {
    await showPortfolio();
  } else if (filter === "--decisions") {
    await showDecisions();
  } else if (filter === "--positions") {
    await showPositions();
  } else {
    await showPortfolio();
    console.log();
    await showPositions();
    console.log();
    await showDecisions();
  }
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});