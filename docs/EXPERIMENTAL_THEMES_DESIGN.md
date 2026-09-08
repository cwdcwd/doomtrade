# Experimental Themes — Design Document

## Overview

Experimental Themes is a framework for testing broad trading theories as
automated, repeatable strategies. Each theme defines a signal source
("what to buy"), allocation rules ("how much"), and entry/exit criteria
("when"). Themes run on a schedule, generate `Decision` records through
the existing decision log, and execute through the existing trade engine
— all in sim mode by default.

## Motivation

Currently DoomTrade operates on ad-hoc decisions: an agent submits a
single-symbol, single-action decision. There's no mechanism to express a
*strategy* like "mirror every trade made by Senator X" or "buy the top 5
momentum stocks every Monday." Themes fill that gap by packaging a
signal pipeline + allocation logic into a reusable, evaluable unit.

## Goals

- **Define themes as code modules** with a standard interface
- **Schedule theme evaluation** (cron-like: daily, weekly, on-event)
- **Generate decisions** through the existing `DecisionStore` API
- **Execute through `TradeEngine`** with existing risk checks intact
- **Track per-theme performance** for comparison and evaluation
- **Sim-first**: themes default to sim mode; live mode requires explicit opt-in
- **Pluggable signal sources**: web scraping, APIs, agent reasoning, manual lists

## Non-Goals (v1)

- Theme marketplace / sharing
- Backtesting against historical data (future: use sim executor with replay)
- Cross-theme portfolio allocation optimization
- Real-time signal websockets (polling only for v1)

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        ThemeRunner                          │
│  - schedules theme evaluations (cron)                       │
│  - manages theme lifecycle (start/stop/pause)               │
│  - collects per-theme metrics                               │
├─────────────────────────────────────────────────────────────┤
│                                                            │
│  ┌──────────┐   signals    ┌──────────────┐  decisions     │
│  │  Signal   │─────────────▶│  Theme       │──────────────▶ │
│  │  Source   │              │  (strategy)  │               │
│  └──────────┘              └──────────────┘               │
│  - Congress trades           - allocation rules             │
│  - Momentum screen           - entry/exit criteria          │
│  - Agent prompt              - confidence scoring           │
│  - Manual list               - rationale generation         │
│                                                            │
│  ThemeRunner output ──▶ DecisionStore.create()              │
│                      ──▶ TradeEngine.executeDecision()      │
│                      ──▶ ThemeTracker (per-theme P&L)       │
└─────────────────────────────────────────────────────────────┘
```

## Core Types

```typescript
// src/themes/theme.ts

/** A single signal from a signal source */
export interface ThemeSignal {
  symbol: string;
  action: "buy" | "sell" | "hold";
  /** Suggested quantity, or null to let allocation logic decide */
  suggestedQuantity?: number;
  /** Price at signal time, if known */
  priceAtSignal?: number;
  /** Free-form metadata from the signal source */
  metadata?: Record<string, unknown>;
  /** Human-readable reason for this signal */
  reason: string;
}

/** Configuration for a theme instance */
export interface ThemeConfig {
  /** Unique identifier for this theme instance */
  id: string;
  /** Human-readable name */
  name: string;
  /** Strategy type — determines which ThemeStrategy class to use */
  strategy: string;
  /** Sim or live (default: sim) */
  mode: "sim" | "live";
  /** Schedule: cron expression or interval */
  schedule: ThemeSchedule;
  /** Max allocation per signal as % of equity */
  maxAllocationPct: number;
  /** Max total allocation for this theme as % of equity */
  maxTotalAllocationPct: number;
  /** Max number of positions this theme can hold simultaneously */
  maxPositions: number;
  /** Strategy-specific parameters */
  params: Record<string, unknown>;
  /** Whether this theme is active */
  enabled: boolean;
}

export type ThemeSchedule =
  | { type: "cron"; expression: string }
  | { type: "interval"; milliseconds: number }
  | { type: "manual" };

