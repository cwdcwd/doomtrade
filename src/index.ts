/**
 * index.ts — Entry point. Starts the Express server with all API routes.
 *
 * DoomTrade is an agent-managed trading platform. This file boots the
 * server, initializes the database, executors, and trade engine,
 * and mounts the API routes.
 */

import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { openDatabase, persistDatabase, closeDatabase } from "./db/database.js";
import { DecisionStore } from "./decision/decision-store.js";
import { SimulatedExchange } from "./executor/simulated.js";
import { authGate } from "./api/auth.js";
import { TradeEngine } from "./engine/trade-engine.js";
import { Portfolio } from "./portfolio/portfolio.js";
import { createApiRouter } from "./api/routes.js";
import { createPublicCryptoMarketData, createMarketDataService } from "./market/market.js";
import { PriceCache } from "./market/stock-price-cache.js";
import { ResearchService } from "./research/research.js";
import { ThemeRunner } from "./themes/theme-runner.js";
import { CongressFollowerStrategy } from "./themes/strategies/congress-follower.js";
import { MomentumRotationStrategy } from "./themes/strategies/momentum-rotation.js";
import { AgentDrivenStrategy } from "./themes/strategies/agent-driven.js";
import { AgentManager } from "./agent/agent-manager.js";
import { AgentTradeEngine } from "./engine/agent-trade-engine.js";
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
    // CCXTExecutor import removed — not yet wired. See beads doomtrade-78e.4.

    const alpaca = new AlpacaExecutor({
      keyId: config.alpacaKeyId,
      secretKey: config.alpacaSecretKey,
      paper: config.alpacaPaper,
    });
    // CCXT executor for crypto symbols is not yet wired.
    // A composite executor (stocks→Alpaca, crypto→CCXT) can be built later.
    // See beads issue doomtrade-78e.4 for tracking.
    return alpaca;
  }

  return new SimulatedExchange(db, {
    initialCash: config.simStartingBalance,
    feeRate: config.simFeePct / 100,
    getCurrentPrice: (symbol: string) => {
      // Synchronous fallback — the TradeEngine passes a limitPrice on market
      // orders (from the price provider), which resolvePrice uses as fallback.
      // This cache is updated on every fill, so it's the last traded price.
      return null;
    },
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
  const marketData =
    config.tradeMode === "live"
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

  // Background price cache — refreshes quotes for all open positions (and
  // the default universe) every 60s. Powers the agents' synchronous
  // getCurrentPrice so equity/PnL mark to market instead of entry price.
  const priceCache = new PriceCache({
    db,
    marketData,
    intervalMs: 60_000,
    watchSymbols: [
      "BTC/USDT",
      "ETH/USDT",
      "SOL/USDT",
      "XRP/USDT",
      "ADA/USDT",
      "DOGE/USDT",
      "AVAX/USDT",
    ],
  });

  // Initialize services
  const decisionStore = new DecisionStore(db);
  const tradeEngine = new TradeEngine(db, executor, config, priceProvider);

  // Agent manager — per-agent portfolios with independent balances.
  // getCurrentPrice reads from the background price cache.
  const agentManager = new AgentManager(db, {
    defaultStartingBalance: config.simStartingBalance,
    feeRate: config.simFeePct / 100,
    getCurrentPrice: (symbol: string) => priceCache.get(symbol),
  });

  // Pre-seed default agents
  await agentManager.seedDefaults([
    { name: "Doom", startingBalance: config.simStartingBalance, strategy: "momentum-rotation" },
    { name: "Kangbot", startingBalance: config.simStartingBalance, strategy: "congress-follower" },
    {
      name: "ThanosBot",
      startingBalance: config.simStartingBalance,
      strategy: "momentum-rotation",
    },
  ]);

  // Theme runner for experimental strategies
  const themeRunner = new ThemeRunner(db, {
    decisionStore,
    tradeEngine,
    portfolio,
    marketData,
    redisUrl: config.redisUrl,
    simFeeRate: config.simFeePct / 100,
  });

  // Register built-in strategies BEFORE startAll() so themes can
  // resolve their strategy on the first tick (fixes #30, #31)
  themeRunner.registerStrategy(new CongressFollowerStrategy());
  themeRunner.registerStrategy(new MomentumRotationStrategy());
  themeRunner.registerStrategy(new AgentDrivenStrategy());

  // Agent trading pipeline — autonomous per-agent strategy execution
  const { AgentTradingPipeline } = await import("./agent/trading-pipeline.js");
  const agentStrategies = new Map<string, import("./themes/strategy.js").ThemeStrategy>();
  agentStrategies.set("momentum-rotation", new MomentumRotationStrategy());
  agentStrategies.set("congress-follower", new CongressFollowerStrategy());
  agentStrategies.set("agent-driven", new AgentDrivenStrategy());

  const agentPipeline = new AgentTradingPipeline({
    agentManager,
    marketData,
    db,
    strategies: agentStrategies,
    defaultUniverse: [
      "BTC/USDT",
      "ETH/USDT",
      "SOL/USDT",
      "XRP/USDT",
      "ADA/USDT",
      "DOGE/USDT",
      "AVAX/USDT",
    ],
    a2aEndpoint: config.a2aEndpoint || undefined,
    a2aToken: config.a2aToken || undefined,
  });

  // Agent trade engine — per-agent risk checks and execution
  const agentTradeEngine = new AgentTradeEngine(db, agentManager, config, priceProvider);

  // A2A trading coordinator — multi-agent orchestration
  const { A2ATradingCoordinator } = await import("./integration/a2a-trading-coordinator.js");
  const a2aCoordinator = new A2ATradingCoordinator({
    agentManager,
    agentPipeline,
    db,
  });

  // Start all enabled themes on boot
  await themeRunner.startAll();

  // Start the background price refresher
  priceCache.start();

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
    db,
    agentManager,
    agentTradeEngine,
    agentPipeline,
    a2aCoordinator,
  };

  const app = express();

  // Railway proxies requests (X-Forwarded-For) — trust exactly one hop so
  // express-rate-limit keys by the real client IP instead of the proxy's IP.
  // Without this, ALL clients share a single rate-limit bucket (ERR_ERL_UNEXPECTED_X_FORWARDED_FOR).
  app.set("trust proxy", 1);

  // Middleware
  app.use(helmet());
  app.use(express.json());

  // Rate limiting — 300 requests per 15 minutes per IP.
  // 100 was too small: the dashboard fast-refreshes agents every 10s (~90 req/15min),
  // and all fleet devices (3 Pis + dashboard) share one public IP, so agent cron
  // cycles were getting 429s on top of dashboard polling.
  const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests, please try again later" },
  });
  app.use("/api", apiLimiter);

  // API authentication — split by client class (see authGate in src/api/auth.ts):
  //   Humans (dashboard browsers): read-only — all GETs public.
  //   Machines (fleet crons, A2A): mutations (POST/PATCH/DELETE) key-gated.
  // If DOOMTRADE_API_KEY is not set, auth is disabled (local dev only).
  app.use("/api", authGate(config.apiKey));

  // Dashboard route — public HTML only. The API key is NEVER injected into
  // the page (it used to be, which leaked the key to anyone who loaded it).
  // The dashboard is a read-only viewer: it polls the public
  // GET /api/dashboard batch endpoint — no key, no sign-in, no localStorage.
  // This MUST come before express.static so we intercept the root path.
  app.get("/", (_req, res) => {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const htmlPath = join(__dirname, "..", "public", "index.html");
    res.sendFile(htmlPath);
  });

  // Serve dashboard static files (for any other static assets)
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
