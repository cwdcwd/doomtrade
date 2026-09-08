/**
 * Tests for themes dashboard API endpoints.
 *
 * Covers the endpoints that power the themes comparison dashboard:
 *   GET  /api/themes              — list all themes
 *   GET  /api/themes/:id/performance — per-theme P&L metrics
 *   GET  /api/themes/:id/evaluations — evaluation audit trail
 *   POST /api/themes/:id/evaluate  — manual evaluation trigger
 *
 * Verifies that the dashboard can fetch comparison data, per-theme
 * P&L, and evaluation history for the audit trail.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import { openDatabase, closeDatabase, type DbClient } from "../src/db/database.js";
import { DecisionStore } from "../src/decision/decision-store.js";
import { TradeEngine } from "../src/engine/trade-engine.js";
import { Portfolio } from "../src/portfolio/portfolio.js";
import { SimulatedExchange } from "../src/executor/simulated.js";
import { createApiRouter, type AppState } from "../src/api/routes.js";
import { ThemeRunner } from "../src/themes/theme-runner.js";
import { ThemeStore } from "../src/themes/theme-store.js";
import { ThemeSubAccount } from "../src/themes/theme-sub-account.js";
import { MomentumRotationStrategy } from "../src/themes/strategies/momentum-rotation.js";
import { createPublicCryptoMarketData } from "../src/market/market.js";
import { ResearchService } from "../src/research/research.js";
import { loadConfig } from "../src/config.js";
import type { PriceProvider } from "../src/engine/trade-engine.js";

let db: DbClient;
let app: express.Application;
let server: ReturnType<express.Application["listen"]>;
let baseUrl: string;
let themeStore: ThemeStore;
let themeRunner: ThemeRunner;

beforeAll(async () => {
  db = await openDatabase({ path: ":memory:" });

  const config = loadConfig({});
  const executor = new SimulatedExchange(db, {
    initialCash: 100_000,
    feeRate: 0.001,
  });
  const portfolio = new Portfolio(db, executor, {
    mode: "sim",
    initialCapital: 100_000,
  });
  const marketData = createPublicCryptoMarketData("kraken");
  const research = new ResearchService(marketData);
  const decisionStore = new DecisionStore(db);
  const priceProvider: PriceProvider = {
    async getQuote() {
      return 100;
    },
  };
  const tradeEngine = new TradeEngine(db, executor, config, priceProvider);

  themeRunner = new ThemeRunner(db, {
    decisionStore,
    tradeEngine,
    portfolio,
    marketData,
    simFeeRate: 0.001,
  });
  themeRunner.registerStrategy(new MomentumRotationStrategy());

  themeStore = new ThemeStore(db);

  const state: AppState = {
    decisionStore,
    tradeEngine,
    portfolio,
    config,
    currentMode: "sim" as const,
    modeChangedAt: Date.now(),
    marketData,
    research,
    themeRunner,
  };

  app = express();
  app.use(express.json());
  app.use("/api", createApiRouter(state));

  server = app.listen(0);
  const addr = server.address();
  if (addr && typeof addr === "object") {
    baseUrl = `http://localhost:${addr.port}`;
  }
});

afterAll(async () => {
  if (server) server.close();
  await closeDatabase(db);
});

describe("Themes Dashboard API", () => {
  it("GET /api/themes returns empty list initially", async () => {
    const resp = await fetch(`${baseUrl}/api/themes`);
    expect(resp.ok).toBe(true);
    const body = await resp.json();
    expect(body.themes).toEqual([]);
    expect(body.count).toBe(0);
  });

  it("POST /api/themes creates a momentum-rotation theme", async () => {
    const resp = await fetch(`${baseUrl}/api/themes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Momentum Test 1",
        strategy: "momentum-rotation",
        mode: "sim",
        schedule: { type: "manual" },
        allocatedCapital: 10_000,
        maxPositions: 5,
        params: {
          universe: ["AAPL", "NVDA", "TSLA"],
          topN: 3,
        },
      }),
    });
    expect(resp.status).toBe(201);
    const body = await resp.json();
    expect(body.theme).toBeDefined();
    expect(body.theme.name).toBe("Momentum Test 1");
    expect(body.theme.strategy).toBe("momentum-rotation");
    expect(body.theme.allocatedCapital).toBe(10_000);
    expect(body.theme.enabled).toBe(true);
  });

  it("GET /api/themes returns created themes", async () => {
    const resp = await fetch(`${baseUrl}/api/themes`);
    expect(resp.ok).toBe(true);
    const body = await resp.json();
    expect(body.themes.length).toBeGreaterThanOrEqual(1);
    expect(body.count).toBeGreaterThanOrEqual(1);
  });

  it("GET /api/themes/:id returns theme config", async () => {
    const themes = await themeStore.list();
    const theme = themes[0];
    const resp = await fetch(`${baseUrl}/api/themes/${theme.id}`);
    expect(resp.ok).toBe(true);
    const body = await resp.json();
    expect(body.theme.id).toBe(theme.id);
    expect(body.theme.name).toBe(theme.name);
  });

  it("GET /api/themes/:id/performance returns metrics", async () => {
    const themes = await themeStore.list();
    const theme = themes[0];

    // Initialize sub-account so performance has data
    const sub = new ThemeSubAccount(db, theme.id, { feeRate: 0 });
    await sub.initialize(10_000);

    const resp = await fetch(`${baseUrl}/api/themes/${theme.id}/performance`);
    expect(resp.ok).toBe(true);
    const body = await resp.json();
    expect(body.performance).toBeDefined();
    expect(body.performance.themeId).toBe(theme.id);
    expect(body.performance.startingBalance).toBe(10_000);
    expect(body.performance.currentBalance).toBe(10_000);
    expect(body.performance.status).toBe("active");
    expect(typeof body.performance.drawdownPct).toBe("number");
  });

  it("GET /api/themes/:id/evaluations returns empty initially", async () => {
    const themes = await themeStore.list();
    const theme = themes[0];
    const resp = await fetch(`${baseUrl}/api/themes/${theme.id}/evaluations`);
    expect(resp.ok).toBe(true);
    const body = await resp.json();
    expect(body.evaluations).toEqual([]);
    expect(body.count).toBe(0);
  });

  it("POST /api/themes/:id/evaluate triggers evaluation and records it", async () => {
    const themes = await themeStore.list();
    const theme = themes[0];
    const resp = await fetch(`${baseUrl}/api/themes/${theme.id}/evaluate`, {
      method: "POST",
    });
    expect(resp.ok).toBe(true);
    const body = await resp.json();
    expect(body.result).toBeDefined();
    expect(body.result.themeId).toBe(theme.id);
    expect(body.result.timestamp).toBeDefined();
    expect(Array.isArray(body.result.errors)).toBe(true);

    // Verify evaluation was recorded
    const evalResp = await fetch(`${baseUrl}/api/themes/${theme.id}/evaluations`);
    const evalBody = await evalResp.json();
    expect(evalBody.evaluations.length).toBeGreaterThanOrEqual(1);
    const lastEval = evalBody.evaluations[0];
    expect(lastEval.themeId).toBe(theme.id);
    expect(typeof lastEval.signalsCount).toBe("number");
    expect(typeof lastEval.decisionsCount).toBe("number");
    expect(typeof lastEval.tradesCount).toBe("number");
  });

  it("GET /api/themes/:id/performance 404 for unknown theme", async () => {
    const resp = await fetch(`${baseUrl}/api/themes/nonexistent-id/performance`);
    expect(resp.status).toBe(404);
  });

  it("PATCH /api/themes/:id updates theme config", async () => {
    const themes = await themeStore.list();
    const theme = themes[0];
    const resp = await fetch(`${baseUrl}/api/themes/${theme.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Renamed Momentum" }),
    });
    expect(resp.ok).toBe(true);
    const body = await resp.json();
    expect(body.theme.name).toBe("Renamed Momentum");
  });

  it("DELETE /api/themes/:id removes theme", async () => {
    const theme = await themeStore.create({
      name: "To Delete",
      strategy: "momentum-rotation",
      schedule: { type: "manual" },
      allocatedCapital: 1_000,
      params: { universe: ["AAPL"], topN: 1 },
    });
    const resp = await fetch(`${baseUrl}/api/themes/${theme.id}`, {
      method: "DELETE",
    });
    expect(resp.ok).toBe(true);
    const body = await resp.json();
    expect(body.deleted).toBe(true);
  });
});