/** Result of a single theme evaluation cycle */
export interface ThemeEvaluationResult {
  themeId: string;
  timestamp: string;
  signals: ThemeSignal[];
  decisions: Decision[];
  trades: TradeRecord[];
  errors: string[];
}
```

## ThemeStrategy Interface

```typescript
// src/themes/strategy.ts

export interface ThemeStrategy {
  /** Strategy type identifier — matches ThemeConfig.strategy */
  readonly type: string;

  /**
   * Evaluate the strategy: gather signals and produce decisions.
   * Called on each scheduled tick.
   */
  evaluate(
    ctx: ThemeContext,
    config: ThemeConfig,
  ): Promise<ThemeEvaluationResult>;
}

/** Context passed to strategies — provides access to platform services */
export interface ThemeContext {
  marketData: MarketDataService;
  decisionStore: DecisionStore;
  tradeEngine: TradeEngine;
  portfolio: Portfolio;
  /** Current equity (for allocation calculations) */
  getEquity(): Promise<number>;
  /** Current positions (to check existing exposure) */
  getPositions(): Promise<Position[]>;
  /** Fetch current price for a symbol */
  getQuote(symbol: string): Promise<number>;
}
```

## Signal Sources

Signal sources are pluggable data providers that feed signals to strategies.

```typescript
// src/themes/signal-source.ts

export interface SignalSource {
  readonly name: string;

  /** Fetch current signals from this source */
  fetchSignals(): Promise<ThemeSignal[]>;
}
```

### v1 Signal Sources

1. **CongressionalTradeSource** — Polls a Congress trading data API
   (e.g. Capitol Trades, Quiver Quant) for recent trades by a specified
   politician. Each trade becomes a `ThemeSignal` mirroring the action.

2. **MomentumScreenSource** — Screens a universe of symbols for momentum
   criteria (e.g. price above N-day SMA, RSI threshold). Uses the existing
   `ResearchService.analyze()` to compute indicators.

3. **AgentSignalSource** — Delegates to an agent (Doom/Kangbot) via A2A
   to generate signals. The agent receives the current portfolio + market
   context and returns buy/sell/hold recommendations.

4. **ManualListSource** — A static list of symbols with target weights.
   Useful for "buy and hold these 10 stocks" themes.

## v1 Theme Strategies

### Congress Follower

**Strategy type:** `congress-follower`

**Params:**
- `politician`: name or ID of the congress person to follow
- `dataSource`: which API to use (`capitol-trades` | `quiver`)
- `delayHours`: how long to wait after the politician's trade (default: 0)
- `mirrorAction`: whether to mirror buys only, or also sells (default: `buys-only`)

**Flow:**
1. Fetch recent trades by the politician from the signal source
2. For each trade not already mirrored (deduplicate by tracking in
   `theme_signals` table), generate a `ThemeSignal`
3. Allocate fixed percentage of equity per signal (up to `maxAllocationPct`)
4. Create a `Decision` with rationale citing the politician's trade
5. Execute via `TradeEngine` (risk checks apply)

### Momentum Rotation

**Strategy type:** `momentum-rotation`

**Params:**
- `universe`: list of symbols to screen (or `sp500` | `nasdaq100`)
- `indicator`: which indicator to use (`sma-crossover` | `rsi` | `combined`)
- `periods`: lookback periods (e.g. `{ fast: 20, slow: 50 }`)
- `topN`: number of top-scoring symbols to buy
- `rebalanceInterval`: how often to rebalance (`weekly` | `monthly`)

**Flow:**
1. Run indicators across the universe using `ResearchService`
2. Score each symbol by the chosen indicator
3. Buy the top N symbols that pass entry criteria
4. Sell positions that drop out of top N (or fail exit criteria)
5. Equal-weight allocation across selected symbols

### Agent-Driven

**Strategy type:** `agent-driven`

**Params:**
- `agent`: which agent to ask (`doom` | `kangbot`)
- `promptTemplate`: template string for the agent's task
- `universe`: optional symbol list to constrain the agent's scope

**Flow:**
1. Build market context (current positions, recent prices, indicators)
2. Send prompt to agent via A2A
3. Parse agent response into `ThemeSignal[]`
4. Create and execute decisions

## Database Schema (Migration 4)

```sql
-- Theme instances
CREATE TABLE IF NOT EXISTS themes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  strategy TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'sim' CHECK (mode IN ('sim', 'live')),
  schedule TEXT NOT NULL,        -- JSON
  max_allocation_pct REAL NOT NULL DEFAULT 5,
  max_total_allocation_pct REAL NOT NULL DEFAULT 40,
  max_positions INTEGER NOT NULL DEFAULT 10,
  params TEXT NOT NULL DEFAULT '{}',  -- JSON
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Track which signals have been processed (dedup)
CREATE TABLE IF NOT EXISTS theme_signals (
  id TEXT PRIMARY KEY,
  theme_id TEXT NOT NULL,
  signal_hash TEXT NOT NULL,     -- dedup key (e.g. politician+symbol+date)
  symbol TEXT NOT NULL,
  action TEXT NOT NULL,
  metadata TEXT,                 -- JSON
  processed_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (theme_id) REFERENCES themes(id),
  UNIQUE (theme_id, signal_hash)  -- prevent duplicate processing
);

