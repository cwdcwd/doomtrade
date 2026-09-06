/**
 * SQLite connection setup + migration runner.
 *
 * Uses sql.js (WASM-based, pure JS — no native compilation needed).
 * The WASM initialization is async; all query execution after init is synchronous.
 * Persistence is manual: call persistDatabase() to write the in-memory DB to disk.
 */

import initSqlJs, { type Database as SqlJsDatabase, type Statement } from "sql.js";
import fs from "node:fs";
import path from "node:path";

export type Database = SqlJsDatabase;

export interface DatabaseConfig {
  /** File path for persistence. ":memory:" or undefined = in-memory only. */
  path: string;
  /** Enable verbose SQL logging */
  verbose?: boolean;
}

const DEFAULT_CONFIG: DatabaseConfig = {
  path: ":memory:",
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
    name: "sim_tables",
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
  {
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
  },
];

/**
 * Open a SQLite database and run all pending migrations.
 * Async because sql.js WASM initialization is async.
 */
export async function openDatabase(
  config: Partial<DatabaseConfig> = {},
): Promise<Database> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const SQL = await initSqlJs();

  let db: SqlJsDatabase;

  // Load from file if it exists, otherwise create empty in-memory DB
  if (cfg.path !== ":memory:" && fs.existsSync(cfg.path)) {
    const data = new Uint8Array(fs.readFileSync(cfg.path));
    db = new SQL.Database(data);
  } else {
    db = new SQL.Database();
  }

  if (cfg.verbose) {
    // sql.js doesn't have a trace event; we'd need to wrap methods.
    // Skipping for now — can be added via a proxy if needed.
  }

  runMigrations(db);
  return db;
}

/**
 * Run pending migrations in version order. Idempotent — already-applied
 * migrations are skipped.
 */
export function runMigrations(db: Database): void {
  // Ensure _migrations table exists before reading it
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const stmt = db.prepare("SELECT version FROM _migrations ORDER BY version");
  const appliedVersions = new Set<number>();
  while (stmt.step()) {
    appliedVersions.add(stmt.get()[0] as number);
  }
  stmt.free();

  for (const migration of MIGRATIONS) {
    if (appliedVersions.has(migration.version)) continue;

    db.run("BEGIN");
    try {
      db.exec(migration.sql);
      db.run("INSERT INTO _migrations (version, name) VALUES (?, ?)", [
        migration.version,
        migration.name,
      ]);
      db.run("COMMIT");
    } catch (err) {
      db.run("ROLLBACK");
      throw err;
    }
  }
}

/**
 * Persist the in-memory database to a file on disk.
 * Creates parent directories if they don't exist.
 */
export function persistDatabase(db: Database, filePath: string): void {
  const data = db.export();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, Buffer.from(data));
}

/**
 * Close the database safely.
 */
export function closeDatabase(db: Database): void {
  db.close();
}

// ── Query helpers ──────────────────────────────────────────────

/**
 * Execute a statement (INSERT/UPDATE/DELETE) with optional params.
 * Returns the database for chaining.
 */
export function execRun(
  db: Database,
  sql: string,
  params: (string | number | null)[] = [],
): void {
  db.run(sql, params);
}

/**
 * Run a query and return all matching rows as objects.
 */
export function execAll<T = Record<string, unknown>>(
  db: Database,
  sql: string,
  params: (string | number | null)[] = [],
): T[] {
  const stmt = db.prepare(sql);
  if (params.length > 0) {
    stmt.bind(params);
  }
  const rows: T[] = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject() as T);
  }
  stmt.free();
  return rows;
}

/**
 * Run a query and return the first matching row as an object, or null.
 */
export function execGet<T = Record<string, unknown>>(
  db: Database,
  sql: string,
  params: (string | number | null)[] = [],
): T | null {
  const stmt = db.prepare(sql);
  if (params.length > 0) {
    stmt.bind(params);
  }
  let row: T | null = null;
  if (stmt.step()) {
    row = stmt.getAsObject() as T;
  }
  stmt.free();
  return row;
}