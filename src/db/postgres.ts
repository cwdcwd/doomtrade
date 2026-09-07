/**
 * Postgres adapter — implements the `DbClient` interface using `pg`.
 *
 * Used when `DATABASE_URL` is set. All methods are async.
 * Placeholder conversion from `?` to `$1, $2, ...` is handled here.
 */

import { Pool, type PoolClient } from "pg";
import type { DbClient, DatabaseConfig } from "./database.js";
import { convertPlaceholders, runMigrations } from "./database.js";

/**
 * Internal wrapper that adapts a pg PoolClient to the DbClient interface.
 */
class PostgresClient implements DbClient {
  readonly backend = "postgres" as const;
  private pool: Pool;
  private client: PoolClient;
  private verbose: boolean;

  constructor(pool: Pool, client: PoolClient, verbose: boolean) {
    this.pool = pool;
    this.client = client;
    this.verbose = verbose;
  }

  async run(sql: string, params: unknown[] = []): Promise<void> {
    const pgSql = convertPlaceholders(sql, "postgres");
    if (this.verbose) console.log("[postgres] run:", pgSql, params);
    await this.client.query(pgSql, params as unknown[]);
  }

  async exec(sql: string): Promise<void> {
    if (this.verbose) console.log("[postgres] exec:", sql);
    await this.client.query(sql);
  }

  async all<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const pgSql = convertPlaceholders(sql, "postgres");
    if (this.verbose) console.log("[postgres] all:", pgSql, params);
    const result = await this.client.query(pgSql, params as unknown[]);
    return result.rows as T[];
  }

  async get<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | null> {
    const pgSql = convertPlaceholders(sql, "postgres");
    if (this.verbose) console.log("[postgres] get:", pgSql, params);
    const result = await this.client.query(pgSql, params as unknown[]);
    return result.rows[0] as T | null ?? null;
  }
}

/**
 * Open a Postgres connection and run migrations.
 */
export async function openPostgresDatabase(
  config: { url: string; verbose?: boolean },
): Promise<DbClient> {
  const pool = new Pool({ connectionString: config.url });
  const client = await pool.connect();

  const dbClient = new PostgresClient(pool, client, config.verbose ?? false);
  await runMigrations(dbClient);
  return dbClient;
}

/**
 * Close the Postgres connection (release client + end pool).
 */
export async function closePostgresDatabase(db: DbClient): Promise<void> {
  if (db.backend !== "postgres") return;
  const pg = db as PostgresClient;
  // Access private fields via a typed cast
  const pgInternal = pg as unknown as { pool: Pool; client: PoolClient };
  pgInternal.client.release();
  await pgInternal.pool.end();
}