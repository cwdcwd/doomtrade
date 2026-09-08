# Per-Agent Trading Architecture

**Created:** 2026-09-08
**Status:** Planning

## Overview

Replace the shared simulated portfolio with per-agent independent portfolios. Each agent (Doom, Kangbot, ThanosBot, any A2A agent) gets its own starting capital, positions, trade history, and assigned strategy. Agents are independently benchmarked.

## Decisions

- **Capital:** Independent budgets — each agent gets $100 (configurable)
- **Shared portfolio:** Replaced entirely — everything is per-agent
- **Extensibility:** Any A2A agent can auto-provision a portfolio
- **Strategies:** Pluggable modules — agents can switch between any registered strategy at runtime

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    DoomTrade App                         │
│                                                          │
│  ┌──────────────────────────────────────────────────┐   │
│  │              Agent Registry                        │   │
│  │  agents table: id, name, starting_balance,        │   │
│  │  strategy, active, created_at                     │   │
│  │  Auto-provision on first trade from unknown agent │   │
│  └──────────────────────┬───────────────────────────┘   │
│                          │                               │
│         ┌────────────────┼────────────────┐              │
│         ▼                ▼                ▼              │
│   ┌──────────┐   ┌──────────┐   ┌──────────┐            │
│   │  Doom    │   │ Kangbot  │   │ThanosBot │            │
│   │ Portfolio│   │ Portfolio│   │ Portfolio│            │
│   │          │   │          │   │          │            │
│   │ $100     │   │ $100     │   │ $100     │            │
│   │ cash     │   │ cash     │   │ cash     │            │
│   │ positions│   │ positions│   │ positions│            │
│   │ P&L      │   │ P&L      │   │ P&L      │            │
│   │ strategy │   │ strategy │   │ strategy │            │
│   └────┬─────┘   └────┬─────┘   └────┬─────┘            │
│        │              │              │                    │
│        └──────────────┴──────────────┘                    │
│                       │                                  │
│              ┌────────▼────────┐                         │
│              │  Trade Engine    │                         │
│              │  (per-agent)     │                         │
│              └────────┬────────┘                         │
│                       │                                  │
│         ┌─────────────┼─────────────┐                   │
│         ▼             ▼             ▼                    │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐             │
│  │ Market   │  │ Research │  │ Strategy │             │
│  │ Data     │  │ Module   │  │ Registry │             │
│  │ (Kraken) │  │ SMA/RSI  │  │ (pluggable)│            │
│  └──────────┘  └──────────┘  └──────────┘             │
│                                                          │
│  ┌──────────────────────────────────────────────────┐   │
│  │              Storage (Postgres)                    │   │
│  │  agents | agent_balance | agent_positions |       │   │
│  │  agent_orders | decisions | portfolio_history     │   │
│  └──────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────┘
```

## Database Schema

### New Tables

```sql
-- Agent registry
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  starting_balance REAL NOT NULL DEFAULT 100,
  strategy TEXT,  -- strategy type key (momentum-rotation, congress-follower, etc.)
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TEXT NOT NULL DEFAULT NOW()
);

-- Per-agent cash balance (replaces sim_balance)
CREATE TABLE agent_balance (
  agent_id TEXT PRIMARY KEY REFERENCES agents(id),
  cash REAL NOT NULL,
  initial_cash REAL NOT NULL,
  peak_equity REAL NOT NULL,
  updated_at TEXT NOT NULL DEFAULT NOW()
);

-- Per-agent positions (replaces sim_positions)
CREATE TABLE agent_positions (
  agent_id TEXT NOT NULL REFERENCES agents(id),
  symbol TEXT NOT NULL,
  quantity REAL NOT NULL,
  avg_entry_price REAL NOT NULL,
  side TEXT NOT NULL DEFAULT 'long',
  updated_at TEXT NOT NULL DEFAULT NOW(),
  PRIMARY KEY (agent_id, symbol)
);

