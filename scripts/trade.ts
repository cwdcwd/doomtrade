/**
 * trade.ts — CLI for submitting a trading decision + executing the trade.
 *
 * Usage:
 *   npx tsx scripts/trade.ts --symbol AAPL --action buy --qty 10 \
 *     --rationale "Strong earnings" --confidence 8
 *
 * For crypto:
 *   npx tsx scripts/trade.ts --symbol BTC/USDT --action buy --qty 0.01 \
 *     --rationale "Bullish RSI divergence" --confidence 7
 *
 * Environment:
 *   DOOMTRADE_URL — base URL of the DoomTrade API (default: http://localhost:3000)
 */

const BASE_URL = process.env.DOOMTRADE_URL ?? "http://localhost:3000";

interface Args {
  symbol: string;
  action: "buy" | "sell" | "hold";
  qty: number;
  rationale: string;
  confidence: number;
  price?: number;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    return idx >= 0 ? args[idx + 1] : undefined;
  };

  const symbol = get("--symbol");
  const action = get("--action") as Args["action"] | undefined;
  const qty = get("--qty");
  const rationale = get("--rationale") ?? "";
  const confidence = get("--confidence");
  const price = get("--price");

  if (!symbol || !action || !qty) {
    console.error("Usage: trade.ts --symbol <SYM> --action <buy|sell|hold> --qty <N> [--rationale <text>] [--confidence <1-10>] [--price <N>]");
    process.exit(1);
  }

  return {
    symbol,
    action,
    qty: parseFloat(qty),
    rationale,
    confidence: confidence ? parseInt(confidence, 10) : 5,
    price: price ? parseFloat(price) : undefined,
  };
}

async function main() {
  const args = parseArgs();

  // Step 1: Create the decision
  console.log(`Creating decision: ${args.action} ${args.qty} ${args.symbol}`);
  const decResp = await fetch(`${BASE_URL}/api/decisions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      agent: process.env.AGENT_NAME ?? "doom",
      symbol: args.symbol,
      action: args.action,
      quantity: args.qty,
      priceAtDecision: args.price ?? 0,
      rationale: args.rationale,
      confidence: args.confidence,
      mode: "sim",
    }),
  });

  if (!decResp.ok) {
    const err = await decResp.json();
    console.error("Failed to create decision:", err);
    process.exit(1);
  }

  const decData = await decResp.json();
  const decisionId = decData.decision.id;
  console.log(`Decision created: ${decisionId}`);

  // Step 2: Execute the trade
  const tradeBody: Record<string, unknown> = {
    decisionId,
    orderType: "market",
  };
  if (args.price) {
    tradeBody.limitPrice = args.price;
  }

  const tradeResp = await fetch(`${BASE_URL}/api/trade`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(tradeBody),
  });

  const tradeData = await tradeResp.json();
  if (!tradeResp.ok) {
    console.error("Trade failed:", tradeData);
    process.exit(1);
  }

  console.log("\n=== Trade Result ===");
  console.log(`Risk checks: ${tradeData.riskPassed ? "PASSED" : "FAILED"}`);
  if (tradeData.riskChecks) {
    for (const check of tradeData.riskChecks) {
      console.log(`  ${check.passed ? "✓" : "✗"} ${check.check}${check.reason ? ": " + check.reason : ""}`);
    }
  }
  if (tradeData.orderResult) {
    const o = tradeData.orderResult;
    console.log(`\nOrder: ${o.side} ${o.quantity} ${o.symbol} @ ${o.fillPrice} (${o.status})`);
    console.log(`Fee: $${o.fee}`);
  }

  // Step 3: Show updated portfolio
  const portResp = await fetch(`${BASE_URL}/api/portfolio`);
  if (portResp.ok) {
    const port = await portResp.json();
    console.log(`\nPortfolio: equity=$${port.portfolio.equity.toFixed(2)} cash=$${port.portfolio.cash.toFixed(2)} positions=${port.portfolio.positionCount}`);
    if (port.portfolio.positions.length > 0) {
      console.log("Positions:");
      for (const p of port.portfolio.positions) {
        console.log(`  ${p.symbol}: ${p.quantity} @ ${p.avgEntryPrice} (P&L: ${p.unrealizedPnl})`);
      }
    }
  }
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});