/**
 * index.ts — Entry point. Starts the Express server with all API routes.
 *
 * DoomTrade is an agent-managed trading platform. This file boots the
 * server, initializes the database, executors, and trade engine,
 * and mounts the API routes.
 */

import express from "express";
import { loadConfig } from "./config.js";
import { openDatabase, persistDatabase } from "./db/database.js";
import { DecisionStore } from "./decision/decision-store.js";
import { SimulatedExchange } from "./executor/simulated.js";
import { TradeEngine } from "./engine/trade-engine.js";
import { Portfolio } from "./portfolio/portfolio.js";
import { createApiRouter } from "./api/routes.js";

async function main() {
  const config = loadConfig();

  // Initialize database
  const db = await openDatabase({ path: config.databasePath });

  // Initialize services
  const decisionStore = new DecisionStore(db);
  const executor = new SimulatedExchange(db, {
    initialCash: config.simStartingBalance,
    feeRate: config.simFeePct / 100,
  });
  const tradeEngine = new TradeEngine(db, executor, config);
  const portfolio = new Portfolio(db, executor, {
    mode: config.tradeMode,
    initialCapital: config.simStartingBalance,
  });

  // App state (mutable for mode toggle)
  const state = {
    decisionStore,
    tradeEngine,
    portfolio,
    config,
    currentMode: config.tradeMode as "sim" | "live",
    modeChangedAt: Date.now(),
  };

  const app = express();

  // Middleware
  app.use(express.json());

  // Health check — used by Railway for deployment healthchecks
  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      mode: state.currentMode,
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
    if (config.databasePath !== ":memory:") {
      persistDatabase(db, config.databasePath);
    }
    console.log("\nShutting down...");
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    if (config.databasePath !== ":memory:") {
      persistDatabase(db, config.databasePath);
    }
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Failed to start DoomTrade:", err);
  process.exit(1);
});