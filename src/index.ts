/**
 * index.ts — Entry point. Starts the Express server with all API routes.
 */

import express from "express";
import { loadConfig } from "./config.js";
import { openDatabase, persistDatabase } from "./db/database.js";
import { DecisionStore } from "./decision/decision-store.js";
import { SimulatedExchange } from "./executor/simulated.js";
import { TradeEngine } from "./engine/trade-engine.js";
import { Portfolio } from "./portfolio/portfolio.js";
import { createApiRouter } from "./api/routes.js";
import type { Executor } from "./executor/executor.js";
import { createMarketDataService } from "./market/market.js";
import type { PriceProvider } from "./engine/trade-engine.js";

async function createExecutor(
  config: ReturnType<typeof loadConfig>,
  db: Awaited<ReturnType<typeof openDatabase>>,
): Promise<Executor> {
  if (config.tradeMode === "live") {
    const { AlpacaExecutor } = await import("./executor/alpaca.js");
    const { CCXTExecutor } = await import("./executor/ccxt.js");
    const alpaca = new AlpacaExecutor({ keyId: config.alpacaKeyId, secretKey: config.alpacaSecretKey, paper: config.alpacaPaper });
    const ccxt = new CCXTExecutor({ exchange: config.ccxtExchange, apiKey: config.ccxtApiKey, apiSecret: config.ccxtApiSecret });
    void ccxt;
    return alpaca;
  }
  return new SimulatedExchange(db, { initialCash: config.simStartingBalance, feeRate: config.simFeePct / 100 });
}

async function main() {
  const config = loadConfig();
  const db = await openDatabase({ path: config.databasePath });
  const executor = await createExecutor(config, db);

  // Initialize market data service for price fetching
  const marketData = createMarketDataService({
    alpacaKeyId: config.alpacaKeyId,
    alpacaSecretKey: config.alpacaSecretKey,
    alpacaPaper: config.alpacaPaper,
    ccxtExchange: config.ccxtExchange,
    ccxtApiKey: config.ccxtApiKey,
    ccxtApiSecret: config.ccxtApiSecret,
  });

  // Price provider wraps the market data service for the trade engine
  const priceProvider: PriceProvider = {
    async getQuote(symbol: string): Promise<number> {
      const quote = await marketData.getQuote(symbol);
      return quote.price;
    },
  };

  const decisionStore = new DecisionStore(db);
  const tradeEngine = new TradeEngine(db, executor, config, priceProvider);
  const portfolio = new Portfolio(db, executor, { mode: config.tradeMode, initialCapital: config.simStartingBalance });

  const state = { decisionStore, tradeEngine, portfolio, config, currentMode: config.tradeMode as "sim" | "live", modeChangedAt: Date.now() };

  const app = express();
  app.use(express.json());
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", mode: state.currentMode, timestamp: new Date().toISOString(), uptime: process.uptime() });
  });
  app.use("/api", createApiRouter(state));

  app.listen(config.port, () => {
    console.log(`DoomTrade running on port ${config.port}`);
    console.log(`Mode: ${state.currentMode.toUpperCase()}`);
    if (state.currentMode === "live") console.log("⚠️  LIVE TRADING MODE — real orders will be placed");
    else console.log("Sim mode — paper trading with $" + config.simStartingBalance.toLocaleString() + " virtual balance");
  });

  process.on("SIGINT", () => { if (config.databasePath !== ":memory:") persistDatabase(db, config.databasePath); process.exit(0); });
  process.on("SIGTERM", () => { if (config.databasePath !== ":memory:") persistDatabase(db, config.databasePath); process.exit(0); });
}

main().catch((err) => { console.error("Failed to start DoomTrade:", err); process.exit(1); });
