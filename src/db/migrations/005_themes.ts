import type { Migration } from "./types.js";

const migration: Migration = {
  version: 5,
  name: "themes",
  sql: `
      CREATE TABLE IF NOT EXISTS themes (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        strategy TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'sim' CHECK (mode IN ('sim', 'live')),
        schedule TEXT NOT NULL,
        max_allocation_pct REAL NOT NULL DEFAULT 5,
        max_total_allocation_pct REAL NOT NULL DEFAULT 40,
        max_positions INTEGER NOT NULL DEFAULT 10,
        allocated_capital REAL NOT NULL DEFAULT 0,
        params TEXT NOT NULL DEFAULT '{}',
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT ({now}),
        updated_at TEXT NOT NULL DEFAULT ({now})
      );

      CREATE TABLE IF NOT EXISTS theme_signals (
        id TEXT PRIMARY KEY,
        theme_id TEXT NOT NULL,
        signal_hash TEXT NOT NULL,
        symbol TEXT NOT NULL,
        action TEXT NOT NULL,
        metadata TEXT,
        processed_at TEXT NOT NULL DEFAULT ({now}),
        FOREIGN KEY (theme_id) REFERENCES themes(id),
        UNIQUE (theme_id, signal_hash)
      );

      CREATE INDEX IF NOT EXISTS idx_theme_signals_theme
        ON theme_signals(theme_id);

      CREATE TABLE IF NOT EXISTS theme_evaluations (
        id TEXT PRIMARY KEY,
        theme_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        signals_count INTEGER NOT NULL DEFAULT 0,
        decisions_count INTEGER NOT NULL DEFAULT 0,
        trades_count INTEGER NOT NULL DEFAULT 0,
        errors TEXT,
        FOREIGN KEY (theme_id) REFERENCES themes(id)
      );

      CREATE INDEX IF NOT EXISTS idx_theme_evaluations_theme
        ON theme_evaluations(theme_id);

      CREATE TABLE IF NOT EXISTS theme_subaccounts (
        theme_id TEXT PRIMARY KEY,
        balance REAL NOT NULL,
        peak_balance REAL NOT NULL,
        starting_balance REAL NOT NULL,
        FOREIGN KEY (theme_id) REFERENCES themes(id)
      );

      CREATE TABLE IF NOT EXISTS sim_sub_positions (
        theme_id TEXT NOT NULL,
        symbol TEXT NOT NULL,
        quantity REAL NOT NULL,
        avg_entry_price REAL NOT NULL,
        side TEXT NOT NULL CHECK (side IN ('long', 'short')),
        updated_at TEXT NOT NULL DEFAULT ({now}),
        PRIMARY KEY (theme_id, symbol),
        FOREIGN KEY (theme_id) REFERENCES themes(id)
      );

      CREATE TABLE IF NOT EXISTS sim_sub_orders (
        id TEXT PRIMARY KEY,
        theme_id TEXT NOT NULL,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
        order_type TEXT NOT NULL CHECK (order_type IN ('market', 'limit')),
        quantity REAL NOT NULL,
        limit_price REAL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'filled', 'cancelled')),
        created_at TEXT NOT NULL DEFAULT ({now}),
        filled_at TEXT,
        realized_pnl REAL NOT NULL DEFAULT 0,
        FOREIGN KEY (theme_id) REFERENCES themes(id)
      );
    `,
};

export default migration;
