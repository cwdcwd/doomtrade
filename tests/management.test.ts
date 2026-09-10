/**
 * Management routes + Clerk guard tests — mocked Clerk, no network.
 *
 * Covers (per fleet-ops-2b4 acceptance criteria):
 *   1. dev-open (CLERK_SECRET_KEY unset): /me → {authenticated:false},
 *      public GETs unaffected, management mutations 401.
 *   2. Configured, mocked admin session: /me → {authenticated:true, username},
 *      risk-limits GET/PUT round-trip (Zod bounds enforced, persistence
 *      via test DB), live config pickup by the trade engine.
 *   3. No/invalid session → 401 on risk-limits.
 *   4. Valid session, non-admin → 403 {error:"forbidden"}.
 *
 * The Clerk SDK is never called: clerkMiddleware is NOT mounted in these
 * tests — instead attachStubAuth (src/api/clerk.ts) attaches the same
 * branded req.auth FUNCTION the real middleware produces. sessionUserId
 * reads through the REAL getAuth() from @clerk/express, so this tests
 * our guard logic against the SDK's actual contract; Clerk's own session
 * verification is exercised in the E2E bead (fleet-ops-8g7) on production.
 * (fleet-ops-r7j: the previous object-shaped stub masked the exact
 * req.auth-shape bug that broke production — a function-shaped, branded
 * stub cannot hide that class of bug again.)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import supertest from "supertest";
import type { Database } from "../src/db/database.js";
import { openDatabase, closeDatabase } from "../src/db/database.js";
import { createManagementRouter } from "../src/api/routes/management.js";
import { attachStubAuth } from "../src/api/clerk.js";
import type { AppState } from "../src/api/routes.js";
import type { Config } from "../src/config.js";
import { getSetting, SETTING_KEYS } from "../src/db/settings-store.js";
import { TradeEngine } from "../src/engine/trade-engine.js";
import { SimulatedExchange } from "../src/executor/simulated.js";
import { DecisionStore } from "../src/decision/decision-store.js";
import { Portfolio } from "../src/portfolio/portfolio.js";

// ── Test constants ─────────────────────────────────────────────

const ADMIN_ID = "user_2testadmin1234567890";
const PEON_ID = "user_2testpeon12345678901";

const VALID_LIMITS = {
  maxOpenPositions: 5,
  maxPositionSizePct: 10,
  dailyTradeLimit: 30,
  maxDrawdownPct: 12,
  simStartingBalance: 50_000,
  simFeePct: 0.05,
};

/** Build a Config with Clerk fields (only what AppState/management read). */
function makeConfig(overrides: Partial<Config> = {}) {
  return {
    tradeMode: "sim",
    maxOpenPositions: 10,
    maxPositionSizePct: 20,
    dailyTradeLimit: 20,
    maxDrawdownPct: 15,
    simStartingBalance: 100_000,
    simFeePct: 0.1,
    clerkSecretKey: "",
    clerkPublishableKey: "",
    adminClerkUserId: "",
    ...overrides,
  } as Config;
}

/**
 * Build a test app around the REAL management router.
 * `sessionUserId` (may be null) is attached to req.auth by attachStubAuth
 * as a branded function — the exact shape clerkMiddleware produces.
 */
function makeApp(
  state: AppState,
  sessionUserId: string | null | undefined,
): express.Express {
  const app = express();
  app.use(express.json());
  if (sessionUserId !== undefined) {
    app.use((req, _res, next) => {
      attachStubAuth(req, sessionUserId);
      next();
    });
  }
  app.use("/api", createManagementRouter(state));
  return app;
}