-- Per-agent orders/trades (replaces trades)
CREATE TABLE agent_orders (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  decision_id TEXT,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  order_type TEXT NOT NULL CHECK (order_type IN ('market', 'limit')),
  quantity REAL NOT NULL,
  fill_price REAL,
  fee REAL NOT NULL DEFAULT 0,
  realized_pnl REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('pending', 'filled', 'cancelled', 'rejected')),
  created_at TEXT NOT NULL DEFAULT NOW(),
  filled_at TEXT
);

-- Per-agent equity history (replaces portfolio_history)
CREATE TABLE agent_portfolio_history (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  timestamp TEXT NOT NULL DEFAULT NOW(),
  equity REAL NOT NULL,
  cash REAL NOT NULL,
  positions_value REAL NOT NULL,
  unrealized_pnl REAL NOT NULL DEFAULT 0,
  realized_pnl REAL NOT NULL DEFAULT 0
);
```

### Migration Plan

- Migration v7: Create new tables above
- Migration v8: Backfill — create agent records for all distinct `agent` values in existing `decisions` table
- Old tables (`sim_balance`, `sim_positions`, `trades`, `portfolio_history`) kept for reference, marked deprecated
- `POST /api/admin/reset` wipes new tables instead

## Core Modules

### AgentExchange (`src/executor/agent-exchange.ts`)

Replaces `SimulatedExchange` for per-agent trading. One instance per agent.

```typescript
export class AgentExchange {
  constructor(db: Database, agentId: string, config: {
    initialCash: number;
    feeRate: number;
    getCurrentPrice?: (symbol: string) => number | null;
  });

  // Initialize balance row for this agent
  async initBalance(): Promise<void>;

  // Place an order — fills at live price (from price provider or limitPrice)
  async placeOrder(order: OrderRequest): Promise<OrderResult>;

  // Get balance: cash, equity, peak
  async getBalance(): Promise<{ cash: number; equity: number; peakEquity: number }>;

  // Get open positions
  async getPositions(): Promise<Position[]>;

  // Get trade history
  async getTrades(limit?: number): Promise<TradeRecord[]>;

  // Record equity checkpoint
  async recordCheckpoint(): Promise<void>;
}
```

Key difference from SimulatedExchange: all queries are scoped by `agent_id`. The `resolvePrice` logic is reused (prefers live price fallback over stale cache — the fix we just shipped).

### AgentManager (`src/agent/agent-manager.ts`)

Central registry for agent lifecycle:

```typescript
export class AgentManager {
  constructor(db: Database, config: AgentManagerConfig);

  // Register a new agent with starting balance and strategy
  async register(name: string, opts: { startingBalance?: number; strategy?: string }): Promise<Agent>;

  // Get or auto-provision an agent by name
  async getOrCreate(name: string): Promise<Agent>;

  // Get agent's exchange instance (cached)
  getExchange(agentId: string): AgentExchange;

  // List all agents with portfolio summaries
  async list(): Promise<AgentSummary[]>;

  // Leaderboard ranked by total return
  async leaderboard(): Promise<LeaderboardEntry[]>;

  // Update agent's strategy
  async setStrategy(agentId: string, strategy: string): Promise<void>;
}
```

Auto-provision: when a decision comes in with an unknown agent name, `getOrCreate` creates a new agent record with default starting balance ($100) and no strategy. The agent can then be assigned a strategy.

### AgentTradeEngine (`src/engine/agent-trade-engine.ts`)

Replaces the current TradeEngine for per-agent trades:

```typescript
export class AgentTradeEngine {
  constructor(db: Database, agentManager: AgentManager, config: Config, priceProvider: PriceProvider);

  // Execute a decision for a specific agent
  async executeDecision(input: ExecuteDecisionInput): Promise<ExecutionResult>;
  // Same risk checks as before, but scoped to agent's portfolio
}
```

Risk checks are per-agent: max open positions, max position size %, daily trade limit, max drawdown — all calculated against the agent's own equity, not a shared pool.

## API Changes

### New Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/agents` | Register a new agent |
| GET | `/api/agents` | List all agents with portfolio summaries |
| GET | `/api/agents/:id` | Get agent details |
| PATCH | `/api/agents/:id` | Update agent (strategy, active, starting_balance) |
| DELETE | `/api/agents/:id` | Deactivate an agent |
| GET | `/api/agents/:id/portfolio` | Equity, cash, positions, P&L |
| GET | `/api/agents/:id/positions` | Open positions |
| GET | `/api/agents/:id/trades` | Trade history |
| GET | `/api/agents/:id/analytics` | Win rate, Sharpe, drawdown |
| GET | `/api/agents/leaderboard` | All agents ranked by return |
| POST | `/api/agents/:id/evaluate` | Manually trigger strategy evaluation |

