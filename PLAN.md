# DoomTrade — Agent-Managed Trading Platform

## Plan Document

### Overview

A TypeScript/Node.js application that lets Doom and Kangbot collaboratively research stocks and crypto, log trading decisions with rationale, and execute trades in either **simulated** (paper) or **live** mode. Deployed on Railway.

---

### Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    DoomTrade App                          │
│                                                           │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐ │
│  │ Research │  │ Decision │  │ Portfolio│  │  Trade   │ │
│  │  Module  │  │   Log    │  │  Engine  │  │ Executor │ │
│  │          │  │          │  │          │  │          │ │
│  │ Market   │  │ Agent    │  │ Positions│  │ Sim Mode │ │
│  │ Data     │  │ Decision │  │ P&L      │  │ Live Mode│ │
│  │ News     │  │ Rationale│  │ History  │  │          │ │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘ │
│       │              │              │              │       │
│       └──────────────┴──────┬───────┴──────────────┘       │
│                             │                              │
│                    ┌────────▼────────┐                     │
│                    │   Trade Engine   │                     │
│                    │   (core/orch.)   │                     │
│                    └────────┬────────┘                     │
│                             │                              │
│              ┌──────────────┼──────────────┐               │
│              ▼              ▼              ▼               │
│     ┌──────────────┐ ┌──────────────┐ ┌──────────────┐    │
│     │   Alpaca     │ │    CCXT      │ │  Simulated   │    │
│     │  (Stocks +   │ │  (Crypto:    │ │  Exchange    │    │
│     │   Crypto)    │ │  Binance,    │ │  (in-memory  │    │
│     │              │ │  Coinbase…)  │ │  paper P&L)   │    │
│     └──────────────┘ └──────────────┘ └──────────────┘    │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐  │
│  │                    Storage                           │  │
│  │  ┌────────────┐  ┌────────────┐  ┌──────────────┐  │  │
│  │  │  SQLite    │  │  JSON Log  │  │  Portfolio   │  │  │
│  │  │ (trades,   │  │  (decisions│  │  State File  │  │  │
│  │   positions) │  │   rationale)│  │  (snapshot)  │  │  │
│  │  └────────────┘  └────────────┘  └──────────────┘  │  │
│  └─────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘

         A2A (JSON-RPC)            A2A (JSON-RPC)
    Doom ◄──────────────────► Kangbot ◄──────────────► Doom
    (devpi03)                    (devpi02)