/** Full AppState (engines included for live-pickup assertions). */
function makeState(db: Database, config: Config): AppState {
  // Fresh copy per test — PUT mutates config in place (by design), so a
  // shared literal would leak state across tests.
  const cfg: Config = { ...config };
  const decisionStore = new DecisionStore(db);
  const executor = new SimulatedExchange(db, {
    initialCash: cfg.simStartingBalance,
    feeRate: cfg.simFeePct / 100,
    getCurrentPrice: () => 100,
  });
  const tradeEngine = new TradeEngine(db, executor, cfg);
  const portfolio = new Portfolio(db, executor, {
    mode: "sim",
    initialCapital: cfg.simStartingBalance,
  });
  return {
    decisionStore,
    tradeEngine,
    portfolio,
    config: cfg,
    currentMode: "sim",
    modeChangedAt: Date.now(),
    db,
  };
}

// ── Tests ──────────────────────────────────────────────────────

describe("Management routes — dev-open (no Clerk config)", () => {
  let db: Database;

  beforeEach(async () => {
    db = await openDatabase({ path: ":memory:" });
  });
  afterEach(async () => {
    await closeDatabase(db);
  });

  it("/me returns {authenticated:false} when CLERK_SECRET_KEY unset", async () => {
    const state = makeState(db, makeConfig());
    const app = makeApp(state, undefined); // no session stub at all
    const res = await supertest(app).get("/api/management/me");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ authenticated: false, clerkConfigured: false });
  });

  it("/me returns {authenticated:false} for a deploy placeholder key", async () => {
    // Railway placeholder (e.g. "ROTATE_ME") must NOT enable Clerk.
    const state = makeState(
      db,
      makeConfig({ clerkSecretKey: "ROTATE_ME", clerkPublishableKey: "pk_mock_placeholder" }),
    );
    const app = makeApp(state, ADMIN_ID);
    const res = await supertest(app).get("/api/management/me");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ authenticated: false, clerkConfigured: false });
  });

  it("risk-limits GET is 401 in dev-open mode", async () => {
    const state = makeState(db, makeConfig());
    const app = makeApp(state, undefined);
    const res = await supertest(app).get("/api/management/risk-limits");
    expect(res.status).toBe(401);
  });

  it("risk-limits PUT is 401 in dev-open mode (no backdoor)", async () => {
    const state = makeState(db, makeConfig());
    const app = makeApp(state, undefined);
    const res = await supertest(app).put("/api/management/risk-limits").send(VALID_LIMITS);
    expect(res.status).toBe(401);
    // And nothing was persisted
    expect(await getSetting(db, SETTING_KEYS.riskLimits)).toBeNull();
  });
});

