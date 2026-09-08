/**
 * AgentManager — registry and lifecycle management for trading agents.
 *
 * Each agent has its own AgentExchange (portfolio), strategy, and starting
 * balance. The manager handles:
 * - Registration (explicit or auto-provision on first trade)
 * - Listing all agents with portfolio summaries
 * - Leaderboard ranked by total return
 * - Strategy assignment
 * - Exchange instance caching
 */

import { randomUUID } from "node:crypto";
import type { Database } from "../db/database.js";
import { execAll, execGet, execRun, convertPlaceholders } from "../db/database.js";
import { AgentExchange } from "../executor/agent-exchange.js";

export interface Agent {
  id: string;
  name: string;
  startingBalance: number;
  strategy: string | null;
  active: boolean;
  createdAt: string;
}

export interface AgentSummary {
  id: string;
  name: string;
  strategy: string | null;
  active: boolean;
  cash: number;
  equity: number;
  initialBalance: number;
  totalReturnPct: number;
  openPositions: number;
  createdAt: string;
}

export interface LeaderboardEntry {
  id: string;
  name: string;
  strategy: string | null;
  equity: number;
  initialBalance: number;
  totalReturnPct: number;
  totalReturn: number;
  rank: number;
}

export interface AgentManagerConfig {
  defaultStartingBalance: number;
  feeRate: number;
  getCurrentPrice?: (symbol: string) => number | null;
}

const DEFAULT_CONFIG: AgentManagerConfig = {
  defaultStartingBalance: 100,
  feeRate: 0.001,
};

interface AgentRow {
  id: string;
  name: string;
  starting_balance: number;
  strategy: string | null;
  active: number;
  created_at: string;
}

interface AgentBalanceRow {
  cash: number;
  initial_cash: number;
  peak_equity: number;
}

export class AgentManager {
  private db: Database;
  private config: AgentManagerConfig;
  private exchanges: Map<string, AgentExchange> = new Map();