-- Evaluation runs
CREATE TABLE IF NOT EXISTS theme_evaluations (
  id TEXT PRIMARY KEY,
  theme_id TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  signals_count INTEGER NOT NULL DEFAULT 0,
  decisions_count INTEGER NOT NULL DEFAULT 0,
  trades_count INTEGER NOT NULL DEFAULT 0,
  errors TEXT,                   -- JSON array of error strings
  FOREIGN KEY (theme_id) REFERENCES themes(id)
);

CREATE INDEX IF NOT EXISTS idx_theme_signals_theme ON theme_signals(theme_id);
CREATE INDEX IF NOT EXISTS idx_theme_evaluations_theme ON theme_evaluations(theme_id);
```

The `trades` table already has a `decision_id` FK, and decisions carry
their rationale — so per-theme attribution flows through: theme evaluation
→ decisions (rationale includes theme ID) → trades → analytics. v1 uses
rationale text matching; v2 could add a `theme_id` column to `decisions`
for cleaner joins.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/themes` | Create a new theme |
| `GET` | `/api/themes` | List all themes (filter by strategy, enabled) |
| `GET` | `/api/themes/:id` | Get theme details |
| `PATCH` | `/api/themes/:id` | Update theme config (enable/disable, params) |
| `DELETE` | `/api/themes/:id` | Delete a theme (stops runner, archives data) |
| `POST` | `/api/themes/:id/evaluate` | Manually trigger an evaluation run |
| `GET` | `/api/themes/:id/evaluations` | List evaluation history |
| `GET` | `/api/themes/:id/performance` | Per-theme P&L, win rate, position summary |

## File Layout

```
src/themes/
  theme.ts              — Types (ThemeConfig, ThemeSignal, etc.)
  strategy.ts           — ThemeStrategy interface + ThemeContext
  signal-source.ts      — SignalSource interface
  theme-runner.ts       — ThemeRunner: scheduling, lifecycle, metrics
  theme-store.ts        — CRUD for theme configs in SQLite
  theme-tracker.ts      — Per-theme performance tracking
  strategies/
    congress-follower.ts
    momentum-rotation.ts
    agent-driven.ts
  sources/
    congress-trades.ts  — Capitol Trades / Quiver API client
    momentum-screen.ts  — Uses ResearchService
    agent-signal.ts     — A2A agent delegation
    manual-list.ts      — Static symbol list

src/api/schemas.ts      — Add theme-related Zod schemas
src/api/routes.ts       — Add /api/themes routes

src/db/database.ts      — Migration 4: themes, theme_signals, theme_evaluations, theme_subaccounts

src/themes/
  scheduler.ts          — BullMQ Queue + Worker for theme evaluations
  queue-connection.ts   — Redis connection (ioredis)
```

## ThemeRunner

The `ThemeRunner` is the orchestrator:

```typescript
export class ThemeRunner {
  private strategies: Map<string, ThemeStrategy> = new Map();
  private timers: Map<string, NodeJS.Timeout> = new Map();

  /** Register a strategy implementation */
  registerStrategy(strategy: ThemeStrategy): void;

  /** Start a theme: load config, schedule evaluations */
  start(themeId: string): void;

  /** Stop a theme: clear timer, mark disabled */
  stop(themeId: string): void;

  /** Manually trigger one evaluation */
  evaluateOnce(themeId: string): Promise<ThemeEvaluationResult>;

  /** Get per-theme performance */
  getPerformance(themeId: string): Promise<ThemePerformance>;
}
```

## Implementation Phases

### Phase 1: Core framework (issues #27–#28)
- Theme types + interfaces
- DB migration (themes, theme_signals, theme_evaluations)
- ThemeStore CRUD
- ThemeRunner with scheduling
- ThemeTracker for per-theme metrics

### Phase 2: First strategy — Congress Follower (#29)
- CongressTradesSignalSource
- CongressFollower strategy
- Signal dedup via theme_signals table
- CLI script to create/manage themes

### Phase 3: API + monitoring (#30)
- REST endpoints for theme CRUD + evaluation + performance
- Wire ThemeRunner into app startup
- Health endpoint reports active themes

### Phase 4: Additional strategies (#31–#32)
- MomentumRotation strategy (uses ResearchService)
- AgentDriven strategy (uses A2A AgentCoordinator)

### Phase 5: Evaluation dashboard (#33)
- Per-theme P&L charts
- Signal-to-decision-to-trade audit trail
- Comparison view across themes

## Signal Source Research

### 1. Congressional Trades

**Recommended: Bargo Congress Trades API** (free, no key required for basic access)
- Base URL: `https://www.bargo.ai/free-apis/congress/v1`
- No key needed for anonymous access (100 rows/page, last 3 months)
- Free key raises limit to 250 rows/page
- Endpoints: `GET /trades`, `GET /trades/{ticker}`, `GET /members`, `GET /stats`, `GET /health`
- Filters: ticker, member (partial name match), chamber, transaction type, date range
- Every row includes per-trade price performance (est_price, recent_price, perf_pct)
- 42,000+ trades across 415 members, 4,100+ tickers
- First-party JS + Python SDKs, MCP server available
- Get key: https://www.bargo.ai/free-apis/dash (no card required)

**Alternatives:**

| Source | Price | Key Required | Notes |
|--------|-------|-------------|-------|
| QuantEngines | Free, no signup | No | 20 req/min, REST + JSON, CORS enabled. `https://quantengines.com/api/v1` |
| CongressInvests | Free 500 req/day, $29/mo Pro | No for free tier | Hosted on Railway, 6hr refresh, AI analysis included. `https://congressinfor-production.up.railway.app` |
| Lambda Finance | Free 50 calls/mo, $19/mo Pro | Yes | Dual-chamber, sector flows, widgets. **Winding down Aug 2026 — avoid.** |
| Quiver Quantitative | $30–75/mo | Yes | Congress trades + Trump trades + insider trades + lobbying. Broadest alt-data platform. |
| Finnhub | Free tier, then paid | Yes | Congressional trading as premium endpoint. Also has 13F, Form 4. |
| Capitol Trades | Free web UI, no API | N/A | No public API. Scraping required. Use Bargo instead. |
| Senate Stock Watcher | Free, open source | No | Senate only, bulk JSON, GitHub-hosted. Good fallback. |
| capitol-api (GitHub) | Free, self-hosted | No | Open source, parses House PTR filings. Self-host on Railway. |
| DisclosedCapitol | Free 750 credits, pay-as-you-go | Yes | 316 endpoints, webhooks on Pro. Includes Form 4 + congress + lobbying. |

**Decision: Use Bargo as primary (free, no key, per-trade performance data), QuantEngines as fallback (also free, no key). If we later need Trump trades or insider data, upgrade to Quiver ($30/mo).**

### 2. Presidential Trades