describe("Management routes — Clerk configured (mocked sessions)", () => {
  let db: Database;

  beforeEach(async () => {
    db = await openDatabase({ path: ":memory:" });
  });
  afterEach(async () => {
    await closeDatabase(db);
  });

  const configured = makeConfig({
    clerkSecretKey: "sk_mocksecretkey_000001",
    clerkPublishableKey: "pk_mock_000001",
    adminClerkUserId: ADMIN_ID,
  });

  function userLookup(username: string) {
    return { getUser: async (userId: string) => ({ username: userId === ADMIN_ID ? username : "other" }) };
  }

  it("/me: anonymous (no session) → {authenticated:false} + publishable key", async () => {
    const state = makeState(db, configured);
    const app = makeApp(state, null);
    const res = await supertest(app).get("/api/management/me");
    expect(res.status).toBe(200);
    expect(res.body.authenticated).toBe(false);
    expect(res.body.clerkConfigured).toBe(true);
    // pk_ is public by design — the frontend needs it for Clerk.js
    expect(res.body.publishableKey).toBe(configured.clerkPublishableKey);
    // sk_ never leaves the server
    expect(JSON.stringify(res.body)).not.toContain("sk_");
  });

  it("/me: configured but clerkMiddleware absent from chain → anonymous (fail closed)", async () => {
    // Covers sessionUserId's catch: in production the middleware IS in the
    // chain for /api/management (scoped mount, fleet-ops-mmt.2); when it is
    // not (e.g. a misconfigured mount), getAuth() throws and the route
    // must treat the request as anonymous, not 500.
    const state = makeState(db, configured);
    const app = makeApp(state, undefined); // no stub: req.auth never attached
    const res = await supertest(app).get("/api/management/me");
    expect(res.status).toBe(200);
    expect(res.body.authenticated).toBe(false);
    expect(res.body.clerkConfigured).toBe(true);
    expect(res.body.publishableKey).toBe(configured.clerkPublishableKey);
  });

  it("/me: valid admin session → {authenticated:true, username, isAdmin:true}", async () => {
    const state = makeState(db, configured);
    state.clerkUserLookup = userLookup("lazybaer");
    const app = makeApp(state, ADMIN_ID);
    const res = await supertest(app).get("/api/management/me");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      authenticated: true,
      userId: ADMIN_ID,
      username: "lazybaer",
      isAdmin: true,
    });
  });

  it("/me: signed-in non-admin → isAdmin:false (no key leak)", async () => {
    const state = makeState(db, configured);
    state.clerkUserLookup = userLookup("lazybaer");
    const app = makeApp(state, PEON_ID);
    const res = await supertest(app).get("/api/management/me");
    expect(res.status).toBe(200);
    expect(res.body.authenticated).toBe(true);
    expect(res.body.isAdmin).toBe(false);
  });

  it("risk-limits GET without session → 401", async () => {
    const state = makeState(db, configured);
    const app = makeApp(state, null);
    const res = await supertest(app).get("/api/management/risk-limits");
    expect(res.status).toBe(401);
  });

  it("risk-limits PUT without session → 401", async () => {
    const state = makeState(db, configured);
    const app = makeApp(state, null);
    const res = await supertest(app).put("/api/management/risk-limits").send(VALID_LIMITS);
    expect(res.status).toBe(401);
  });

  it("risk-limits GET/PUT with non-admin session → 403 {error:'forbidden'}", async () => {
    const state = makeState(db, configured);
    const app = makeApp(state, PEON_ID);
    const getRes = await supertest(app).get("/api/management/risk-limits");
    expect(getRes.status).toBe(403);
    expect(getRes.body).toEqual({ error: "forbidden", authenticated: true });

    const putRes = await supertest(app).put("/api/management/risk-limits").send(VALID_LIMITS);
    expect(putRes.status).toBe(403);
    expect(putRes.body).toEqual({ error: "forbidden", authenticated: true });
    // Non-admin writes nothing
    expect(await getSetting(db, SETTING_KEYS.riskLimits)).toBeNull();
  });

  it("risk-limits round-trip: admin PUT persists, GET returns, engine picks up live", async () => {
    const state = makeState(db, configured);
    state.clerkUserLookup = userLookup("lazybaer");
    const app = makeApp(state, ADMIN_ID);

    // PUT valid limits
    const putRes = await supertest(app).put("/api/management/risk-limits").send(VALID_LIMITS);
    expect(putRes.status).toBe(200);
    expect(putRes.body.limits).toEqual(VALID_LIMITS);

    // Persisted through the existing storage layer
    const persisted = await getSetting(db, SETTING_KEYS.riskLimits);
    expect(persisted).toEqual(VALID_LIMITS);

    // GET returns the same
    const getRes = await supertest(app).get("/api/management/risk-limits");
    expect(getRes.status).toBe(200);
    expect(getRes.body.limits).toEqual(VALID_LIMITS);

    // Live pickup: the trade engine holds the same config reference and
    // reads limits on every risk check — no restart needed.
    const engineConfig = state.tradeEngine as unknown as { config: Config };
    expect(engineConfig.config.maxOpenPositions).toBe(5);
    expect(engineConfig.config.dailyTradeLimit).toBe(30);
  });

  it("risk-limits PUT: out-of-bounds values rejected (Zod bounds)", async () => {
    const state = makeState(db, configured);
    const app = makeApp(state, ADMIN_ID);

    const badBodies = [
      { ...VALID_LIMITS, maxOpenPositions: 0 },        // < 1
      { ...VALID_LIMITS, maxOpenPositions: 51 },       // > 50
      { ...VALID_LIMITS, maxPositionSizePct: 0 },      // < 1
      { ...VALID_LIMITS, maxPositionSizePct: 101 },    // > 100
      { ...VALID_LIMITS, dailyTradeLimit: 0 },         // < 1
      { ...VALID_LIMITS, dailyTradeLimit: 101 },       // > 100
      { ...VALID_LIMITS, maxDrawdownPct: 0 },          // < 1
      { ...VALID_LIMITS, maxDrawdownPct: 51 },         // > 50
      { ...VALID_LIMITS, simStartingBalance: 0 },      // not > 0
      { ...VALID_LIMITS, simStartingBalance: -5 },     // negative
      { ...VALID_LIMITS, simFeePct: -0.01 },           // < 0
      { ...VALID_LIMITS, simFeePct: 1.01 },            // > 1
      { ...VALID_LIMITS, maxOpenPositions: 5.5 },      // non-integer
    ];

    for (const body of badBodies) {
      const res = await supertest(app).put("/api/management/risk-limits").send(body);
      expect(res.status, `body: ${JSON.stringify(body)}`).toBe(400);
    }

    // Nothing persisted, config unchanged
    expect(await getSetting(db, SETTING_KEYS.riskLimits)).toBeNull();
    expect(state.config.maxOpenPositions).toBe(10);
  });

  it("risk-limits PUT: missing fields rejected", async () => {
    const state = makeState(db, configured);
    const app = makeApp(state, ADMIN_ID);
    const res = await supertest(app)
      .put("/api/management/risk-limits")
      .send({ maxOpenPositions: 5 });
    expect(res.status).toBe(400);
    expect(await getSetting(db, SETTING_KEYS.riskLimits)).toBeNull();
  });

  it("fail-closed: configured but ADMIN_CLERK_USER_ID empty → even admin-ish session 403", async () => {
    const state = makeState(db, makeConfig({
      clerkSecretKey: "sk_mocksecretkey_000001",
      clerkPublishableKey: "pk_mock_000001",
      adminClerkUserId: "",
    }));
    const app = makeApp(state, ADMIN_ID);
    const res = await supertest(app).get("/api/management/risk-limits");
    expect(res.status).toBe(403);
  });

  it("boot override: persisted limits override env defaults (simulated boot)", async () => {
    // Write limits directly through the settings store (what a previous
    // boot's PUT would have left in the DB)
    const { setSetting } = await import("../src/db/settings-store.js");
    await setSetting(db, SETTING_KEYS.riskLimits, VALID_LIMITS);

    // Simulate boot: same code path as src/index.ts main()
    const config = makeConfig(); // env defaults
    const persisted = await getSetting(db, SETTING_KEYS.riskLimits);
    const { RiskLimitsSchema } = await import("../src/api/schemas.js");
    const parsed = RiskLimitsSchema.safeParse(persisted);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      config.maxOpenPositions = parsed.data.maxOpenPositions;
      config.dailyTradeLimit = parsed.data.dailyTradeLimit;
    }
    expect(config.maxOpenPositions).toBe(5);      // DB row won
    expect(config.dailyTradeLimit).toBe(30);      // DB row won
  });
});

