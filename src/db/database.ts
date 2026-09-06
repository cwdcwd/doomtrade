/**
 * SQLite connection setup + migration runner.
 *
 * Uses better-sqlite3 for synchronous, fast, file-based persistence.
 * Migrations are idempotent — safe to run on every startup.
 */

import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";

export interface DatabaseConfig {
  path: string;
  /** Enable WAL mode for better concurrent read performance */
  wal?: boolean;
  /** Enable verbose logging for debugging */
  verbose?: boolean;
}

const DEFAULT_CONFIG: DatabaseConfig = {
  path: ":memory:",
  wal: false,
  verbose: false,
};

/**
 * Migrations applied in order. Each must be idempotent.
 * Track applied migrations in the _migrations table.
 */
const MIGRATIONS: { version: number; name: string; sql: string }[] = [
  {
    version: 1,
    name: "initial_schema",
    sql: `
      CREATE TABLE IF NOT EXISTS _migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
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
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_decisions_agent ON decisions(agent);
      CREATE INDEX IF NOT EXISTS idx_decisions_symbol ON decisions(symbol);
      CREATE INDEX IF NOT EXISTS idx_decisions_timestamp ON decisions(timestamp);
    `,
  },
  {
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
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (decision_id) REFERENCES decisions(id)
      );

      CREATE INDEX IF NOT EXISTS idx_trades_decision_id ON trades(decision_id);
      CREATE INDEX IF NOT EXISTS idx_trades_symbol ON trades(symbol);
      CREATE INDEX IF NOT EXISTS idx_trades_timestamp ON trades(timestamp);
    `,
  },
  {
    version: 3,
    name: "sim_positions_table",
    sql: `
      CREATE TABLE IF NOT EXISTS sim_positions (
        symbol TEXT PRIMARY KEY,
        quantity REAL NOT NULL,
        avg_entry_price REAL NOT NULL,
        side TEXT NOT NULL CHECK (side IN ('long', 'short')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS sim_balance (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        cash REAL NOT NULL,
        initial_cash REAL NOT NULL,
        peak_equity REAL NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS sim_orders (
        id TEXT PRIMARY KEY,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
        order_type TEXT NOT NULL CHECK (order_type IN ('market', 'limit')),
        quantity REAL NOT NULL,
        limit_price REAL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'filled', 'cancelled')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        filled_at TEXT
      );
    `,
  },
];

/**
 * Open a SQLite database and run all pending migrations.
 */
export function openDatabase(config: Partial<DatabaseConfig> = {}): DatabaseType {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const db = new Database(cfg.path);

  if (cfg.verbose) {
    // @ts-expect-error — better-sqlite3 trace event exists at runtime
    db.on("trace", (sql: string) => console.debug(`[sqlite] ${sql}`));
  }

  if (cfg.wal && cfg.path !== ":memory:") {
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
  } else {
    db.pragma("foreign_keys = ON");
  }

  runMigrations(db);
  return db;
}

/**
 * Run pending migrations in version order. Idempotent — already-applied
 * migrations are skipped.
 */
export function runMigrations(db: DatabaseType): void {
  // Ensure _migrations table exists before reading it
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const applied = db
    .prepare("SELECT version FROM _migrations ORDER BY version")
    .all() as { version: number }[];

  const appliedVersions = new Set(applied.map((m) => m.version));

  const insertMigration = db.prepare(
    "INSERT INTO _migrations (version, name) VALUES (?, ?)",
  );

  for (const migration of MIGRATIONS) {
    if (appliedVersions.has(migration.version)) continue;
    const tx = db.transaction(() => {
      db.exec(migration.sql);
      insertMigration.run(migration.version, migration.name);
    });
    tx();
  }
}

/**
 * Close the database safely.
 */
export function closeDatabase(db: DatabaseType): void {
  if (db.open) {
    db.close();
  }
}

export type { DatabaseType };