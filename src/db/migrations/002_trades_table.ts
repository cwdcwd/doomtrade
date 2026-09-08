import type { Migration } from "./types.js";

const migration: Migration = {
  version: 2,
  name: "trades_table",
  sql: `
      CREATE TABLE IF NOT EXISTS trades (
        id TEXT PRIMARY KEY,
        decision_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
        quantity REAL NOT NULL,
        order_type TEXT NOT NULL CHECK (order_type IN ('market', 'limit', 'stop')),
        fill_price REAL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'filled', 'cancelled', 'rejected')),
        fee REAL NOT NULL DEFAULT 0,
        realized_pnl REAL NOT NULL DEFAULT 0,
        mode TEXT NOT NULL CHECK (mode IN ('sim', 'live')),
        executor TEXT NOT NULL CHECK (executor IN ('simulated', 'alpaca', 'ccxt')),
        error TEXT,
        created_at TEXT NOT NULL DEFAULT ({now}),
        FOREIGN KEY (decision_id) REFERENCES decisions(id)
      );

      CREATE INDEX IF NOT EXISTS idx_trades_decision_id ON trades(decision_id);
      CREATE INDEX IF NOT EXISTS idx_trades_symbol ON trades(symbol);
      CREATE INDEX IF NOT EXISTS idx_trades_timestamp ON trades(timestamp);
    `,
};

export default migration;
