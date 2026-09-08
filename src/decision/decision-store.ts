/**
 * Decision store — CRUD for the decision log.
 *
 * Append-only: create, getById, list. No update or delete operations.
 * Uses async query helpers for all database operations (works with both
 * SQLite and Postgres backends).
 */

import { randomUUID } from "node:crypto";
import type { Database } from "../db/database.js";
import { execAll, execGet, execRun } from "../db/database.js";
import {
  type CreateDecisionInput,
  type Decision,
  type DecisionFilter,
  type DecisionRow,
  CreateDecisionInputSchema,
  rowToDecision,
} from "./decision.js";

export class DecisionStore {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /**
   * Create a new decision. Validates input with Zod, generates id + timestamp.
   * Append-only — this is the only write operation.
   */
  async create(input: CreateDecisionInput): Promise<Decision> {
    const parsed = CreateDecisionInputSchema.parse(input);

    const id = randomUUID();
    const timestamp = new Date().toISOString();
    const marketContextJson = parsed.marketContext ? JSON.stringify(parsed.marketContext) : null;

    await execRun(
      this.db,
      `INSERT INTO decisions
         (id, timestamp, agent, symbol, action, quantity, price_at_decision,
          rationale, confidence, mode, market_context)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        timestamp,
        parsed.agent,
        parsed.symbol,
        parsed.action,
        parsed.quantity,
        parsed.priceAtDecision,
        parsed.rationale,
        parsed.confidence,
        parsed.mode,
        marketContextJson,
      ],
    );

    const row = await execGet<DecisionRow>(this.db, "SELECT * FROM decisions WHERE id = ?", [id]);

    return row ? rowToDecision(row) : this.create(parsed); // shouldn't happen
  }

  /**
   * Get a decision by ID. Returns null if not found.
   */
  async getById(id: string): Promise<Decision | null> {
    const row = await execGet<DecisionRow>(this.db, "SELECT * FROM decisions WHERE id = ?", [id]);

    return row ? rowToDecision(row) : null;
  }

  /**
   * List decisions with optional filters.
   * Supports filtering by agent, symbol, action, mode, and date range.
   * Returns most recent first.
   */
  async list(filter?: DecisionFilter): Promise<Decision[]> {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (filter?.agent) {
      conditions.push("agent = ?");
      params.push(filter.agent);
    }
    if (filter?.symbol) {
      conditions.push("symbol = ?");
      params.push(filter.symbol);
    }
    if (filter?.action) {
      conditions.push("action = ?");
      params.push(filter.action);
    }
    if (filter?.mode) {
      conditions.push("mode = ?");
      params.push(filter.mode);
    }
    if (filter?.startDate) {
      conditions.push("timestamp >= ?");
      params.push(filter.startDate);
    }
    if (filter?.endDate) {
      conditions.push("timestamp <= ?");
      params.push(filter.endDate);
    }

    const limit = filter?.limit ?? 100;
    const offset = filter?.offset ?? 0;

    let sql = "SELECT * FROM decisions";
    if (conditions.length > 0) {
      sql += " WHERE " + conditions.join(" AND ");
    }
    sql += " ORDER BY timestamp DESC LIMIT ? OFFSET ?";
    params.push(limit, offset);

    const rows = await execAll<DecisionRow>(this.db, sql, params);
    return rows.map(rowToDecision);
  }

  /**
   * Count total decisions matching a filter (ignoring limit/offset).
   */
  async count(filter?: DecisionFilter): Promise<number> {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (filter?.agent) {
      conditions.push("agent = ?");
      params.push(filter.agent);
    }
    if (filter?.symbol) {
      conditions.push("symbol = ?");
      params.push(filter.symbol);
    }
    if (filter?.action) {
      conditions.push("action = ?");
      params.push(filter.action);
    }
    if (filter?.mode) {
      conditions.push("mode = ?");
      params.push(filter.mode);
    }
    if (filter?.startDate) {
      conditions.push("timestamp >= ?");
      params.push(filter.startDate);
    }
    if (filter?.endDate) {
      conditions.push("timestamp <= ?");
      params.push(filter.endDate);
    }

    let sql = "SELECT COUNT(*) as count FROM decisions";
    if (conditions.length > 0) {
      sql += " WHERE " + conditions.join(" AND ");
    }

    const result = await execGet<{ count: number }>(this.db, sql, params);
    return result?.count ?? 0;
  }
}
