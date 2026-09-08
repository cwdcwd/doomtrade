import type { Migration } from "./types.js";

const migration: Migration = {
  version: 3,
  name: "sim_tables",
  sql: `
      CREATE TABLE IF NOT EXISTS sim_positions (
        symbol TEXT PRIMARY KEY,
        quantity REAL NOT NULL,
        avg_entry_price REAL NOT NULL,
        side TEXT NOT NULL CHECK (side IN ('long', 'short')),
        updated_at TEXT NOT NULL DEFAULT ({now})
      );

      CREATE TABLE IF NOT EXISTS sim_balance (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        cash REAL NOT NULL,
        initial_cash REAL NOT NULL,
        peak_equity REAL NOT NULL,
        updated_at TEXT NOT NULL DEFAULT ({now})
      );

      CREATE TABLE IF NOT EXISTS sim_orders (
        id TEXT PRIMARY KEY,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
        order_type TEXT NOT NULL CHECK (order_type IN ('market', 'limit')),
        quantity REAL NOT NULL,
        limit_price REAL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'filled', 'cancelled')),
        created_at TEXT NOT NULL DEFAULT ({now}),
        filled_at TEXT
      );
    `,
};

export default migration;
