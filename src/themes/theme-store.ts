/**
 * ThemeStore — CRUD operations for theme configurations.
 *
 * Persists theme configs to the `themes` table. Schedule and params
 * are stored as JSON strings. The `enabled` field uses 0/1 integer
 * in the DB and boolean in TypeScript.
 */

import { randomUUID } from "node:crypto";
import type { Database } from "../db/database.js";
import { execAll, execGet, execRun, convertPlaceholders } from "../db/database.js";
import type { ThemeConfig, ThemeSchedule } from "./theme.js";

interface ThemeRow {
  id: string;
  name: string;
  strategy: string;
  mode: string;
  schedule: string;
  max_allocation_pct: number;
  max_total_allocation_pct: number;
  max_positions: number;
  allocated_capital: number;
  params: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

function rowToConfig(row: ThemeRow): ThemeConfig {
  return {
    id: row.id,
    name: row.name,
    strategy: row.strategy,
    mode: row.mode as "sim" | "live",
    schedule: JSON.parse(row.schedule) as ThemeSchedule,
    maxAllocationPct: row.max_allocation_pct,
    maxTotalAllocationPct: row.max_total_allocation_pct,
    maxPositions: row.max_positions,
    allocatedCapital: row.allocated_capital,
    params: JSON.parse(row.params) as Record<string, unknown>,
    enabled: row.enabled === 1,
  };
}

export interface CreateThemeInput {
  name: string;
  strategy: string;
  mode?: "sim" | "live";
  schedule: ThemeSchedule;
  maxAllocationPct?: number;
  maxTotalAllocationPct?: number;
  maxPositions?: number;
  allocatedCapital?: number;
  params?: Record<string, unknown>;
  enabled?: boolean;
}

export class ThemeStore {
  constructor(private db: Database) {}

