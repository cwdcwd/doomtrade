/**
 * server.test.ts — buildServer (src/server.ts) construction tests
 * (fleet-ops-ofe).
 *
 * Exercises the REAL boot path — the same buildServer() src/index.ts calls —
 * with in-memory SQLite (the api.test.ts pattern). No network, no Clerk SDK
 * calls: buildServer starts nothing (no listen, no priceCache.start(), no
 * themeRunner.startAll()); that lifecycle lives in the entry point.
 *
 * Mount-order proofs are behavioral, not mocked: each middleware answers
 * with a DISTINCT response (limiter 429, authGate 401 Unauthorized,
 * management guard 401 {authenticated:false}, API router 200/201), so the
 * body that comes back proves which middleware won the request.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import supertest from "supertest";
import type { RequestHandler } from "express";
import { openDatabase, closeDatabase, type Database } from "../src/db/database.js";
import { buildServer } from "../src/server.js";
import { setSetting, SETTING_KEYS } from "../src/db/settings-store.js";
import { ThemeRunner } from "../src/themes/theme-runner.js";
import { PriceCache } from "../src/market/stock-price-cache.js";
import type { Config } from "../src/config.js";

// Mock JUST the market-data factory (house pattern from tests/ccxt-data /
// alpaca-data): construction wiring in buildServer stays real, but quote
// fetches never touch the network. The trades executed below run through
// the REAL SimulatedExchange against in-memory SQLite.
const marketMock = vi.hoisted(() => {
  const quotes = new Map<string, number>();
  return {
    quotes,
    service: {
      getQuote: (sym: string) => {
        const price = quotes.get(sym) ?? 100;
        return Promise.resolve({
          symbol: sym,
          price,
          timestamp: new Date().toISOString(),
          source: "test",
        });
      },
      getBars: () => Promise.resolve([]),
      getSnapshot: () => Promise.resolve([]),
    },
  };
});

vi.mock("../src/market/market.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/market/market.js")>();
  return {
    ...actual,
    createPublicCryptoMarketData: () => marketMock.service,
  };
});

/** A Config with every field, set to safe test values. */
function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 0, // never listened in these tests
    tradeMode: "sim",
    alpacaKeyId: "",
    alpacaSecretKey: "",
    alpacaPaper: true,
    ccxtExchange: "binance",
    ccxtApiKey: "",
    ccxtApiSecret: "",
    databasePath: ":memory:",
    databaseUrl: "",
    maxOpenPositions: 10,
    maxPositionSizePct: 20,
    dailyTradeLimit: 20,
    maxDrawdownPct: 15,
    simStartingBalance: 100_000,
    simFeePct: 0.1,
    redisUrl: "",
    a2aEndpoint: "",
    a2aToken: "",
    clerkSecretKey: "",
    clerkPublishableKey: "",
    adminClerkUserId: "",
    apiKey: "",
    ...overrides,
  };
}

/** Injectable limiter: lets through n requests, then 429s with a marker body. */
function countingLimiter(max: number, hits: { count: number }): RequestHandler {
  return (_req, res, next) => {
    hits.count += 1;
    if (hits.count > max) {
      res.status(429).json({ error: "rate limited by test limiter" });
      return;
    }
    next();
  };
}

const AUTHGATE_BODY = { error: "Unauthorized" };
const isAuthGateBody = (body: Record<string, unknown>) => body.error === "Unauthorized";

