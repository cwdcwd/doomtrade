import type { Migration } from "./types.js";

const migration: Migration = {
  version: 9,
  name: "settings",
  // Generic SQL — works on both SQLite (sql.js) and Postgres:
  // TEXT/REAL are accepted by Postgres, {now} is expanded per-dialect
  // by the migration runner (datetime('now') / NOW()), and there are no
  // placeholders in DDL. This is the same shape as migrations 001-007.
  sql: `
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT ({now})
      );
    `,
};
export default migration;