  async create(input: CreateThemeInput): Promise<ThemeConfig> {
    const id = randomUUID();
    const mode = input.mode ?? "sim";
    const maxAllocationPct = input.maxAllocationPct ?? 5;
    const maxTotalAllocationPct = input.maxTotalAllocationPct ?? 40;
    const maxPositions = input.maxPositions ?? 10;
    const allocatedCapital = input.allocatedCapital ?? 0;
    const params = JSON.stringify(input.params ?? {});
    const schedule = JSON.stringify(input.schedule);
    const enabled = input.enabled !== false ? 1 : 0;

    const sql = convertPlaceholders(
      `INSERT INTO themes
        (id, name, strategy, mode, schedule, max_allocation_pct,
         max_total_allocation_pct, max_positions, allocated_capital,
         params, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      this.db.backend,
    );

    await execRun(this.db, sql, [
      id, input.name, input.strategy, mode, schedule,
      maxAllocationPct, maxTotalAllocationPct, maxPositions,
      allocatedCapital, params, enabled,
    ]);

    const config = await this.getById(id);
    if (!config) throw new Error("Failed to create theme");
    return config;
  }

  async getById(id: string): Promise<ThemeConfig | null> {
    const sql = convertPlaceholders(
      "SELECT * FROM themes WHERE id = ?",
      this.db.backend,
    );
    const row = await execGet<ThemeRow>(this.db, sql, [id]);
    return row ? rowToConfig(row) : null;
  }

  async list(filter?: {
    strategy?: string;
    enabled?: boolean;
  }): Promise<ThemeConfig[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter?.strategy) {
      conditions.push("strategy = ?");
      params.push(filter.strategy);
    }
    if (filter?.enabled !== undefined) {
      conditions.push("enabled = ?");
      params.push(filter.enabled ? 1 : 0);
    }

    let sql = "SELECT * FROM themes";
    if (conditions.length > 0) {
      sql += " WHERE " + conditions.join(" AND ");
    }
    sql += " ORDER BY created_at DESC";

    const rows = await execAll<ThemeRow>(
      this.db,
      convertPlaceholders(sql, this.db.backend),
      params,
    );
    return rows.map(rowToConfig);
  }

  async update(id: string, updates: Partial<CreateThemeInput>): Promise<ThemeConfig | null> {
    const setClauses: string[] = [];
    const params: unknown[] = [];

    if (updates.name !== undefined) {
      setClauses.push("name = ?");
      params.push(updates.name);
    }
    if (updates.strategy !== undefined) {
      setClauses.push("strategy = ?");
      params.push(updates.strategy);
    }
    if (updates.mode !== undefined) {
      setClauses.push("mode = ?");
      params.push(updates.mode);
    }
    if (updates.schedule !== undefined) {
      setClauses.push("schedule = ?");
      params.push(JSON.stringify(updates.schedule));
    }
    if (updates.maxAllocationPct !== undefined) {
      setClauses.push("max_allocation_pct = ?");
      params.push(updates.maxAllocationPct);
    }
    if (updates.maxTotalAllocationPct !== undefined) {
      setClauses.push("max_total_allocation_pct = ?");
      params.push(updates.maxTotalAllocationPct);
    }
    if (updates.maxPositions !== undefined) {
      setClauses.push("max_positions = ?");
      params.push(updates.maxPositions);
    }
    if (updates.allocatedCapital !== undefined) {
      setClauses.push("allocated_capital = ?");
      params.push(updates.allocatedCapital);
    }
    if (updates.params !== undefined) {
      setClauses.push("params = ?");
      params.push(JSON.stringify(updates.params));
    }
    if (updates.enabled !== undefined) {
      setClauses.push("enabled = ?");
      params.push(updates.enabled ? 1 : 0);
    }

    if (setClauses.length === 0) {
      return this.getById(id);
    }

    setClauses.push("updated_at = {now}");
    params.push(id);

    const sql = convertPlaceholders(
      `UPDATE themes SET ${setClauses.join(", ")} WHERE id = ?`,
      this.db.backend,
    );
    await execRun(this.db, sql, params);

    return this.getById(id);
  }

  async delete(id: string): Promise<boolean> {
    const sql = convertPlaceholders(
      "DELETE FROM themes WHERE id = ?",
      this.db.backend,
    );
    await execRun(this.db, sql, [id]);
    const check = await this.getById(id);
    return check === null;
  }

  async listEnabled(): Promise<ThemeConfig[]> {
    return this.list({ enabled: true });
  }

  // ── Signal dedup ──────────────────────────────────────────────

  /**
   * Check if a signal has already been processed for a theme.
   * Returns true if the signal_hash already exists.
   */
  async isSignalProcessed(themeId: string, signalHash: string): Promise<boolean> {
    const sql = convertPlaceholders(
      "SELECT 1 FROM theme_signals WHERE theme_id = ? AND signal_hash = ?",
      this.db.backend,
    );
    const row = await execGet<{ "1": number }>(this.db, sql, [themeId, signalHash]);
    return row !== null;
  }

  /**
   * Record a processed signal for dedup.
   */
  async recordSignal(
    themeId: string,
    signalHash: string,
    symbol: string,
    action: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const sql = convertPlaceholders(
      `INSERT INTO theme_signals (id, theme_id, signal_hash, symbol, action, metadata)
       VALUES (?, ?, ?, ?, ?, ?)`,
      this.db.backend,
    );
    await execRun(this.db, sql, [
      randomUUID(),
      themeId,
      signalHash,
      symbol,
      action,
      metadata ? JSON.stringify(metadata) : null,
    ]);
  }

  // ── Evaluation records ────────────────────────────────────────

  /**
   * Record an evaluation run.
   */
  async recordEvaluation(
    themeId: string,
    result: { signalsCount: number; decisionsCount: number; tradesCount: number; errors: string[] },
  ): Promise<string> {
    const id = randomUUID();
    const timestamp = new Date().toISOString();
    const sql = convertPlaceholders(
      `INSERT INTO theme_evaluations (id, theme_id, timestamp, signals_count, decisions_count, trades_count, errors)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      this.db.backend,
    );
    await execRun(this.db, sql, [
      id, themeId, timestamp,
      result.signalsCount, result.decisionsCount, result.tradesCount,
      result.errors.length > 0 ? JSON.stringify(result.errors) : null,
    ]);
    return id;
  }

  /**
   * List evaluation history for a theme.
   */
  async listEvaluations(themeId: string, limit = 50): Promise<Array<{
    id: string;
    themeId: string;
    timestamp: string;
    signalsCount: number;
    decisionsCount: number;
    tradesCount: number;
    errors: string[] | null;
  }>> {
    const sql = convertPlaceholders(
      "SELECT * FROM theme_evaluations WHERE theme_id = ? ORDER BY timestamp DESC LIMIT ?",
      this.db.backend,
    );
    const rows = await execAll<{
      id: string;
      theme_id: string;
      timestamp: string;
      signals_count: number;
      decisions_count: number;
      trades_count: number;
      errors: string | null;
    }>(this.db, sql, [themeId, limit]);

    return rows.map((r) => ({
      id: r.id,
      themeId: r.theme_id,
      timestamp: r.timestamp,
      signalsCount: r.signals_count,
      decisionsCount: r.decisions_count,
      tradesCount: r.trades_count,
      errors: r.errors ? JSON.parse(r.errors) : null,
    }));
  }
}