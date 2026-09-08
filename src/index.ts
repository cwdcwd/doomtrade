/**
 * index.ts — Entry point. Starts the Express server with all API routes.
 *
 * DoomTrade is an agent-managed trading platform. This file boots the
 * server, initializes the database, executors, and trade engine,
 * and mounts the API routes.
 */

import express from "express";
import { loadConfig } from "./config.js";
import { openDatabase, persistDatabase, closeDatabase } from "./db/database.js";
import { DecisionStore } from "./decision/decision-store.js";
import { SimulatedExchange } from "./executor/simulated.js";
import { apiKeyAuth } from "./api/auth.js";
import { TradeEngine } from "./engine/trade-engine.js";
import { Portfolio } from "./portfolio/portfolio.js";
import { createApiRouter } from "./api/routes.js";
import { createPublicCryptoMarketData, createMarketDataService } from "./market/market.js";
import { ResearchService } from "./research/research.js";
import { ThemeRunner } from "./themes/theme-runner.js";
import { CongressFollowerStrategy } from "./themes/strategies/congress-follower.js";
import { MomentumRotationStrategy } from "./themes/strategies/momentum-rotation.js";
import { AgentDrivenStrategy } from "./themes/strategies/agent-driven.js";
import type { Executor } from "./executor/executor.js";
import type { PriceProvider } from "./engine/trade-engine.js";

/**
 * Instantiate the appropriate executor based on trade mode.
 *
 * SIM mode  → SimulatedExchange (always available, no external deps)
 * LIVE mode → AlpacaExecutor (stocks) + CCXTExecutor (crypto)
 *
 * Live executors are imported dynamically so the Alpaca SDK and CCXT
 * packages are only required when live mode is actually used. If the
 * package is missing, a clear error is thrown at startup.
 */
async function createExecutor(
  config: ReturnType<typeof loadConfig>,
  db: Awaited<ReturnType<typeof openDatabase>>,
): Promise<Executor> {
  if (config.tradeMode === "live") {
    const { AlpacaExecutor } = await import("./executor/alpaca.js");
    const { CCXTExecutor } = await import("./executor/ccxt.js");

    const alpaca = new AlpacaExecutor({
      keyId: config.alpacaKeyId,
      secretKey: config.alpacaSecretKey,
      paper: config.alpacaPaper,
    });
    const ccxt = new CCXTExecutor({
      exchange: config.ccxtExchange,
      apiKey: config.ccxtApiKey,
      apiSecret: config.ccxtApiSecret,
    });

    // For now, route everything through Alpaca for stocks.
    // CCXT handles crypto. A composite executor can be built later.
    // Return Alpaca as primary; CCXT is available for crypto symbols.
    void ccxt; // CCXT instantiated and ready — will be wired into a composite executor
    return alpaca;
  }

  return new SimulatedExchange(db, {
    initialCash: config.simStartingBalance,
    feeRate: config.simFeePct / 100,
  });
}

async function main() {
  const config = loadConfig();

  // Initialize database — Postgres if DATABASE_URL is set, SQLite otherwise
  const db = await openDatabase({ path: config.databasePath, url: config.databaseUrl });

  // Initialize executor (sim or live based on mode)
  const executor = await createExecutor(config, db);

  // Initialize services
  const portfolio = new Portfolio(db, executor, {
    mode: config.tradeMode,
    initialCapital: config.simStartingBalance,
  });

  // Market data: in sim mode, use public CCXT for crypto (no API keys needed).
  // In live mode, use full routing (Alpaca for stocks, CCXT for crypto).
  const marketData = config.tradeMode === "live"
    ? createMarketDataService({
        alpacaKeyId: config.alpacaKeyId,
        alpacaSecretKey: config.alpacaSecretKey,
        alpacaPaper: config.alpacaPaper,
        ccxtExchange: config.ccxtExchange,
        ccxtApiKey: config.ccxtApiKey,
        ccxtApiSecret: config.ccxtApiSecret,
      })
    : createPublicCryptoMarketData(config.ccxtExchange);

  // Research service for technical analysis (SMA, RSI)
  const research = new ResearchService(marketData);

  // Price provider wraps the market data service for the trade engine
  const priceProvider: PriceProvider = {
    async getQuote(symbol: string): Promise<number> {
      const quote = await marketData.getQuote(symbol);
      return quote.price;
    },
  };

  // Initialize services
  const decisionStore = new DecisionStore(db);
  const tradeEngine = new TradeEngine(db, executor, config, priceProvider);

  // Theme runner for experimental strategies
  const themeRunner = new ThemeRunner(db, {
    decisionStore,
    tradeEngine,
    portfolio,
    marketData,
    redisUrl: config.redisUrl,
    simFeeRate: config.simFeePct / 100,
  });

  // Start all enabled themes on boot
  await themeRunner.startAll();

  // Register built-in strategies
  themeRunner.registerStrategy(new CongressFollowerStrategy());

  // App state (mutable for mode toggle)
  const state = {
    decisionStore,
    tradeEngine,
    portfolio,
    config,
    currentMode: config.tradeMode as "sim" | "live",
    modeChangedAt: Date.now(),
    marketData,
    research,
    themeRunner,
  };

  const app = express();

  // Middleware
  app.use(express.json());

  // API authentication — protects all /api routes except /api/health
  // If DOOMTRADE_API_KEY is not set, auth is disabled (local dev only)
  const authMiddleware = apiKeyAuth(config.apiKey);
  app.use("/api", (req, res, next) => {
    if (req.path === "/health") return next();
    authMiddleware(req, res, next);
  });

  // Serve dashboard static files
  app.use(express.static("public"));

  // Health check — used by Railway for deployment healthchecks
  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      mode: state.currentMode,
      db: db.backend,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    });
  });

  // API routes
  app.use("/api", createApiRouter(state));

  app.listen(config.port, () => {
    console.log(`DoomTrade running on port ${config.port}`);
    console.log(`Mode: ${state.currentMode.toUpperCase()}`);
    console.log(`Database: ${config.databasePath}`);
    if (state.currentMode === "live") {
      console.log("⚠️  LIVE TRADING MODE — real orders will be placed");
    } else {
      console.log(
        "Sim mode — paper trading with $" +
          config.simStartingBalance.toLocaleString() +
          " virtual balance",
      );
    }
  });

  // Persist database on shutdown
  process.on("SIGINT", () => {
    if (config.databaseUrl) {
      closeDatabase(db);
    } else if (config.databasePath !== ":memory:") {
      persistDatabase(db, config.databasePath);
    }
    console.log("\nShutting down...");
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    if (themeRunner) themeRunner.stopAll();
    if (config.databaseUrl) {
      closeDatabase(db);
    } else if (config.databasePath !== ":memory:") {
      persistDatabase(db, config.databasePath);
    }
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Failed to start DoomTrade:", err);
  process.exit(1);
});
