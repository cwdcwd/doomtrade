# Database, Configuration, CLI & Deployment

> Database schema, environment configuration, CLI tools, deployment guide, and testing reference for DoomTrade.

## Database Schema

DoomTrade uses a dual-mode database: **SQLite** (sql.js / WASM) for local development and **Postgres** (`pg`) for production. The `DbClient` interface abstracts both backends. All migrations are idempotent and tracked in the `_migrations` table.

### ER Diagram

```mermaid
erDiagram
    decisions ||--o{ trades : "produces"
    _migrations ||--o{} decisions : "tracks schema"
    agents ||--|| agent_balance : "has one"
    agents ||--o{ agent_positions : "has many"
    agents ||--o{ agent_orders : "has many"
    agents ||--o{ agent_portfolio_history : "has many"
    themes ||--o{ theme_signals : "dedup"
    themes ||--o{ theme_evaluations : "history"
    themes ||--|| theme_subaccounts : "balance"
    themes ||--o{ sim_sub_positions : "positions"
    themes ||--o{ sim_sub_orders : "orders"

    decisions {
        TEXT id PK
        TEXT timestamp
        TEXT agent
        TEXT symbol
        TEXT action
        REAL quantity
        REAL price_at_decision
        TEXT rationale
        INTEGER confidence
        TEXT mode
        TEXT market_context
        TEXT created_at
    }

    trades {
        TEXT id PK
        TEXT decision_id FK
        TEXT timestamp
        TEXT symbol
        TEXT side
        REAL quantity
        TEXT order_type
        REAL fill_price
        TEXT status
        REAL fee
        REAL realized_pnl
        TEXT mode
        TEXT executor
        TEXT error
        TEXT created_at
    }

    sim_positions {
        TEXT symbol PK
        REAL quantity
        REAL avg_entry_price
        TEXT side
        TEXT updated_at
    }

    sim_balance {
        INTEGER id PK
        REAL cash
        REAL initial_cash
        REAL peak_equity
        TEXT updated_at
    }

    portfolio_history {
        TEXT id PK
        TEXT timestamp
        REAL equity
        REAL cash
        REAL positions_value
        REAL unrealized_pnl
        REAL realized_pnl
        TEXT mode
    }

    agents {
        TEXT id PK
        TEXT name UK
        REAL starting_balance
        TEXT strategy
        INTEGER active
        TEXT created_at
    }

    agent_balance {
        TEXT agent_id PK
        REAL cash
        REAL initial_cash
        REAL peak_equity
        TEXT updated_at
    }

    agent_positions {
        TEXT agent_id PK
        TEXT symbol PK
        REAL quantity
        REAL avg_entry_price
        TEXT side
        TEXT updated_at
    }

    agent_orders {
        TEXT id PK
        TEXT agent_id FK
        TEXT decision_id
        TEXT symbol
        TEXT side
        TEXT order_type
        REAL quantity
        REAL fill_price
        REAL fee
        REAL realized_pnl
        TEXT status
        TEXT error
        TEXT created_at
        TEXT filled_at
    }

    agent_portfolio_history {
        TEXT id PK
        TEXT agent_id
        TEXT timestamp
        REAL equity
        REAL cash
        REAL positions_value
        REAL unrealized_pnl
        REAL realized_pnl
    }

    themes {
        TEXT id PK
        TEXT name
        TEXT strategy
        TEXT mode
        TEXT schedule
        REAL max_allocation_pct
        REAL max_total_allocation_pct
        INTEGER max_positions
        REAL allocated_capital
        TEXT params
        INTEGER enabled
        TEXT created_at
        TEXT updated_at
    }

    theme_signals {
        TEXT id PK
        TEXT theme_id FK
        TEXT signal_hash
        TEXT symbol
        TEXT action
        TEXT metadata
    }

    theme_evaluations {
        TEXT id PK
        TEXT theme_id FK
        TEXT timestamp
        INTEGER signals_count
        INTEGER decisions_count
        INTEGER trades_count
        TEXT errors
    }

    theme_subaccounts {
        TEXT theme_id PK
        REAL balance
        REAL peak_balance
        REAL starting_balance
    }

    sim_sub_positions {
        TEXT theme_id PK
        TEXT symbol PK
        REAL quantity
        REAL avg_entry_price
        TEXT side
        TEXT updated_at
    }

    sim_sub_orders {
        TEXT id PK
        TEXT theme_id FK
        TEXT symbol
        TEXT side
        TEXT order_type
        REAL quantity
        TEXT status
        REAL realized_pnl
        TEXT created_at
    }
```

### Migrations

8 idempotent migrations applied in version order on boot:

| Version | Name | Description |
| --- | --- | --- |
| 1 | initial_schema | `_migrations`, `decisions` (with CHECK constraints) |
| 2 | trades_table | `trades` table with FK to decisions |
| 3 | sim_tables | `sim_positions`, `sim_balance`, `sim_orders` |
| 4 | portfolio_history | `portfolio_history` table |
| 5 | themes | `themes`, `theme_signals`, `theme_evaluations`, `theme_subaccounts`, `sim_sub_positions`, `sim_sub_orders` |
| 6 | sim_sub_orders_realized_pnl | Add `realized_pnl` column to `sim_sub_orders` |
| 7 | agent_tables | `agents`, `agent_balance`, `agent_positions`, `agent_orders`, `agent_portfolio_history` |
| 8 | decisions_agent_any_name | Drop `CHECK(agent IN ('doom','kangbot'))` from decisions — allows any agent name |

