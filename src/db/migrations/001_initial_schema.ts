import type { Migration } from "./types.js";

const migration: Migration = {
  version: 1,
  name: "initial_schema",
  sql: `
      CREATE TABLE IF NOT EXISTS _migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT ({now})
      );

      CREATE TABLE IF NOT EXISTS decisions (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        agent TEXT NOT NULL CHECK (agent IN ('doom', 'kangbot')),
        symbol TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('buy', 'sell', 'hold')),
        quantity REAL NOT NULL,
        price_at_decision REAL NOT NULL,
        rationale TEXT NOT NULL,
        confidence INTEGER NOT NULL CHECK (confidence >= 1 AND confidence <= 10),
        mode TEXT NOT NULL CHECK (mode IN ('sim', 'live')),
        market_context TEXT,
        created_at TEXT NOT NULL DEFAULT ({now})
      );

      CREATE INDEX IF NOT EXISTS idx_decisions_agent ON decisions(agent);
      CREATE INDEX IF NOT EXISTS idx_decisions_symbol ON decisions(symbol);
      CREATE INDEX IF NOT EXISTS idx_decisions_timestamp ON decisions(timestamp);
    `,
};

export default migration;