describe("Clerk guard unit tests (src/api/clerk.ts)", () => {
  it("isClerkSecretKey accepts sk_ keys, rejects placeholders", async () => {
    const { isClerkSecretKey } = await import("../src/api/clerk.js");
    expect(isClerkSecretKey("sk_test_1234567890abc")).toBe(true);
    expect(isClerkSecretKey("sk_live_1234567890xyz")).toBe(true);
    expect(isClerkSecretKey("")).toBe(false);
    expect(isClerkSecretKey("ROTATE_ME")).toBe(false);
    expect(isClerkSecretKey("placeholder")).toBe(false);
    expect(isClerkSecretKey("pk_mock_xxxxxxxxxxxxxxxxxxxx")).toBe(false);
  });

  it("constantTimeEquals matches only equal strings", async () => {
    const { constantTimeEquals } = await import("../src/api/clerk.js");
    expect(constantTimeEquals("user_a", "user_a")).toBe(true);
    expect(constantTimeEquals("user_a", "user_b")).toBe(false);
    expect(constantTimeEquals("", "")).toBe(true);
  });

  it("isAdminUser: no configured admin → false (fail closed)", async () => {
    const { isAdminUser } = await import("../src/api/clerk.js");
    expect(isAdminUser("user_x", { clerkSecretKey: "sk_mock_x", clerkPublishableKey: "pk", adminClerkUserId: "" })).toBe(false);
  });
});