**Dialect handling**: `{now}` placeholder in SQL converts to `datetime('now')` for SQLite, `NOW()` for Postgres. Migration 8 uses different SQL per backend (SQLite recreates the table, Postgres drops the constraint by name).

---

## Configuration

All configuration is loaded from environment variables and validated with Zod at startup. Invalid config crashes immediately (fail-fast).

### Environment Variables

| Variable | Type | Default | Description |
| --- | --- | --- | --- |
| `PORT` | number | `3000` | Express server port |
| `TRADE_MODE` | "sim" \| "live" | `"sim"` | Trading mode |
| `ALPACA_API_KEY_ID` | string | `""` | Alpaca API key ID (stocks) |
| `ALPACA_API_SECRET_KEY` | string | `""` | Alpaca API secret key |
| `ALPACA_PAPER` | boolean | `true` | Use Alpaca paper trading endpoint |
| `CCXT_EXCHANGE` | string | `"binance"` | CCXT exchange id (e.g. "kraken") |
| `CCXT_API_KEY` | string | `""` | CCXT API key (crypto) |
| `CCXT_API_SECRET` | string | `""` | CCXT API secret |
| `DATABASE_PATH` | string | `"./data/doomtrade.db"` | SQLite file path (ignored if DATABASE_URL set) |
| `DATABASE_URL` | string | `""` | Postgres connection string (empty = use SQLite) |
| `MAX_OPEN_POSITIONS` | number | `10` | Max concurrent open positions |
| `MAX_POSITION_SIZE_PCT` | number | `20` | Max position size as % of equity |
| `DAILY_TRADE_LIMIT` | number | `20` | Max non-rejected trades per day |
| `MAX_DRAWDOWN_PCT` | number | `15` | Max drawdown % before blocking trades |
| `SIM_STARTING_BALANCE` | number | `100000` | Sim mode starting cash ($100K) |
| `SIM_FEE_PCT` | number | `0.1` | Sim fee percentage (0.1 = 0.1%) |
| `REDIS_URL` | string | `""` | Redis URL for BullMQ theme scheduling |
| `DOOMTRADE_API_KEY` | string | `""` | API key for auth (empty = no auth) |

### Key Configuration Notes

> **Warning: Binance geo-blocked from Railway US servers (HTTP 451).** Use `CCXT_EXCHANGE=kraken` for production deployment. The default is "binance" which only works from non-US IPs.
- **Postgres on Railway**: Set `DATABASE_URL` to the Railway Postgres connection string. Postgres data persists across redeploys; SQLite data does not (unless volume mounted).
- **API auth**: If `DOOMTRADE_API_KEY` is empty, all endpoints are open (local dev only). Set it for production.

---

## CLI Tools

All CLI tools are in `scripts/` and use the `DOOMTRADE_URL` environment variable (default: `http://localhost:3000`).

### trade.ts — Submit a trade

Create a decision and execute it in one command.

```bash
npx tsx scripts/trade.ts --symbol BTC/USDT --action buy --qty 0.01 \
  --rationale "Bullish RSI divergence" --confidence 8

# With explicit price
npx tsx scripts/trade.ts --symbol AAPL --action sell --qty 10 --price 185.50

# Crypto
npx tsx scripts/trade.ts --symbol BTC/USDT --action buy --qty 0.01 \
  --rationale "Golden cross forming" --confidence 7
```

| Flag | Type | Required | Description |
| --- | --- | --- | --- |
| `--symbol` | string | yes | Trading symbol |
| `--action` | buy\|sell\|hold | yes | Trade action |
| `--qty` | number | yes | Quantity |
| `--rationale` | string | no | Reasoning (default: "") |
| `--confidence` | 1-10 | no | Confidence level (default: 5) |
| `--price` | number | no | Price (default: 0) |

**Env**: `DOOMTRADE_URL`, `AGENT_NAME` (default: "doom")

### status.ts — Portfolio overview

```bash
npx tsx scripts/status.ts              # show everything
npx tsx scripts/status.ts --portfolio  # just portfolio
npx tsx scripts/status.ts --decisions  # just recent decisions
npx tsx scripts/status.ts --positions  # just open positions
```

### history.ts — Trade history & analytics

```bash
npx tsx scripts/history.ts                          # trade history + analytics
npx tsx scripts/history.ts --symbol BTC/USDT        # filter by symbol
npx tsx scripts/history.ts --start 2026-09-01       # date range
npx tsx scripts/history.ts --analytics              # analytics only
npx tsx scripts/history.ts --equity                 # equity curve
npx tsx scripts/history.ts --limit 50                # limit trades
```