### Modified Endpoints

| Method | Path | Change |
|--------|------|--------|
| POST | `/api/decisions` | Already has `agent` field — now used to scope the trade |
| POST | `/api/trade` | Executes in the agent's portfolio (looks up agent from decision) |
| GET | `/api/portfolio` | DEPRECATED — returns 410 with redirect to `/api/agents/:id/portfolio` |
| GET | `/api/positions` | DEPRECATED — returns agent-scoped positions or 410 |
| GET | `/api/trades` | DEPRECATED — use `/api/agents/:id/trades` |

### Deprecated (kept for backward compat, marked in docs)

- `GET /api/portfolio` → use `GET /api/agents/:id/portfolio`
- `GET /api/positions` → use `GET /api/agents/:id/positions`
- `GET /api/trades` → use `GET /api/agents/:id/trades`
- `GET /api/trades/analytics` → use `GET /api/agents/:id/analytics`

## Strategy Integration

Each agent has an optional `strategy` field. When set:

1. The cron job or A2A pipeline calls `POST /api/agents/:id/evaluate`
2. The AgentManager looks up the agent's strategy
3. The ThemeRunner's registered strategy `evaluate()` is called with the agent's context
4. The strategy generates signals → decisions → trades, all scoped to the agent's portfolio
5. Results are logged and the agent's equity is updated

Strategies are the existing theme strategies (pluggable):
- `momentum-rotation` — SMA crossover + RSI screening
- `congress-follower` — mirrors politician trades
- `agent-driven` — delegates to A2A agent for signals
- Future: mean-reversion, pairs-trading, etc.

An agent can switch strategies at any time via `PATCH /api/agents/:id`.

## Default Agents

Three agents will be pre-seeded on deployment:

| Agent | Starting Balance | Strategy | Purpose |
|-------|-----------------|----------|---------|
| Doom | $100 | momentum-rotation | Trend-following, aggressive growth |
| Kangbot | $100 | congress-follower | Event-driven, contrarian |
| ThanosBot | $100 | agent-driven | AI-driven, A2A signal generation |

## Implementation Order

### Phase 1: Agent Exchange + Manager (Doom)
- `src/executor/agent-exchange.ts` — per-agent sim executor
- `src/agent/agent-manager.ts` — registry, auto-provision, leaderboard
- DB migrations v7-v8
- Pre-seed Doom, Kangbot, ThanosBot

### Phase 2: Agent Trade Engine + API (Kangbot)
- `src/engine/agent-trade-engine.ts` — per-agent risk checks and execution
- New API routes in `src/api/routes.ts`
- Deprecate old shared portfolio endpoints
- Tests for all new endpoints

### Phase 3: Strategy Integration + Dashboard (ThanosBot)
- Wire agent strategies to the ThemeRunner
- `POST /api/agents/:id/evaluate` endpoint
- Update dashboard to show per-agent portfolios + leaderboard
- Update cron job to use per-agent trading

### Phase 4: A2A Autonomous Trading (Doom)
- A2A pipeline: each agent evaluates its strategy on schedule
- Doom researches → Kangbot validates → ThanosBot executes
- Agent-to-agent communication for coordinated trading

## Testing

- Unit tests for AgentExchange (buy, sell, P&L, positions)
- Unit tests for AgentManager (register, getOrCreate, leaderboard)
- Integration tests for new API endpoints
- Migration tests (old data preserved, new tables created)
- Strategy evaluation tests per agent

## Environment Variables

No new env vars required. Agent starting balances and strategies are configured via the API. Default starting balance can be overridden with `AGENT_STARTING_BALANCE` (default: 100).