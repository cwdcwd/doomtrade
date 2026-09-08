# DoomTrade — Roadmap & Implementation Plan

**Last updated:** 2026-09-08
**Status:** Live on Railway (sim mode), 330 tests passing, 10 beads issues (9 closed, 1 in progress)

---

## Current State

### What's Built

| Component | Status | Details |
|-----------|--------|---------|
| **API Server** | ✅ Live | Express.js on Railway, API key auth, 27 endpoints |
| **Database** | ✅ Live | Dual-mode: Postgres (production) / SQLite (dev). Migrations, async query layer. |
| **Simulated Exchange** | ✅ Live | In-memory paper trading with slippage, fees, position tracking |
| **Decision Log** | ✅ Live | Agent decisions with rationale, confidence, market context |
| **Trade Engine** | ✅ Live | Risk checks (max positions, position size, daily limit, drawdown), order execution |
| **Market Data (Crypto)** | ✅ Live | CCXT/Kraken public price feeds — real-time crypto quotes & bars |
| **Market Data (Stocks)** | ❌ Not built | Alpaca adapter exists but needs API keys. Alpha Vantage not integrated. |
| **Research Module** | ✅ Built | SMA 20/50, RSI 14 technical indicators from bars data |
| **Portfolio Engine** | ✅ Live | Equity tracking, P&L (realized + unrealized), position history, checkpoints |
| **Themes Framework** | ✅ Built | ThemeRunner, ThemeStore, 3 strategies, 4 signal sources, API CRUD + evaluation |
| **Dashboard** | ✅ Built | Datastar SPA — portfolio view, P&L, theme comparison, audit trail |
| **A2A Integration** | ✅ Scaffolded | AgentCoordinator wraps A2AClient for Doom/Kangbot coordination. Not wired to scheduler. |
| **Deployment** | ✅ Live | Railway, Postgres, auto-deploy from main, healthcheck |

### What's Deployed on Railway

- **URL:** https://doomtrade-production.up.railway.app/
- **Mode:** Sim (paper trading, $100K virtual balance)
- **Database:** Postgres (survives redeploys — verified)
- **Auth:** API key required for all `/api/*` routes except `/api/health`
- **Price feed:** Kraken via CCXT (Binance geo-blocked from US)
- **Current position:** 0.01 BTC/USDT @ $79,127.80 (test trade, persisted)

### Beads Issue Tracker

| ID | Title | Status | Owner |
|----|-------|--------|-------|
| doomtrade-303 | Trade history CLI and performance analytics | ◐ In Progress | Kangbot |
| doomtrade-bzo | Research module with SMA 20/50 and RSI 14 | ✓ Closed | Kangbot |
| doomtrade-cpb | CCXT public market data | ✓ Closed | Kangbot |
| doomtrade-e6r | Decision log + SQLite + simulated executor | ✓ Closed | Kangbot |
| doomtrade-fos | Themes API endpoints | ✓ Closed | Kangbot |
| doomtrade-xtm | Experimental themes core framework | ✓ Closed | Kangbot |
| doomtrade-peq | Congress Follower strategy | ✓ Closed | Kangbot |
| doomtrade-whs | Momentum Rotation strategy | ✓ Closed | Doom |
| doomtrade-yns | Agent-Driven strategy | ✓ Closed | Doom |
| doomtrade-7ad | Themes evaluation dashboard | ✓ Closed | Doom |

---

## Roadmap

### Phase 1: Market Data Expansion (Stocks)

**Goal:** Enable stock trading in sim mode alongside crypto.

#### 1.1 Alpha Vantage Integration

Add Alpha Vantage as a market data provider for US stocks. Free tier: 25 requests/day, 5 req/min. Sufficient for daily research and end-of-day quotes.

- **New file:** `src/market/alphavantage-data.ts` — implements `MarketDataService` interface
- **Config:** `ALPHAVANTAGE_API_KEY` env var
- **Routing:** `createMarketDataService` routes stock symbols (AAPL, TSLA) to Alpha Vantage, crypto symbols (BTC/USDT) to CCXT
- **Endpoints:** `getQuote`, `getBars` (daily/weekly), `getSnapshot`
- **Rate limiting:** Client-side throttle to stay within free tier (25/day)
- **Tests:** Unit tests with mocked HTTP responses

**Issue:** Create bead — `Alpha Vantage market data provider for US stocks`

#### 1.2 Alpaca Paper Trading (Live Stock Prices)