**Only source: Quiver Quantitative** — has a dedicated `get_trump_trades` API endpoint
- Requires paid API tier ($30/mo+)
- Tracks Donald Trump's OGE Form 278-T disclosures
- 3,600+ transactions in Q1 2026 alone, $220M–$750M disclosed value
- Computes excess return per trade (stock performance vs market since trade date)
- No free alternative found for presidential trade data
- MCP server available via Pipeworx (BYO key)

**Decision: Deplete the presidential-follower theme until we commit to a Quiver subscription. Add as a strategy type in the code but mark as "requires Quiver API key."**

### 3. Whale / Institutional Trades (13F Filings)

**SEC EDGAR — free, no key, 10 req/sec**
- Base URLs: `data.sec.gov` (submissions, XBRL), `efts.sec.gov` (full-text search)
- Only requirement: `User-Agent` header with org name + contact email
- 13F filings are quarterly (45-day lag), not real-time trades
- Use `efts.sec.gov/LATEST/search-index?q=...&forms=13F-HR` to find filings
- Use `data.sec.gov/submissions/CIK{number}.json` to get filing history by fund
- Parse the 13F XML/HTML for holdings data (CUSIP, shares, value)
- CUSIP→ticker resolution is the painful part — need a mapping service

**Easier alternatives:**

| Source | Price | Notes |
|--------|-------|-------|
| BusinessQuant | Free tier | REST API, 5 modes (topholders, stats, alltransactions, historic, summary). Query by ticker or CIK. |
| Finnhub | Free tier | 13F institutional portfolio endpoint. Also congressional trading + Form 4. |
| WhaleWisdom | Free account (8 quarters), paid for full | 13F database with QoQ diffs, holdings comparison. CLI-style API. |
| Arkolith | $1 trial, then credits | MCP-native + REST. CUSIP→ticker resolved, amendments handled, QoQ deltas precomputed. 7,311 funds. |
| secapi.dev | Free tier | Form 4 + 13F APIs, structured JSON. |
| sec-api.io | Paid | Python SDK, 13F cover pages, 13D/13G. Clean parsing. |

**Decision: Use SEC EDGAR directly for raw 13F data (free, no key). Use BusinessQuant's free tier for pre-parsed top holders / QoQ changes when we need the easy path. If we need CUSIP resolution, use Arkolith ($1 trial to evaluate).**

### 4. Insider Trades (SEC Form 4)

**SEC EDGAR — free, no key**
- Form 4 filings available same way as 13F
- Use `efts.sec.gov/LATEST/search-index?q=...&forms=4` to find recent filings
- Parse XML for transaction details (insider, ticker, type, shares, price)

**Easier alternatives:**

| Source | Price | Notes |
|--------|-------|-------|
| OpenInsider | Free (web), API via Parse.bot | Real-time screener, cluster buys, CEO/CFO filters. No official API but Parse.bot wraps it. |
| Finnhub | Free tier | Insider transactions endpoint, sentiment data. |
| secapi.dev | Free tier | Form 4 API, transaction codes decoded, per-person history. Minutes of filing. |
| DisclosedCapitol | Free 750 credits | Form 4 + congress + lobbying combined. Webhooks on Pro. |

**Decision: Use OpenInsider for free browsing/monitoring. Use secapi.dev or Finnhub free tier for programmatic access. Form 4 is a future signal source — not v1.**

### 5. API Key Summary

| Service | Key Needed | Where to Get It | Cost |
|----------|-----------|----------------|------|
| Bargo Congress | No (optional free key) | https://www.bargo.ai/free-apis/dash | Free |
| QuantEngines | No | No signup needed | Free |
| CongressInvests | No (free tier) | No signup needed | Free / $29 mo Pro |
| SEC EDGAR | No (User-Agent header only) | N/A — just set header | Free |
| BusinessQuant | Yes (free key) | https://businessquant.com | Free tier |
| Finnhub | Yes (free key) | https://finnhub.io/register | Free / paid |
| Quiver | Yes (paid) | https://api.quiverquant.com/pricing | $30–75/mo |
| secapi.dev | Yes (free key) | https://secapi.dev | Free tier |
| Arkolith | Yes (paid) | https://arkolith.com | $1 trial, then credits |

