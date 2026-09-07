/**
 * Database abstraction layer — dual-mode support.
 *
 * Exports a `DbClient` interface that both SQLite (sql.js, local dev) and
 * Postgres (pg, production) implement. All query helpers are async so
 * they work with both backends.
 *
 * SQLite mode is selected when `DATABASE_URL` is not set (or empty).
 * Postgres mode is selected when `DATABASE_URL` is a non-empty string.
 *
 * The factory `openDatabase()` inspects the config and returns the
 * appropriate implementation.
 */

import type { Database as SqlJsDatabase } from "sql.js";

// ── Public types ───────────────────────────────────────────────

/**
 * Abstract database client interface.
 *
 * Both the SQLite adapter and the Postgres adapter implement this.
 * Consumers should only depend on this interface, never on the
 * concrete sql.js or pg types.
 */
export interface DbClient {
  /** Backend identifier — "sqlite" or "postgres". */
  readonly backend: "sqlite" | "postgres";

  /**
   * Run a parameterised statement (INSERT / UPDATE / DELETE / DDL).
   * Resolves when the statement has been executed.
   */
  run(sql: string, params?: unknown[]): Promise<void>;

  /**
   * Execute one or more statements without parameters (DDL, batch).
   * Used internally by the migration runner.
   */
  exec(sql: string): Promise<void>;

  /**
   * Run a query and return all matching rows.
   */
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;

  /**
   * Run a query and return the first matching row, or null.
   */
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null>;
}

export interface DatabaseConfig {
  /** SQLite file path.  ":memory:" = in-memory. Ignored in Postgres mode. */
  path: string;
  /** Postgres connection string.  Empty string = use SQLite. */
  url: string;
  /** Enable verbose SQL logging */
  verbose?: boolean;
}

// ── Re-exports for consumers ───────────────────────────────────

/**
 * Backwards-compatible `Database` type alias.
 * All consumers import `type { Database }` — this resolves to the
 * abstract interface so code works with either backend.
 */
export type Database = DbClient;

// ── Migration definitions ──────────────────────────────────────

/**
 * Migrations applied in order. Each must be idempotent.
 * Track applied migrations in the _migrations table.
 *
 * SQLite uses `datetime('now')`; Postgres uses `NOW()`.
 * The `dialect` helper below converts these.
 */