Alpha Vantage free tier is end-of-day only. For real-time stock prices during sim trading, use Alpaca's paper trading API (free, no daily limit).

- **Existing:** `src/market/alpaca-data.ts` and `src/executor/alpaca.ts` already scaffolded
- **Config:** `ALPACA_API_KEY_ID`, `ALPACA_API_SECRET_KEY` (user provides)
- **Enable:** Set `TRADE_MODE=live` or add paper-data mode for sim trading with real prices
- **Tests:** Integration test with Alpaca paper API (requires keys, gated behind env check)

**Issue:** Create bead — `Wire Alpaca paper trading for real-time stock data`

### Phase 2: Autonomous Agent Trading (A2A)

**Goal:** Doom and Kangbot autonomously research, decide, and execute trades in coordination.

#### 2.1 A2A Decision Pipeline

Wire the `AgentCoordinator` (already scaffolded in `src/integration/agent-integration.ts`) to a scheduled loop.

- **Doom's role:** Primary researcher — analyzes market data, generates buy/sell signals, submits decisions
- **Kangbot's role:** Validator — reviews Doom's decisions, can veto or add confidence, executes via trade engine
- **Communication:** A2A protocol via LiteLLM gateway (`https://ai.lan/v1/agents`)
- **Schedule:** Cron-like loop — every N minutes, evaluate active themes, generate decisions, execute
- **State:** Track which decisions are pending review, which are executed, which are rejected

**Issue:** Create bead — `A2A autonomous trading loop: Doom researches, Kangbot validates`

#### 2.2 Theme-Driven Autonomy

Connect the themes framework to the A2A pipeline so agents can:
- Create and evaluate themes programmatically
- Use theme signals as decision inputs
- Track per-theme performance as part of agent coordination

**Issue:** Create bead — `Wire themes framework to A2A agent pipeline`

### Phase 3: Live Trading

**Goal:** Execute real trades with real money. Requires careful gating.

#### 3.1 Alpaca Live Execution

- Enable `TRADE_MODE=live` with real Alpaca keys
- Additional risk checks: position size limits tightened, daily loss limit, manual confirmation for large orders
- Audit log: every live trade recorded with agent, rationale, timestamp, fill price
- Kill switch: `POST /api/mode` to flip back to sim instantly

**Issue:** Create bead — `Live trading mode with Alpaca — risk gates and kill switch`

#### 3.2 CCXT Live Crypto Execution

- Configure Kraken API keys for real crypto trading
- Use Kraken (not Binance) — verified working from Railway
- Same risk gates as Alpaca live mode

**Issue:** Create bead — `Live crypto execution via Kraken/CCXT`

### Phase 4: Analytics & Observability

**Goal:** Track performance, debug decisions, monitor the system.

#### 4.1 Trade Analytics (In Progress — doomtrade-303)

- `GET /api/trades/analytics` — win rate, avg return, Sharpe ratio, max drawdown
- `scripts/history.ts` CLI — query trade history from terminal
- Date range filtering on `GET /api/trades`
- Equity curve data from `GET /api/portfolio/history`

#### 4.2 Decision Audit Trail

- Every decision → trade → outcome linked and queryable
- `GET /api/decisions/:id` includes the resulting trade and P&L impact
- Agent performance comparison (Doom vs Kangbot win rate, avg return)

**Issue:** Create bead — `Decision audit trail and agent performance comparison`

#### 4.3 Dashboard Enhancements

- Real-time portfolio updates via Datastar SSE
- Per-theme P&L chart (already built — verify it works with live data)
- Trade history table with filtering
- Risk metrics display (current drawdown, daily trade count, exposure)

**Issue:** Create bead — `Dashboard: real-time updates, trade history, risk metrics`

### Phase 5: Backtesting

**Goal:** Test strategies against historical data before risking capital.

#### 5.1 Historical Data Replay

- Fetch historical bars from Alpha Vantage (daily, 20+ years available on premium)
- Feed bars through the research module to generate hypothetical decisions
- Execute against a replay-mode simulated exchange (deterministic fills at historical prices)
- Track what the portfolio *would have* looked like

**Issue:** Create bead — `Backtesting engine: historical data replay through trade pipeline`

#### 5.2 Theme Backtesting

- Run each theme strategy against historical data
- Compare theme performance over 1y, 3y, 5y windows
- Optimize allocation parameters