describe("buildServer", () => {
  let db: Database;

  beforeEach(async () => {
    db = await openDatabase({ path: ":memory:" });
  });

  afterEach(async () => {
    await closeDatabase(db);
    vi.restoreAllMocks();
  });

  // ── Boot basics ────────────────────────────────────────────────

  it("boots from an empty DB and serves /health", async () => {
    const { app } = await buildServer(makeConfig(), db);
    const resp = await supertest(app).get("/health");
    expect(resp.status).toBe(200);
    expect(resp.body.status).toBe("ok");
    expect(resp.body.mode).toBe("sim");
    expect(resp.body.db).toBe("sqlite");
    expect(typeof resp.body.uptime).toBe("number");
  });

  it("serves /api/health through the full mounted chain", async () => {
    const { app } = await buildServer(makeConfig(), db);
    const resp = await supertest(app).get("/api/health");
    expect(resp.status).toBe(200);
    expect(resp.body.status).toBe("ok");
  });

  it("is inert: construction starts no background jobs", async () => {
    const startAllSpy = vi.spyOn(ThemeRunner.prototype, "startAll");
    const priceStartSpy = vi.spyOn(PriceCache.prototype, "start");
    const { priceCache } = await buildServer(makeConfig(), db);
    expect(startAllSpy).not.toHaveBeenCalled();
    expect(priceStartSpy).not.toHaveBeenCalled();
    // The price cache exists but never refreshed: no quotes were fetched.
    expect(priceCache.get("BTC/USDT")).toBeNull();
  });

  it("wires the app state to the returned services", async () => {
    const built = await buildServer(makeConfig(), db);
    expect(built.state.themeRunner).toBe(built.themeRunner);
    expect(built.state.agentManager).toBe(built.agentManager);
    expect(built.state.db).toBe(db);
    expect(built.state.marketData).toBeDefined();
    expect(built.state.currentMode).toBe("sim");
  });

  // ── Middleware mount order (behavioral proofs) ──────────────────

  it("mounts the rate limiter before the management router", async () => {
    const hits = { count: 0 };
    const { app } = await buildServer(makeConfig(), db, {
      createRateLimiter: () => countingLimiter(1, hits),
    });
    // Request 1 passes the limiter and reaches the management router.
    const first = await supertest(app).get("/api/management/me");
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ authenticated: false, clerkConfigured: false });
    // Request 2 is 429'd by the limiter — the management router never ran.
    const second = await supertest(app).get("/api/management/me");
    expect(second.status).toBe(429);
    expect(second.body.error).toContain("rate limited");
  });

  it("mounts the rate limiter before authGate", async () => {
    const hits = { count: 0 };
    const { app } = await buildServer(makeConfig({ apiKey: "test-key" }), db, {
      createRateLimiter: () => countingLimiter(1, hits),
    });
    // Request 1: limiter passes, authGate answers its 401 body.
    const first = await supertest(app).post("/api/decisions").send({});
    expect(first.status).toBe(401);
    expect(isAuthGateBody(first.body)).toBe(true);
    // Request 2: limiter 429s before authGate can answer.
    const second = await supertest(app).post("/api/decisions").send({});
    expect(second.status).toBe(429);
    expect(isAuthGateBody(second.body)).toBe(false);
  });

  it("mounts the management router before authGate", async () => {
    const { app } = await buildServer(makeConfig({ apiKey: "test-key" }), db);
    // A keyless PUT: authGate would answer {error:"Unauthorized"}, but the
    // management guard (closer to the client in the chain) answers first
    // with its dev-open {authenticated:false} body.
    const resp = await supertest(app).put("/api/management/risk-limits").send({});
    expect(resp.status).toBe(401);
    expect(resp.body).toEqual({ authenticated: false, clerkConfigured: false });
    expect(isAuthGateBody(resp.body)).toBe(false);
  });

  it("mounts authGate before the API router (keyed mutations)", async () => {
    const { app } = await buildServer(makeConfig({ apiKey: "test-key" }), db);
    const anon = await supertest(app).post("/api/decisions").send({});
    expect(anon.status).toBe(401);
    expect(isAuthGateBody(anon.body)).toBe(true);

    const keyed = await supertest(app)
      .post("/api/decisions")
      .set("Authorization", "Bearer test-key")
      .send({
        agent: "doom",
        symbol: "AAPL",
        action: "buy",
        quantity: 1,
        priceAtDecision: 185,
        rationale: "server boot test",
        confidence: 5,
        mode: "sim",
      });
    expect(keyed.status).toBe(201);
  });

  it("answers malformed JSON bodies with a JSON error, not HTML", async () => {
    const { app } = await buildServer(makeConfig(), db);
    const resp = await supertest(app)
      .post("/api/decisions")
      .set("Content-Type", "application/json")
      .send("{not valid json");
    // express.json() throws (status 400) — the app-level error handler
    // answers with the quiet JSON body instead of Express's HTML page.
    expect(resp.status).toBe(400);
    expect(resp.type).toBe("application/json");
    expect(resp.body.error).toBe("Internal server error");
  });

  // ── Service seeding ─────────────────────────────────────────────

  it("seeds the three default agents, idempotently across boots", async () => {
    const first = await buildServer(makeConfig(), db);
    const agents = await first.agentManager.list();
    const byName = new Map(agents.map((a) => [a.name, a.strategy]));
    expect(agents).toHaveLength(3);
    expect(byName.get("Doom")).toBe("momentum-rotation");
    expect(byName.get("Kangbot")).toBe("congress-follower");
    expect(byName.get("ThanosBot")).toBe("momentum-rotation");

    // Second build over the same DB must not duplicate the seeded agents.
    const second = await buildServer(makeConfig(), db);
    const agentsAfter = await second.agentManager.list();
    expect(agentsAfter).toHaveLength(3);
  });

  it("executes a market-order trade through the wired price provider", async () => {
    marketMock.quotes.set("AAPL", 185.5);
    const { app, state } = await buildServer(makeConfig(), db);
    // Create a decision and execute it as a MARKET order with NO
    // limitPrice — the only path that calls the server-wired
    // priceProvider.getQuote closure (server.ts) and the SimulatedExchange
    // getCurrentPrice fallback closure.
    const created = await supertest(app)
      .post("/api/decisions")
      .send({
        agent: "doom",
        symbol: "AAPL",
        action: "buy",
        quantity: 10,
        priceAtDecision: 185,
        rationale: "cover the provider closure",
        confidence: 7,
        mode: "sim",
      });
    expect(created.status).toBe(201);
    const decisionId = created.body.decision.id;

    const trade = await supertest(app).post("/api/trade").send({ decisionId });
    expect(trade.status).toBe(200);
    expect(trade.body.riskPassed).toBe(true);
    expect(trade.body.orderResult.status).toBe("filled");
    expect(trade.body.orderResult.fillPrice).toBeCloseTo(185.5, 2);

    // The state the server wired is the one that priced the fill.
    expect(state.marketData).toBeDefined();
    const q = await state.marketData!.getQuote("AAPL");
    expect(q.price).toBe(185.5);
  });

  it("boots in live mode: Alpaca executor + routed market data", async () => {
    const { state, app } = await buildServer(
      makeConfig({
        tradeMode: "live",
        alpacaKeyId: "key-id",
        alpacaSecretKey: "secret-key",
      }),
      db,
    );
    expect(state.currentMode).toBe("live");
    expect(state.tradeEngine).toBeDefined();
    // Live routing chose createMarketDataService — Alpaca for stocks.
    // Its getQuote lazy-loads the Alpaca SDK; stock symbols route there
    // (config carries keyId), crypto stays on CCXT.
    const health = await supertest(app).get("/health");
    expect(health.body.mode).toBe("live");
  });

  it("mounts clerkMiddleware when Clerk is configured", async () => {
    const pk =
      "pk_test_" +
      Buffer.from("clerk.example.com$").toString("base64").replace(/=+$/, "");
    const { app, state } = await buildServer(
      makeConfig({
        clerkSecretKey: "sk_test_abcdefghij0123456789",
        clerkPublishableKey: pk,
      }),
      db,
    );
    // clerkEnabled(config) was true → middleware mounted + lookup wired.
    expect(state.clerkUserLookup).toBeDefined();
    // The real clerkMiddleware answers before the management guard:
    // an anonymous request to /me gets through Clerk's decorator with no
    // session attached and the guard reports anonymous.
    const resp = await supertest(app).get("/api/management/me");
    expect(resp.status).toBe(200);
    expect(resp.body.clerkConfigured).toBe(true);
    expect(resp.body.authenticated).toBe(false);
  });

  it("wires the injected clerkUserLookup into state", async () => {
    const getUser = async (userId: string) => ({ username: `u-${userId}` });
    const { state } = await buildServer(makeConfig(), db, { clerkUserLookup: { getUser } });
    expect(state.clerkUserLookup).toBeInstanceOf(Object);
    const got = await state.clerkUserLookup!.getUser("user_abc");
    expect(got?.username).toBe("u-user_abc");
  });

  it("applies persisted risk limits over env defaults", async () => {
    await setSetting(db, SETTING_KEYS.riskLimits, {
      maxOpenPositions: 5,
      maxPositionSizePct: 12,
      dailyTradeLimit: 25,
      maxDrawdownPct: 10,
      simStartingBalance: 50_000,
      simFeePct: 0.05,
    });
    const { state } = await buildServer(makeConfig(), db);
    expect(state.config.maxOpenPositions).toBe(5);
    expect(state.config.maxPositionSizePct).toBe(12);
    expect(state.config.dailyTradeLimit).toBe(25);
    expect(state.config.maxDrawdownPct).toBe(10);
    expect(state.config.simStartingBalance).toBe(50_000);
    expect(state.config.simFeePct).toBe(0.05);
  });

  it("keeps env defaults when the persisted limits row is invalid", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await setSetting(db, SETTING_KEYS.riskLimits, {
      maxOpenPositions: 500, // exceeds schema max (50) — safeParse fails
      maxPositionSizePct: 12,
      dailyTradeLimit: 25,
      maxDrawdownPct: 10,
      simStartingBalance: 50_000,
      simFeePct: 0.05,
    });
    const { state } = await buildServer(makeConfig(), db);
    expect(state.config.maxOpenPositions).toBe(10); // env default kept
    expect(state.config.dailyTradeLimit).toBe(20);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Persisted risk limits failed validation"),
    );
  });

  // ── Static assets ──────────────────────────────────────────────

  it("serves the dashboard HTML at / and static assets", async () => {
    const { app } = await buildServer(makeConfig(), db);
    const home = await supertest(app).get("/");
    expect(home.status).toBe(200);
    expect(home.type).toBe("text/html");
    expect(home.text).toContain("DoomTrade");

    const js = await supertest(app).get("/app.js");
    expect(js.status).toBe(200);
    expect(js.type).toBe("application/javascript");
  });
});