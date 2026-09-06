/**
 * index.ts — Entry point. Starts the Express server with health endpoint.
 *
 * DoomTrade is an agent-managed trading platform. This file boots the server
 * and mounts the API routes once they're implemented.
 */

import express from "express";
import { loadConfig, type Config } from "./config.js";

const config = loadConfig();

const app = express();

// Middleware
app.use(express.json());

// Health check — used by Railway for deployment healthchecks
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    mode: config.tradeMode,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// API routes will be mounted here as modules are implemented
// app.use("/api", apiRouter);

app.listen(config.port, () => {
  console.log(`DoomTrade running on port ${config.port}`);
  console.log(`Mode: ${config.tradeMode.toUpperCase()}`);
  console.log(`Database: ${config.databasePath}`);
  if (config.tradeMode === "live") {
    console.log("⚠️  LIVE TRADING MODE — real orders will be placed");
  } else {
    console.log("Sim mode — paper trading with $" + config.simStartingBalance.toLocaleString() + " virtual balance");
  }
});