  constructor(db: Database, config?: Partial<AgentManagerConfig>) {
    this.db = db;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Register a new agent. Throws if name already exists.
   */
  async register(
    name: string,
    opts?: { startingBalance?: number; strategy?: string },
  ): Promise<Agent> {
    const id = randomUUID();
    const startingBalance = opts?.startingBalance ?? this.config.defaultStartingBalance;
    const strategy = opts?.strategy ?? null;

    const sql = convertPlaceholders(
      `INSERT INTO agents (id, name, starting_balance, strategy, active)
       VALUES (?, ?, ?, ?, 1)`,
      this.db.backend,
    );
    await execRun(this.db, sql, [id, name, startingBalance, strategy]);

    return {
      id,
      name,
      startingBalance,
      strategy,
      active: true,
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * Get or auto-provision an agent by name.
   * If the agent doesn't exist, create it with default settings.
   */
  async getOrCreate(name: string): Promise<Agent> {
    const agent = await this.getByName(name);
    if (agent) return agent;

    return this.register(name);
  }

  /**
   * Get agent by name.
   */
  async getByName(name: string): Promise<Agent | null> {
    const sql = convertPlaceholders("SELECT * FROM agents WHERE name = ?", this.db.backend);
    const row = await execGet<AgentRow>(this.db, sql, [name]);
    return row ? this.rowToAgent(row) : null;
  }

  /**
   * Get agent by ID.
   */
  async getById(id: string): Promise<Agent | null> {
    const sql = convertPlaceholders("SELECT * FROM agents WHERE id = ?", this.db.backend);
    const row = await execGet<AgentRow>(this.db, sql, [id]);
    return row ? this.rowToAgent(row) : null;
  }

  /**
   * List all agents with portfolio summaries.
   *
   * Uses batch queries for balances and positions to avoid N+1 patterns.
   * Runs 3 queries total regardless of agent count (was 1 + 3N).
   */
  async list(): Promise<AgentSummary[]> {
    const agentsSql = convertPlaceholders(
      `SELECT a.id, a.name, a.strategy, a.active, a.starting_balance, a.created_at,
              b.cash, b.initial_cash, b.peak_equity
       FROM agents a
       LEFT JOIN agent_balance b ON a.id = b.agent_id
       ORDER BY a.created_at`,
      this.db.backend,
    );
    const agentRows = await execAll<{
      id: string;
      name: string;
      strategy: string | null;
      active: number;
      starting_balance: number;
      created_at: string;
      cash: number | null;
      initial_cash: number | null;
      peak_equity: number | null;
    }>(this.db, agentsSql);

    if (agentRows.length === 0) return [];

    // Batch-fetch all positions for all agents in one query
    const positionsSql = convertPlaceholders(
      "SELECT agent_id, symbol, quantity, avg_entry_price FROM agent_positions WHERE quantity > 0",
      this.db.backend,
    );
    const allPositions = await execAll<{
      agent_id: string;
      symbol: string;
      quantity: number;
      avg_entry_price: number;
    }>(this.db, positionsSql);

    // Group positions by agent_id
    const positionsByAgent = new Map<
      string,
      { symbol: string; quantity: number; avg_entry_price: number }[]
    >();
    for (const pos of allPositions) {
      let arr = positionsByAgent.get(pos.agent_id);
      if (!arr) {
        arr = [];
        positionsByAgent.set(pos.agent_id, arr);
      }
      arr.push({
        symbol: pos.symbol,
        quantity: pos.quantity,
        avg_entry_price: pos.avg_entry_price,
      });
    }

    // Compute summaries in-memory — no per-agent queries
    return agentRows.map((row) => {
      const positions = positionsByAgent.get(row.id) ?? [];
      const cash = row.cash ?? row.starting_balance;
      const initialCash = row.initial_cash ?? row.starting_balance;
      // Use avg_entry_price as fallback for current price (conservative — no price provider in batch)
      const positionsValue = positions.reduce((sum, p) => sum + p.quantity * p.avg_entry_price, 0);
      const equity = cash + positionsValue;
      const openPositions = positions.length;

      return {
        id: row.id,
        name: row.name,
        strategy: row.strategy,
        active: row.active === 1,
        cash,
        equity,
        initialBalance: initialCash,
        totalReturnPct: initialCash > 0 ? ((equity - initialCash) / initialCash) * 100 : 0,
        openPositions,
        createdAt: row.created_at,
      };
    });
  }

  /**
   * Leaderboard ranked by total return percentage (descending).
   */
  async leaderboard(): Promise<LeaderboardEntry[]> {
    const summaries = await this.list();
    const entries: LeaderboardEntry[] = summaries.map((s) => ({
      id: s.id,
      name: s.name,
      strategy: s.strategy,
      equity: s.equity,
      initialBalance: s.initialBalance,
      totalReturnPct: s.totalReturnPct,
      totalReturn: s.equity - s.initialBalance,
      rank: 0,
    }));

    entries.sort((a, b) => b.totalReturnPct - a.totalReturnPct);
    entries.forEach((e, i) => {
      e.rank = i + 1;
    });

    return entries;
  }

  /**
   * Update an agent's strategy.
   */
  async setStrategy(agentId: string, strategy: string): Promise<void> {
    const sql = convertPlaceholders("UPDATE agents SET strategy = ? WHERE id = ?", this.db.backend);
    await execRun(this.db, sql, [strategy, agentId]);
  }

  /**
   * Deactivate an agent.
   */
  async deactivate(agentId: string): Promise<void> {
    const sql = convertPlaceholders("UPDATE agents SET active = 0 WHERE id = ?", this.db.backend);
    await execRun(this.db, sql, [agentId]);
  }

  /**
   * Get or create the AgentExchange for an agent.
   * Cached per agent ID.
   */
  getExchange(agentId: string): AgentExchange {
    let exchange = this.exchanges.get(agentId);
    if (!exchange) {
      // We need the starting balance — but we can't await in a sync method.
      // Use the config default; the balance is already in the DB from registration.
      exchange = new AgentExchange(this.db, {
        agentId,
        startingBalance: this.config.defaultStartingBalance,
        feeRate: this.config.feeRate,
        getCurrentPrice: this.config.getCurrentPrice,
      });
      this.exchanges.set(agentId, exchange);
    }
    return exchange;
  }

  /**
   * Pre-seed default agents if they don't exist.
   */
  async seedDefaults(
    agents: { name: string; startingBalance: number; strategy: string }[],
  ): Promise<void> {
    for (const a of agents) {
      const existing = await this.getByName(a.name);
      if (!existing) {
        await this.register(a.name, {
          startingBalance: a.startingBalance,
          strategy: a.strategy,
        });
      }
    }
  }

  private rowToAgent(row: AgentRow): Agent {
    return {
      id: row.id,
      name: row.name,
      startingBalance: row.starting_balance,
      strategy: row.strategy,
      active: row.active === 1,
      createdAt: row.created_at,
    };
  }
}
