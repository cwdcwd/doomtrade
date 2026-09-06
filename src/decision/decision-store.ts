/**
 * Decision store — SQLite CRUD for the decision log.
 *
 * Append-only: create, getById, list. No update or delete operations.
 */

import type { Database as DatabaseType } from "better-sqlite3";
import { randomUUID } from "node:crypto";
import {
  type CreateDecisionInput,
  type Decision,
  type DecisionFilter,
  type DecisionRow,
  CreateDecisionInputSchema,
  rowToDecision,
} from "./decision.js";

export class DecisionStore {
  private db: DatabaseType;

  constructor(db: DatabaseType) {
    this.db = db;
  }

  /**
   * Create a new decision. Validates input with Zod, generates id + timestamp.
   * Append-only — this is the only write operation.
   */
  create(input: CreateDecisionInput): Decision {
    const parsed = CreateDecisionInputSchema.parse(input);

    const id = randomUUID();
    const timestamp = new Date().toISOString();
    const marketContextJson = parsed.marketContext
      ? JSON.stringify(parsed.marketContext)
      : null;

    this.db
      .prepare(
        `INSERT INTO decisions
           (id, timestamp, agent, symbol, action, quantity, price_at_decision,
            rationale, confidence, mode, market_context)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
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
      );

    return this.getById(id)!;
  }

  /**
   * Get a decision by ID. Returns null if not found.
   */
  getById(id: string): Decision | null {
    const row = this.db
      .prepare("SELECT * FROM decisions WHERE id = ?")
      .get(id) as DecisionRow | undefined;

    return row ? rowToDecision(row) : null;
  }

  /**
   * List decisions with optional filters.
   * Supports filtering by agent, symbol, action, mode, and date range.
   * Returns most recent first.
   */
  list(filter?: DecisionFilter): Decision[] {
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

    const rows = this.db.prepare(sql).all(...params) as DecisionRow[];
    return rows.map(rowToDecision);
  }

  /**
   * Count total decisions matching a filter (ignoring limit/offset).
   */
  count(filter?: DecisionFilter): number {
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

    const result = this.db.prepare(sql).get(...params) as { count: number };
    return result.count;
  }
}