describe("Clerk FAPI origin derivation (fleet-ops-mmt.2)", () => {
  // The real prod pk shape (live-verified 2026-09-10: decodes to
  // thorough-robin-1114.clerk.accounts.dev) — re-encoded here with a fake
  // slug so no real key material lands in the test file.
  const pk = (frontendApi: string) =>
    `pk_test_${Buffer.from(`${frontendApi}$`).toString("base64").replace(/=+$/, "")}`;

  it("derives the FAPI origin from a pk_test_ key", async () => {
    const { clerkFapiOrigin } = await import("../src/api/clerk.js");
    expect(clerkFapiOrigin(pk("thorough-robin-1114.clerk.accounts.dev"))).toBe(
      "https://thorough-robin-1114.clerk.accounts.dev",
    );
  });

  it("derives the FAPI origin from a pk_live_ key", async () => {
    const { clerkFapiOrigin } = await import("../src/api/clerk.js");
    const livePk = pk("clerk.example.com");
    expect(clerkFapiOrigin(livePk.replace("pk_test_", "pk_live_"))).toBe("https://clerk.example.com");
  });

  it("rejects malformed keys — fail closed", async () => {
    const { clerkFapiOrigin } = await import("../src/api/clerk.js");
    expect(clerkFapiOrigin("")).toBeNull();
    expect(clerkFapiOrigin("pk_test_")).toBeNull();
    expect(clerkFapiOrigin("not-a-key")).toBeNull();
    // segment not a valid key encoding: decodes to "nohostend$" → has no dot
    expect(clerkFapiOrigin("pk_test_bm9ob3N0ZW5k")).toBeNull();
    // decodes to "two$$" → more than one '$' at the end
    expect(clerkFapiOrigin("pk_test_dHdvJCQ")).toBeNull();
    // decodes to "no-dollar-sign" (no trailing '$')
    expect(clerkFapiOrigin(pk("clerk.example.com").slice(0, -2) + "aa")).toBeNull();
  });

  it("CSP directives: FAPI origin added to script/connect/frame-src when configured", async () => {
    const { clerkCspDirectives } = await import("../src/api/clerk.js");
    const cfg = {
      clerkSecretKey: "sk_test_1234567890",
      clerkPublishableKey: pk("thorough-robin-1114.clerk.accounts.dev"),
      adminClerkUserId: "user_x",
    };
    const d = clerkCspDirectives(cfg);
    expect(d["script-src"]).toEqual(["'self'", "https://thorough-robin-1114.clerk.accounts.dev"]);
    expect(d["connect-src"]).toEqual(["'self'", "https://thorough-robin-1114.clerk.accounts.dev"]);
    expect(d["frame-src"]).toEqual(["'self'", "https://thorough-robin-1114.clerk.accounts.dev"]);
    // No unsafe-inline, no wildcards, no other directives touched
    const flat = JSON.stringify(d);
    expect(flat).not.toContain("unsafe-inline");
    expect(flat).not.toContain("*");
  });

  it("CSP directives: dev-open (unconfigured) → empty (helmet defaults unchanged)", async () => {
    const { clerkCspDirectives } = await import("../src/api/clerk.js");
    expect(clerkCspDirectives({ clerkSecretKey: "", clerkPublishableKey: "", adminClerkUserId: "" })).toEqual({});
    // sk_ present but pk malformed → still fail closed
    expect(
      clerkCspDirectives({ clerkSecretKey: "sk_test_1234567890", clerkPublishableKey: "junk", adminClerkUserId: "" }),
    ).toEqual({});
  });
});