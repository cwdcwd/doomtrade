import type { Migration } from "./types.js";

const migration: Migration = {
  version: 4,
  name: "portfolio_history",
  sql: `
      CREATE TABLE IF NOT EXISTS portfolio_history (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        equity REAL NOT NULL,
        cash REAL NOT NULL,
        positions_value REAL NOT NULL,
        unrealized_pnl REAL NOT NULL DEFAULT 0,
        realized_pnl REAL NOT NULL DEFAULT 0,
        mode TEXT NOT NULL CHECK (mode IN ('sim', 'live'))
      );

      CREATE INDEX IF NOT EXISTS idx_portfolio_history_timestamp
        ON portfolio_history(timestamp);
    `,
};

export default migration;
