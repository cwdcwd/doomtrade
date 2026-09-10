/**
 * Settings store — persisted key/value settings on the `settings` table
 * (migration 009), accessed through the existing storage layer
 * (DbClient: sql.js in local dev, Postgres in production).
 *
 * The single current consumer is the management dashboard's risk-limits
 * form. Values are stored as JSON text so the shape can evolve without
 * further migrations.
 *
 * Persistence follows the repo's established pattern:
 *  - Postgres (DATABASE_URL set): rows persist immediately.
 *  - SQLite (sql.js): the database is loaded from DATABASE_PATH at boot
 *    and flushed to disk on SIGINT/SIGTERM (see persistDatabase() calls
 *    in src/index.ts) — exactly like every other table in this repo.
 */

import type { Database } from "./database.js";
import { execGet, execRun } from "./database.js";

/** Load a setting by key, JSON.parse'd. null when absent or unreadable. */
export async function getSetting<T>(db: Database, key: string): Promise<T | null> {
  try {
    const row = await execGet<{ value: string }>(db, "SELECT value FROM settings WHERE key = ?", [
      key,
    ]);
    if (!row?.value) return null;
    return JSON.parse(row.value) as T;
  } catch {
    // Missing table (pre-migration DB) or unreadable row — treat as unset.
    return null;
  }
}

/** Upsert a setting by key, JSON.stringify'd. */
export async function setSetting(db: Database, key: string, value: unknown): Promise<void> {
  const existing = await execGet<{ key: string }>(db, "SELECT key FROM settings WHERE key = ?", [
    key,
  ]);
  if (existing) {
    await execRun(db, "UPDATE settings SET value = ?, updated_at = {now} WHERE key = ?", [
      JSON.stringify(value),
      key,
    ]);
  } else {
    await execRun(db, "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, {now})", [
      key,
      JSON.stringify(value),
    ]);
  }
}

/** Settings keys used by DoomTrade. */
export const SETTING_KEYS = {
  riskLimits: "risk_limits",
} as const;