| Flag | Description |
| --- | --- |
| `--symbol <SYM>` | Filter by symbol |
| `--start <date>` | Date range start (ISO) |
| `--end <date>` | Date range end (ISO) |
| `--limit <N>` | Limit trades shown (default 100) |
| `--analytics` | Show only performance analytics |
| `--equity` | Show equity curve |

### research.ts — Symbol research

```bash
npx tsx scripts/research.ts --symbol AAPL
npx tsx scripts/research.ts --symbol BTC/USDT
npx tsx scripts/research.ts --symbol AAPL --price 150  # manual price
```

Computes SMA(20), SMA(50), RSI(14) from bar data fetched via the API.

---

## Deployment

### Railway

DoomTrade is designed for Railway deployment. Configuration is in `railway.json`.

**Setup**:
1. Connect the GitHub repo to Railway
2. Add a Postgres plugin → set `DATABASE_URL` to the connection string
3. Set environment variables (at minimum: `DOOMTRADE_API_KEY`, `TRADE_MODE`, `CCXT_EXCHANGE=kraken`)
4. Deploy — Railway runs `npm install` + `npm run build` + starts the server

**Health check**: Railway uses `GET /health` (always public, no auth) for deployment healthchecks.

**Postgres persistence**: Postgres data survives redeploys. SQLite (without a volume mount) does not — data is lost on redeploy. Always set `DATABASE_URL` for production.

### Build

```bash
# Node 20 via nvm
source ~/.nvm/nvm.sh && nvm use 20

# Install dependencies (use npm install, NOT npm ci — cross-arch lockfile issue)
npm install

# Type check
npx tsc --noEmit

# Run tests
npx vitest run

# Start server
npm run dev   # ts-node-dev with hot reload
npm start      # compiled JS
```

**TypeScript**: ESM modules, strict mode, `verbatimModuleSyntax` (requires `.js` extensions in imports). The only expected `tsc --noEmit` error is `pg` module not found (pre-existing — dynamic import).

### Key Build Patterns

- **Dynamic imports**: Alpaca (`@alpacahq/alpaca-trade-api`), CCXT (`ccxt`), and agent-bridge (`@cwdcwd/agent-bridge`) are optional dependencies loaded via dynamic import. The packages don't need to be installed unless their executors are actually used.
- **sql.js (WASM)**: Replaced `better-sqlite3` with `sql.js` for ARM/aarch64 compatibility. Key differences: `openDatabase()` is async (WASM init), persistence is manual (call `persistDatabase()` on shutdown).
- **Lockfile gitignored**: `package-lock.json` generated on arm64 (Pi) only includes arm64 optional native deps (rollup, esbuild). GitHub Actions x64 runners fail. Use `npm install` not `npm ci`. This is a known cross-arch issue.
- **`.js` extensions**: All imports use `.js` extensions even though source files are `.ts` — required by ESM with `verbatimModuleSyntax`.

---

## Testing

22 test files, 405+ tests, all using **vitest** with in-memory SQLite for isolation.

### Running Tests

```bash
# All tests
npx vitest run

# Single file
npx vitest run tests/engine.test.ts

# Watch mode
npx vitest
```

### Test Files

| File | Tests | Description |
| --- | --- | --- |
| `api.test.ts` | 35 | API endpoints (decisions, trades, portfolio, mode toggle) |
| `agent-api.test.ts` | 10 | Agent API endpoints |
| `agent-exchange.test.ts` | 12 | AgentExchange (per-agent executor) |
| `agent-integration.test.ts` | 9 | AgentCoordinator A2A integration |
| `agent-driven.test.ts` | 4 | AgentDriven strategy |
| `auth.test.ts` | 10 | API key authentication |
| `ccxt-data.test.ts` | 14 | CCXT market data adapter |
| `congress-follower.test.ts` | 8 | CongressFollower strategy |
| `config.test.ts` | 7 | Config loading + validation |
| `decision.test.ts` | 24 | DecisionStore CRUD + filtering |
| `engine.test.ts` | 30 | TradeEngine risk checks + execution |
| `executors.test.ts` | 20 | SimulatedExchange + executor interface |
| `health.test.ts` | 4 | Health endpoint |
| `history.test.ts` | 16 | Trade history + analytics + date range |
| `indicators.test.ts` | 30 | SMA, EMA, RSI indicator functions |
| `market.test.ts` | 13 | MarketDataService routing |
| `momentum-rotation.test.ts` | 8 | MomentumRotation strategy |
| `portfolio.test.ts` | 20 | Portfolio snapshot, P&L, equity curve |
| `research.test.ts` | 10 | ResearchService analysis |
| `simulated.test.ts` | 20 | SimulatedExchange paper trading |
| `themes.test.ts` | 36 | Theme framework (runner, store, sub-accounts) |
| `trading-pipeline.test.ts` | 4 | AgentTradingPipeline |

### Test Patterns

- **In-memory SQLite**: Each test opens `openDatabase({ path: ":memory:" })` for isolation. No test pollution.
- **supertest**: API tests use `supertest` with real Express app instances.
- **Mock dynamic imports**: Tests mock Alpaca/CCXT dynamic imports to avoid requiring the packages.
- **`async`/`await`**: All database operations are async — test callbacks must be `async`.