const MIGRATIONS: { version: number; name: string; sql: string }[] = [
  {
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
        created_at TEXT NOT NULL DEFAULT ({now}),
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

/** Convert `{now}` placeholder to the dialect-appropriate expression. */
function dialectSql(sql: string, backend: "sqlite" | "postgres"): string {
  if (backend === "postgres") {
    return sql.replace(/\{now\}/g, "NOW()");
  }
  return sql.replace(/\{now\}/g, "datetime('now')");
}

// ── Factory ────────────────────────────────────────────────────

/**
 * Open a database and run all pending migrations.
 *
 * - If `config.url` is a non-empty string → Postgres mode (pg).
 * - Otherwise → SQLite mode (sql.js, in-memory or file-backed).
 *
 * Returns a `DbClient` that abstracts the backend.
 */
export async function openDatabase(
  config: Partial<DatabaseConfig> = {},
): Promise<DbClient> {
  const url = config.url ?? "";

  if (url) {
    const { openPostgresDatabase } = await import("./postgres.js");
    return openPostgresDatabase({ url, verbose: config.verbose });
  }

  return openSqliteDatabase({ path: config.path ?? ":memory:", verbose: config.verbose });
}

/**
 * Persist the in-memory database to a file on disk.
 * No-op for Postgres (Postgres persists immediately).
 */
export async function persistDatabase(db: DbClient, filePath: string): Promise<void> {
  if (db.backend !== "sqlite") return;
  const sqlite = db as SqliteClient;
  const data = sqlite.raw.export();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, Buffer.from(data));
}

/**
 * Close the database safely.
 */
export async function closeDatabase(db: DbClient): Promise<void> {
  if (db.backend === "sqlite") {
    const sqlite = db as SqliteClient;
    sqlite.raw.close();
  } else {
    const { closePostgresDatabase } = await import("./postgres.js");
    await closePostgresDatabase(db);
  }
}

/**
 * Run pending migrations in version order. Idempotent — already-applied
 * migrations are skipped.
 */
export async function runMigrations(db: DbClient): Promise<void> {
  // Ensure _migrations table exists before reading it
  await db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (${db.backend === "postgres" ? "NOW()" : "datetime('now')"})
    );
  `);

  const rows = await db.all<{ version: number }>(
    "SELECT version FROM _migrations ORDER BY version",
  );
  const appliedVersions = new Set(rows.map((r) => r.version));

  for (const migration of MIGRATIONS) {
    if (appliedVersions.has(migration.version)) continue;

    await db.run("BEGIN");
    try {
      await db.exec(dialectSql(migration.sql, db.backend));
      await db.run(
        "INSERT INTO _migrations (version, name) VALUES ($1, $2)",
        db.backend === "postgres"
          ? [migration.version, migration.name]
          : [migration.version, migration.name],
      );
      await db.run("COMMIT");
    } catch (err) {
      await db.run("ROLLBACK").catch(() => {});
      throw err;
    }
  }
}

// ── SQLite implementation ───────────────────────────────────────

import initSqlJs from "sql.js";
import fs from "node:fs";
import path from "node:path";

/**
 * Internal wrapper that adapts a sql.js Database to the DbClient interface.
 * Not exported directly — consumers use the factory.
 */
class SqliteClient implements DbClient {
  readonly backend = "sqlite" as const;
  private db: SqlJsDatabase;
  private verbose: boolean;

  constructor(db: SqlJsDatabase, verbose: boolean) {
    this.db = db;
    this.verbose = verbose;
  }

  /** Access the raw sql.js handle (used by persist/close helpers). */
  get raw(): SqlJsDatabase {
    return this.db;
  }

  async run(sql: string, params: unknown[] = []): Promise<void> {
    if (this.verbose) console.log("[sqlite] run:", sql, params);
    this.db.run(sql.replace(/\{now\}/g, "datetime('now')"), params as (string | number | null)[]);
  }

  async exec(sql: string): Promise<void> {
    if (this.verbose) console.log("[sqlite] exec:", sql);
    this.db.exec(sql.replace(/\{now\}/g, "datetime('now')"));
  }

  async all<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    if (this.verbose) console.log("[sqlite] all:", sql, params);
    const stmt = this.db.prepare(sql.replace(/\{now\}/g, "datetime('now')"));
    if (params.length > 0) {
      stmt.bind(params as (string | number | null)[]);
    }
    const rows: T[] = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject() as T);
    }
    stmt.free();
    return rows;
  }

  async get<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | null> {
    if (this.verbose) console.log("[sqlite] get:", sql, params);
    const stmt = this.db.prepare(sql.replace(/\{now\}/g, "datetime('now')"));
    if (params.length > 0) {
      stmt.bind(params as (string | number | null)[]);
    }
    let row: T | null = null;
    if (stmt.step()) {
      row = stmt.getAsObject() as T;
    }
    stmt.free();
    return row;
  }
}

/**
 * Open a SQLite database (sql.js) and run migrations.
 */
async function openSqliteDatabase(opts: { path: string; verbose?: boolean }): Promise<DbClient> {
  const SQL = await initSqlJs();
  let db: SqlJsDatabase;

  if (opts.path !== ":memory:" && fs.existsSync(opts.path)) {
    const data = new Uint8Array(fs.readFileSync(opts.path));
    db = new SQL.Database(data);
  } else {
    db = new SQL.Database();
  }

  const client = new SqliteClient(db, opts.verbose ?? false);
  await runMigrations(client);
  return client;
}

// ── Query helpers (async, work with any DbClient) ─────────────

/**
 * Execute a statement (INSERT/UPDATE/DELETE) with optional params.
 */
export async function execRun(
  db: DbClient,
  sql: string,
  params: unknown[] = [],
): Promise<void> {
  await db.run(sql, params);
}

/**
 * Run a query and return all matching rows as objects.
 */
export async function execAll<T = Record<string, unknown>>(
  db: DbClient,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  return db.all<T>(sql, params);
}

/**
 * Run a query and return the first matching row as an object, or null.
 */
export async function execGet<T = Record<string, unknown>>(
  db: DbClient,
  sql: string,
  params: unknown[] = [],
): Promise<T | null> {
  return db.get<T>(sql, params);
}

// ── Placeholder conversion utility ─────────────────────────────

/**
 * Convert `?` placeholders to Postgres-style `$1, $2, ...` placeholders.
 * For SQLite this is a no-op (sql.js accepts `?`).
 *
 * Exported for consumers that build raw SQL with `?` placeholders and
 * need to adapt them for the active backend.
 */
export function convertPlaceholders(sql: string, backend: "sqlite" | "postgres"): string {
  if (backend !== "postgres") return sql;

  // Replace `?` with `$n` but skip `?` inside string literals.
  let result = "";
  let paramIdx = 1;
  let inString = false;
  let stringChar = "";

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];

    if (inString) {
      result += ch;
      if (ch === stringChar) {
        inString = false;
      }
    } else if (ch === "'" || ch === '"') {
      inString = true;
      stringChar = ch;
      result += ch;
    } else if (ch === "?") {
      result += `$${paramIdx++}`;
    } else {
      result += ch;
    }
  }

  return result;
}