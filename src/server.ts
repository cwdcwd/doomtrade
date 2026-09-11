/**
 * server.ts — Express app construction for DoomTrade.
 *
 * Everything needed to build the running server — service wiring,
 * middleware order, route mounting — lives in `buildServer(config, db)`,
 * exported and injectable. It is importable WITHOUT side effects: no
 * listen, no signal handlers, no background timers (themeRunner.startAll
 * and priceCache.start are deliberately NOT called here). The
 * side-effectful lifecycle stays in src/index.ts, the thin entry point
 * (fleet-ops-ofe).
 *
 * Test seams (ServerOptions):
 *   createRateLimiter — swap the /api rate limiter, so tests can assert
 *                       mount order on the real chain without firing 300
 *                       real requests
 *   clerkUserLookup   — override the Clerk username lookup for
 *                       GET /api/management/me
 */

import express, { type Express, type RequestHandler, type ErrorRequestHandler } from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { clerkMiddleware, clerkClient } from "@clerk/express";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type { Config } from "./config.js";
import type { Database } from "./db/database.js";
import { DecisionStore } from "./decision/decision-store.js";
import { SimulatedExchange } from "./executor/simulated.js";
import { authGate } from "./api/auth.js";
import { TradeEngine } from "./engine/trade-engine.js";
import { Portfolio } from "./portfolio/portfolio.js";
import { createApiRouter, type AppState } from "./api/routes.js";
import { createManagementRouter, type ClerkUserLookup } from "./api/routes/management.js";
import { createPublicCryptoMarketData, createMarketDataService } from "./market/market.js";
import { PriceCache } from "./market/stock-price-cache.js";
import { ResearchService } from "./research/research.js";
import { ThemeRunner } from "./themes/theme-runner.js";
import { CongressFollowerStrategy } from "./themes/strategies/congress-follower.js";
import { MomentumRotationStrategy } from "./themes/strategies/momentum-rotation.js";
import { AgentDrivenStrategy } from "./themes/strategies/agent-driven.js";
import { AgentManager } from "./agent/agent-manager.js";
import { AgentTradeEngine } from "./engine/agent-trade-engine.js";
import { getSetting, SETTING_KEYS } from "./db/settings-store.js";
import { RiskLimitsSchema } from "./api/schemas.js";
import { clerkEnabled, clerkCspDirectives } from "./api/clerk.js";
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
async function createExecutor(config: Config, db: Database): Promise<Executor> {
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

/** Default symbol universe for the background price cache + agent pipeline. */
const DEFAULT_UNIVERSE = [
  "BTC/USDT",
  "ETH/USDT",
  "SOL/USDT",
  "XRP/USDT",
  "ADA/USDT",
  "DOGE/USDT",
  "AVAX/USDT",
];

/** Agents pre-seeded on every boot (idempotent — existing rows are kept). */
const DEFAULT_AGENTS = [
  { name: "Doom", strategy: "momentum-rotation" },
  { name: "Kangbot", strategy: "congress-follower" },
  { name: "ThanosBot", strategy: "momentum-rotation" },
];

/** Injectable seams for tests — see the file header. */
export interface ServerOptions {
  /** Factory for the /api rate limiter (default: 300 req / 15 min / IP). */
  createRateLimiter?: () => RequestHandler;
  /** Clerk user lookup for GET /api/management/me username display. */
  clerkUserLookup?: ClerkUserLookup;
}

/** What buildServer returns: the app plus the services the entry point drives. */
export interface BuiltServer {
  app: Express;
  state: AppState;
  themeRunner: ThemeRunner;
  priceCache: PriceCache;
  agentManager: AgentManager;
}

/**
 * Build the DoomTrade Express server: services, middleware, routes.
 *
 * Pure construction — starts nothing. The caller (src/index.ts, or a test)
 * owns the lifecycle: themeRunner.startAll(), priceCache.start(), listen.
 */
export async function buildServer(
  config: Config,
  db: Database,
  options: ServerOptions = {},
): Promise<BuiltServer> {
  // Risk limits: env vars are boot defaults; a persisted settings row
  // (written by PUT /api/management/risk-limits) overrides them on every
  // boot. Mutating `config` in place means both trade engines — which hold
  // this same reference — pick up the limits on their next risk check.
  const persistedLimits = await getSetting(db, SETTING_KEYS.riskLimits);
  if (persistedLimits) {
    const parsed = RiskLimitsSchema.safeParse(persistedLimits);
    if (parsed.success) {
      config.maxOpenPositions = parsed.data.maxOpenPositions;
      config.maxPositionSizePct = parsed.data.maxPositionSizePct;
      config.dailyTradeLimit = parsed.data.dailyTradeLimit;
      config.maxDrawdownPct = parsed.data.maxDrawdownPct;
      config.simStartingBalance = parsed.data.simStartingBalance;
      config.simFeePct = parsed.data.simFeePct;
    } else {
      console.warn("Persisted risk limits failed validation — using env defaults");
    }
  }

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
  // NOT started here — the entry point calls priceCache.start().
  const priceCache = new PriceCache({
    db,
    marketData,
    intervalMs: 60_000,
    watchSymbols: DEFAULT_UNIVERSE,
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

  // Pre-seed default agents (idempotent — keeps existing rows/balances)
  await agentManager.seedDefaults(
    DEFAULT_AGENTS.map((a) => ({ ...a, startingBalance: config.simStartingBalance })),
  );

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
    defaultUniverse: DEFAULT_UNIVERSE,
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

  // App state (mutable for mode toggle)
  const state: AppState = {
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

  // Clerk user lookup for GET /api/management/me (username display only).
  // Server-side only — uses the secret key, never exposed to the client.
  if (options.clerkUserLookup) {
    state.clerkUserLookup = options.clerkUserLookup;
  } else if (clerkEnabled(config)) {
    state.clerkUserLookup = {
      getUser: async (userId: string) => {
        const user = await clerkClient.users.getUser(userId);
        return { username: user.username ?? null };
      },
    };
  }

  const app = express();

  // Railway proxies requests (X-Forwarded-For) — trust exactly one hop so
  // express-rate-limit keys by the real client IP instead of the proxy's IP.
  // Without this, ALL clients share a single rate-limit bucket
  // (ERR_ERL_UNEXPECTED_X_FORWARDED_FOR).
  app.set("trust proxy", 1);

  // Middleware
  // helmet CSP: Clerk's Frontend API origin is added (script/connect/frame)
  // ONLY when management auth is configured — derived from the publishable
  // key at boot, never hardcoded (see clerkCspDirectives). In dev-open mode
  // the directives object is empty and helmet's stock defaults apply
  // unchanged. Other helmet protections (HSTS, nosniff, frameguard, …)
  // keep their defaults.
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: clerkCspDirectives(config),
      },
    }),
  );
  app.use(express.json());

  // Clerk session verification for the management routes ONLY. Scoped to
  // /api/management (fleet-ops-mmt.2): mounted globally, its handshake
  // decorator 307-redirected every anonymous browser navigation to
  // /__clerk/v1/client/handshake, breaking the public dashboard. getAuth /
  // sessionUserId read req.auth only inside management routes; no public
  // route passes through Clerk code. The same-origin /__clerk frontend API
  // proxy is GONE (never registered in the Clerk dashboard → every
  // /__clerk/v1/* call 400'd host_invalid): the browser loads clerk-js +
  // @clerk/ui directly from the FAPI origin derived from the publishable
  // key (see public/app.js loadClerkJs + clerkFapiOrigin). Mounted only
  // when management auth is configured — in dev-open mode
  // (CLERK_SECRET_KEY unset/malformed) no Clerk code runs at all.
  if (clerkEnabled(config)) {
    app.use(
      "/api/management",
      clerkMiddleware({
        publishableKey: config.clerkPublishableKey,
        secretKey: config.clerkSecretKey,
      }),
    );
  }

  // Rate limiting — 300 requests per 15 minutes per IP.
  // 100 was too small: the dashboard fast-refreshes agents every 10s
  // (~90 req/15min), and all fleet devices (3 Pis + dashboard) share one
  // public IP, so agent cron cycles were getting 429s on top of dashboard
  // polling. Injectable via ServerOptions so tests can observe mount order
  // without firing 300 real requests.
  const apiLimiter: RequestHandler = options.createRateLimiter
    ? options.createRateLimiter()
    : rateLimit({
        windowMs: 15 * 60 * 1000,
        max: 300,
        standardHeaders: true,
        legacyHeaders: false,
        message: { error: "Too many requests, please try again later" },
      });
  app.use("/api", apiLimiter);

  // Management routes — mounted AFTER the rate limiter (unthrottled probes
  // would let a third party hammer Clerk user lookups) but BEFORE authGate:
  // the admin browser holds a Clerk session cookie, not the fleet API key.
  // Enforced by src/api/clerk.ts guards. /api/management/me is the public
  // status probe; risk-limits requires the admin session.
  app.use("/api", createManagementRouter(state));

  // API authentication — split by client class (see authGate in
  // src/api/auth.ts):
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

  // App-level error handler (last middleware in the chain): any error that
  // escapes a route handler (e.g. a JSON body parse failure from
  // express.json()) answers with a quiet JSON 500 instead of Express's
  // default HTML error page. Route handlers keep their own fine-grained
  // try/catch responses — this is the last resort, and never leaks
  // error internals to the client.
  const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
    console.error("Unhandled server error:", err);
    res.status(err?.status ?? 500).json({ error: "Internal server error" });
  };
  app.use(errorHandler);

  return { app, state, themeRunner, priceCache, agentManager };
}