**Issue:** Create bead — `Theme backtesting with historical data`

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    DoomTrade App                             │
│                                                              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐     │
│  │ Research │  │ Decision │  │ Portfolio│  │  Trade   │     │
│  │  Module  │  │   Log    │  │  Engine  │  │ Executor │     │
│  │ SMA/RSI  │  │ Rationale│  │ P&L      │  │ Sim/Live │     │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘     │
│       └──────────────┴───────┬──────┴──────────────┘          │
│                    ┌────────▼────────┐                        │
│                    │  Trade Engine   │                        │
│                    │  (risk checks)  │                        │
│                    └────────┬────────┘                        │
│              ┌──────────────┼──────────────┐                 │
│              ▼              ▼              ▼                   │
│     ┌──────────────┐ ┌────────────┐ ┌──────────────┐         │
│     │   Alpaca     │ │    CCXT    │ │  Simulated   │         │
│     │  (Stocks)    │ │ (Kraken)   │ │  Exchange    │         │
│     └──────────────┘ └────────────┘ └──────────────┘         │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │              Market Data Service                      │    │
│  │  ┌──────────┐  ┌──────────┐  ┌───────────────┐       │    │
│  │  │ Alpha    │  │  CCXT    │  │  Alpaca       │       │    │
│  │  │ Vantage  │  │ (Kraken) │  │  (Stocks)     │       │    │
│  │  │ (EOD)   │  │ (Live)   │  │  (Real-time)  │       │    │
│  │  └──────────┘  └──────────┘  └───────────────┘       │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │              Themes Framework                         │    │
│  │  Congress Follower | Momentum Rotation | Agent-Driven│    │
│  └─────────────────────────────────────────────────────┘    │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │              A2A Coordination                        │    │
│  │  Doom (researcher) ←→ Kangbot (validator)            │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │              Storage (Postgres / SQLite)              │    │
│  │  decisions | trades | sim_positions | portfolio_hist  │    │
│  │  themes | theme_evaluations                           │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3000 | Server port (Railway sets automatically) |
| `TRADE_MODE` | sim | `sim` (paper) or `live` (real orders) |
| `DATABASE_URL` | (empty) | Postgres connection string. If set, uses Postgres. If empty, SQLite. |
| `DATABASE_PATH` | ./data/doomtrade.db | SQLite file path (ignored when DATABASE_URL is set) |
| `DOOMTRADE_API_KEY` | (empty) | API key for auth. If empty, auth disabled (local dev only). |
| `CCXT_EXCHANGE` | binance | Crypto exchange ID. Use `kraken` for Railway (Binance geo-blocked). |
| `CCXT_API_KEY` | (empty) | Exchange API key (for live crypto trading) |
| `CCXT_API_SECRET` | (empty) | Exchange API secret |
| `ALPACA_API_KEY_ID` | (empty) | Alpaca key ID (for live/paper stock trading) |
| `ALPACA_API_SECRET_KEY` | (empty) | Alpaca secret key |
| `ALPACA_PAPER` | true | Use Alpaca paper trading endpoint |
| `ALPHAVANTAGE_API_KEY` | (empty) | **TODO** — Alpha Vantage for EOD stock data |
| `MAX_OPEN_POSITIONS` | 10 | Risk limit: max concurrent positions |
| `MAX_POSITION_SIZE_PCT` | 20 | Risk limit: max % of equity per position |
| `DAILY_TRADE_LIMIT` | 20 | Risk limit: max trades per day |
| `MAX_DRAWDOWN_PCT` | 15 | Risk limit: max drawdown before halting |
| `SIM_STARTING_BALANCE` | 100000 | Sim mode starting cash |
| `SIM_FEE_PCT` | 0.1 | Sim mode fee percentage |

---

## Immediate Next Steps

1. **Finish doomtrade-303** (Kangbot, in progress) — trade analytics endpoint + CLI
2. **Alpha Vantage integration** — add stock data provider, create bead, implement, test
3. **A2A autonomous trading loop** — wire AgentCoordinator to scheduled execution
4. **Dashboard verification** — confirm themes dashboard works with live Railway data
5. **Live trading gates** — additional risk checks before enabling `TRADE_MODE=live`

---

## Coordination

- **Issue tracking:** Beads (`bd`) — all work tracked as issues
- **Agents:** Doom (research, strategy, infrastructure) + Kangbot (implementation, testing, analytics)
- **Communication:** A2A protocol via LiteLLM gateway
- **Deploy:** Railway auto-deploys from `main` branch on push
- **Sync:** `bd dolt push` after closing issues to sync beads data to remote