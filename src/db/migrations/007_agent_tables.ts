import type { Migration } from "./types.js";

const migration: Migration = {
  version: 7,
  name: "agent_tables",
  sql: `
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        starting_balance REAL NOT NULL DEFAULT 100,
        strategy TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT ({now})
      );

      CREATE TABLE IF NOT EXISTS agent_balance (
        agent_id TEXT PRIMARY KEY,
        cash REAL NOT NULL,
        initial_cash REAL NOT NULL,
        peak_equity REAL NOT NULL,
        updated_at TEXT NOT NULL DEFAULT ({now})
      );

      CREATE TABLE IF NOT EXISTS agent_positions (
        agent_id TEXT NOT NULL,
        symbol TEXT NOT NULL,
        quantity REAL NOT NULL,
        avg_entry_price REAL NOT NULL,
        side TEXT NOT NULL DEFAULT 'long',
        updated_at TEXT NOT NULL DEFAULT ({now}),
        PRIMARY KEY (agent_id, symbol)
      );

      CREATE TABLE IF NOT EXISTS agent_orders (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        decision_id TEXT,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
        order_type TEXT NOT NULL CHECK (order_type IN ('market', 'limit', 'stop')),
        quantity REAL NOT NULL,
        fill_price REAL,
        fee REAL NOT NULL DEFAULT 0,
        realized_pnl REAL NOT NULL DEFAULT 0,
        status TEXT NOT NULL CHECK (status IN ('pending', 'filled', 'cancelled', 'rejected')),
        error TEXT,
        created_at TEXT NOT NULL DEFAULT ({now}),
        filled_at TEXT
      );

      CREATE TABLE IF NOT EXISTS agent_portfolio_history (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        timestamp TEXT NOT NULL DEFAULT ({now}),
        equity REAL NOT NULL,
        cash REAL NOT NULL,
        positions_value REAL NOT NULL,
        unrealized_pnl REAL NOT NULL DEFAULT 0,
        realized_pnl REAL NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_agent_positions_agent ON agent_positions(agent_id);
      CREATE INDEX IF NOT EXISTS idx_agent_orders_agent ON agent_orders(agent_id);
      CREATE INDEX IF NOT EXISTS idx_agent_orders_symbol ON agent_orders(symbol);
      CREATE INDEX IF NOT EXISTS idx_agent_portfolio_history_agent ON agent_portfolio_history(agent_id);
    `,
};

export default migration;