**For v1 congress-follower theme: zero cost, zero keys. Bargo anonymous access + SEC EDGAR User-Agent header.**

---

## Resolved Design Decisions

### Sub-Portfolios (Question 3 — Resolved)

**Decision: Each theme gets a virtual sub-portfolio.**

Rationale: Without sub-portfolios, multiple themes compete for the same global equity pool and risk limits, making it impossible to evaluate themes independently. "Did the Pelosi-follower theme make money, or did the momentum theme's gains mask its losses?" becomes unanswerable.

**Implementation:**

- `themes` table gains `allocated_capital REAL NOT NULL DEFAULT 0` column
- When a theme starts, the operator allocates a fixed dollar amount from the global portfolio
- `SimulatedExchange` is extended to support **named sub-accounts**:
  - Each theme gets its own balance, positions, and P&L tracking
  - The global account holds the unallocated balance
  - Risk checks (max open positions, position size, drawdown) run against the theme's sub-account, not global equity
- `TradeEngine` gains an optional `accountId` parameter — when set, risk checks and executor calls are scoped to that sub-account
- `SimulatedExchange.placeOrder()` checks `accountId` to route to the right sub-account
- Per-theme performance is clean: sub-account balance = theme P&L, no contamination
- Live mode: Alpaca supports sub-accounts natively (same key, different account ID). CCXT doesn't universally — would need simulated sub-account tracking for crypto.

**Schema changes:**

```sql
-- Add to themes table (migration 4):
ALTER TABLE themes ADD COLUMN allocated_capital REAL NOT NULL DEFAULT 0;

-- Sub-account balances (sim mode tracking)
CREATE TABLE IF NOT EXISTS theme_subaccounts (
  theme_id TEXT PRIMARY KEY,
  balance REAL NOT NULL,
  peak_balance REAL NOT NULL,
  starting_balance REAL NOT NULL,
  FOREIGN KEY (theme_id) REFERENCES themes(id)
);
```

### Scheduling — Redis Queue with BullMQ (Question 4 — Resolved)

**Decision: Use BullMQ (Redis-backed job queue) for theme evaluation scheduling.**

Rationale: In-process `setInterval`/`setTimeout` timers die on every Railway restart, deploys, or crash. Redis persists job state across restarts, supports cron expressions, retries, and priority.

**Implementation:**

```
src/themes/
  scheduler.ts          — BullMQ Queue + Worker for theme evaluations
  queue-connection.ts   — Redis connection (ioredis, maxRetriesPerRequest: null)
```

- **Queue**: `theme-evaluation` — one job per theme per scheduled tick
- **Repeat jobs**: BullMQ `queue.add('evaluate-theme-{id}', payload, { repeat: { pattern: cronExpr } })` for cron schedules, or `{ repeat: { every: ms } }` for intervals
- **Worker**: processes evaluation jobs — calls `ThemeRunner.evaluateOnce(themeId)`
- **On startup**: read enabled themes from DB, re-register all repeat jobs (BullMQ deduplicates by repeat key)
- **Manual trigger**: `POST /api/themes/:id/evaluate` adds a one-off job to the queue
- **Retries**: failed evaluations retry 3x with exponential backoff (1s, 5s, 30s)
- **Monitoring**: queue health (waiting/active/failed counts) exposed via `GET /api/themes/queue/health`
- **Redis**: Railway add-on (free tier: 30MB, sufficient for low-volume scheduling)

**Config additions:**

```typescript
// config.ts
redisUrl: z.string().default("redis://localhost:6379"),
```

**Dependencies:**

```json
{
  "bullmq": "^5.x",
  "ioredis": "^5.x"
}
```

**Graceful shutdown:**

```typescript
// On SIGTERM: close worker, close queue, disconnect Redis
process.on('SIGTERM', async () => {
  await worker.close();
  await queue.close();
  await redisConnection.quit();
});
```

**Fallback (no Redis):** If `REDIS_URL` is not set, fall back to in-process timers with a warning. Useful for local dev and testing.