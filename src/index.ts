/**
 * index.ts — Entry point. Boots the DoomTrade server.
 *
 * Thin by design (fleet-ops-ofe): all app construction lives in the
 * exported, testable buildServer() (src/server.ts). This file owns only
 * the side-effectful lifecycle: open the database, build the server,
 * start background jobs, listen, and shut down cleanly on signals.
 */

import { loadConfig } from "./config.js";
import { openDatabase, persistDatabase, closeDatabase } from "./db/database.js";
import { buildServer } from "./server.js";

async function main() {
  const config = loadConfig();

  // Initialize database — Postgres if DATABASE_URL is set, SQLite otherwise
  const db = await openDatabase({ path: config.databasePath, url: config.databaseUrl });

  // Build the full app (services, middleware, routes). buildServer also
  // applies persisted risk limits to the shared config object.
  const { app, state, themeRunner, priceCache } = await buildServer(config, db);

  // Start all enabled themes on boot
  await themeRunner.startAll();

  // Start the background price refresher
  priceCache.start();

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

  // Persist database on shutdown. Both signals run the same cleanup:
  // stop themes first (clears their interval timers), then flush the
  // SQLite file (Postgres persists immediately), then exit.
  const shutdown = (signal: string) => {
    themeRunner.stopAll();
    if (config.databaseUrl) {
      closeDatabase(db);
    } else if (config.databasePath !== ":memory:") {
      persistDatabase(db, config.databasePath);
    }
    console.log(`\nShutting down (${signal})...`);
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("Failed to start DoomTrade:", err);
  process.exit(1);
});