```

---

### Tech Stack

- **Runtime**: Node.js 20+ (we have v26) — matches Alpaca SDK requirement
- **Language**: TypeScript (strict) — type safety for financial data
- **Framework**: Express.js — simple REST API, Railway-friendly
- **Stocks API**: `@alpacahq/alpaca-trade-api` v4 — official, paper+live, stocks+crypto
- **Crypto API**: `ccxt` v4 — 100+ exchanges, unified interface
- **Database**: SQLite (better-sqlite3) — zero-config, file-based, Railway volumes
- **Testing**: Vitest — consistent with agent-bridge project
- **Validation**: Zod — consistent with agent-bridge project
- **Deployment**: Railway — auto-deploy from GitHub, env vars for API keys
- **Agent Coordination**: `@cwdcwd/agent-bridge` — our own library, dogfooding

---

### Module Breakdown

#### 1. Market Data Module (`src/market/`)
- Fetch real-time quotes, bars (OHLCV), snapshots for stocks via Alpaca
- Fetch real-time tickers, OHLCV for crypto via CCXT
- Unified interface: `getQuote(symbol)`, `getBars(symbol, timeframe, range)`, `getSnapshot(symbols[])`
- Symbol normalization: `AAPL` (stock), `BTC/USDT` (crypto) — auto-detect by format

#### 2. Decision Log Module (`src/decision/`)
- Structured log of every trading decision with:
  - Timestamp, agent name (doom/kangbot), symbol, action (buy/sell/hold), quantity
  - Rationale (free text — why the agent decided this)
  - Confidence (1-10)
  - Market context snapshot (price at decision time, relevant indicators)
  - Mode (sim/live)
- Stored in SQLite, queryable by agent, symbol, date range
- API endpoints: `POST /decisions`, `GET /decisions`, `GET /decisions/:id`

#### 3. Trade Engine (`src/engine/`)
- The orchestrator. Takes a decision from the Decision Log and routes it to the right executor.
- Pre-trade validation: position limits, daily loss limits, duplicate order detection
- Post-trade logging: records fill price, fees, P&L impact
- Mode toggle: `SIM` (all trades go to simulated exchange) vs `LIVE` (real API calls)
- Risk checks: max position size, max open positions, daily trade limit, max drawdown

#### 4. Trade Executor (`src/executor/`)
- **SimulatedExchange**: In-memory order book. Tracks virtual balance, fills at current price, computes P&L in real-time. Persists state to SQLite.
- **AlpacaExecutor**: Wraps `@alpacahq/alpaca-trade-api` for live/paper stock trades. Supports market, limit, and stop orders.
- **CCXTExecutor**: Wraps `ccxt` for live/paper crypto trades on Binance, Coinbase, etc.
- Unified interface: `placeOrder(order)`, `cancelOrder(id)`, `getPositions()`, `getBalance()`

#### 5. Portfolio Module (`src/portfolio/`)
- Real-time position tracking (sim + live)
- P&L calculation: unrealized (open positions) + realized (closed trades)
- Portfolio snapshot: total equity, cash, positions, exposure
- History: equity curve over time
- API endpoints: `GET /portfolio`, `GET /portfolio/history`, `GET /positions`

#### 6. API Layer (`src/api/`)
- Express REST API with typed Zod-validated routes:
  - `GET /health` — health check (for Railway)
  - `GET /api/market/quote/:symbol` — get current price
  - `GET /api/market/bars/:symbol` — get OHLCV bars
  - `POST /api/decisions` — log a new trading decision
  - `GET /api/decisions` — list decisions (filterable)
  - `POST /api/trade` — execute a trade (routes to sim or live based on config)
  - `GET /api/portfolio` — current portfolio state
  - `GET /api/positions` — open positions
  - `POST /api/mode` — toggle sim/live mode (requires confirmation for live)

---

### Safety Design

- **Accidental live trades**: Default mode is SIM. Switching to LIVE requires `TRADE_MODE=live` env var AND a `POST /api/mode` confirmation with a 60-second cooldown.
- **API key exposure**: Keys stored in Railway env vars, never committed. `.env` in `.gitignore`.
- **Agent going rogue**: Max position size, max open positions (default 10), daily trade limit (default 20), max drawdown (15%) — all configurable, hard stops in Trade Engine.
- **Sim/live confusion**: Every API response includes `mode: "sim" | "live"` field. Sim mode uses clearly fake balance ($100,000 paper money). Live mode shows real account equity.
- **Data loss**: SQLite DB persisted to Railway volume. Portfolio state checkpointed every trade. Decision log is append-only.

---

### Agent Division of Labor

- **Doom**: Market data module, API layer, portfolio module, deployment config, agent-bridge integration, CI
- **Kangbot**: Trade executor (sim + live), decision log module, trade engine risk checks

Both agents use `@cwdcwd/agent-bridge` to coordinate — dogfooding our library.

---

### Deployment Plan

1. **Repo**: `cwdcwd/doomtrade` on GitHub
2. **Railway**: Auto-deploy from `main` branch
3. **Environment Variables** (Railway):
   - `ALPACA_API_KEY_ID` — Alpaca API key
   - `ALPACA_API_SECRET_KEY` — Alpaca secret
   - `ALPACA_PAPER` — `true` (paper trading by default)
   - `CCXT_EXCHANGE` — `binance` (default crypto exchange)
   - `CCXT_API_KEY` — exchange API key
   - `CCXT_API_SECRET` — exchange API secret
   - `TRADE_MODE` — `sim` (default) or `live`
   - `DATABASE_PATH` — `/data/doomtrade.db` (Railway volume)
   - `PORT` — Railway-provided
4. **Build**: `npm run build` (tsc → dist/)
5. **Start**: `node dist/index.js`
6. **Healthcheck**: `GET /health` endpoint

---

### Issue Breakdown

1. **Scaffold project + Railway config** (Doom) — package.json, tsconfig, Express setup, .env.example, health endpoint
2. **Market data module (Alpaca + CCXT)** (Doom) — src/market/ unified quote/bars/snapshot interface
3. **Decision log module + SQLite schema** (Kangbot) — src/decision/ Zod schemas, SQLite tables, CRUD
4. **Simulated exchange executor** (Kangbot) — src/executor/simulated.ts in-memory order book, virtual balance, P&L
5. **Live executors (Alpaca + CCXT)** (Kangbot) — src/executor/alpaca.ts, ccxt.ts wrapping SDKs
6. **Trade engine with risk checks** (Kangbot) — src/engine/ pre-trade validation, mode routing, post-trade logging
7. **Portfolio module (P&L, positions)** (Doom) — src/portfolio/ real-time tracking, equity curve, history
8. **API layer (Express routes + Zod)** (Doom) — src/api/ all REST endpoints, typed validation
9. **Agent integration via agent-bridge** (Doom) — A2A coordination for programmatic decision submission
10. **CI workflow + Railway deployment docs** (Doom) — GitHub Actions CI, README deployment guide

---

### File Structure

```
doomtrade/
├── src/
│   ├── index.ts              # Entry point — starts Express server
│   ├── config.ts             # Env var loading + validation
│   ├── market/
│   │   ├── market.ts         # Unified market data interface
│   │   ├── alpaca-data.ts    # Alpaca market data adapter
│   │   └── ccxt-data.ts      # CCXT crypto market data adapter
│   ├── decision/
│   │   ├── decision.ts       # Decision model + Zod schema
│   │   └── decision-store.ts # SQLite persistence
│   ├── executor/
│   │   ├── executor.ts       # Executor interface
│   │   ├── simulated.ts      # Simulated exchange (paper trading)
│   │   ├── alpaca.ts         # Alpaca live/paper executor
│   │   └── ccxt.ts           # CCXT crypto executor
│   ├── engine/
│   │   └── trade-engine.ts   # Orchestrator + risk checks
│   ├── portfolio/
│   │   ├── portfolio.ts      # Portfolio state + P&L
│   │   └── positions.ts      # Position tracking
│   ├── api/
│   │   ├── routes.ts         # Express route definitions
│   │   └── schemas.ts        # Zod request/response schemas
│   └── db/
│       └── database.ts      # SQLite connection + migrations
├── tests/
│   ├── market.test.ts
│   ├── decision.test.ts
│   ├── simulated.test.ts
│   ├── engine.test.ts
│   ├── portfolio.test.ts
│   └── api.test.ts
├── package.json
├── tsconfig.json
├── .env.example
├── .gitignore
└── README.md
```