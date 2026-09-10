# DoomTrade

Agent-managed stock and crypto trading platform. Doom and Kangbot research markets, log decisions with rationale, and execute trades in simulated or live mode.

## Architecture

```
Research → Decision Log → Trade Engine → Executor (Sim/Alpaca/CCXT)
                ↑               ↓            ↓
            Portfolio ← P&L ← Positions ← Fills
```

| Module | Path | Description |
|--------|------|-------------|
| Market Data | `src/market/` | Unified quote/bars/snapshot via Alpaca (stocks) + CCXT (crypto) |
| Decision Log | `src/decision/` | Zod-validated decisions stored in SQLite |
| Trade Engine | `src/engine/` | Risk checks → executor routing → trade logging |
| Executors | `src/executor/` | SimulatedExchange, AlpacaExecutor, CCXTExecutor |
| Portfolio | `src/portfolio/` | Real-time positions, P&L, equity curve history |
| API | `src/api/` | Express REST with Zod validation on all routes |
| Agent Integration | `src/integration/` | A2A coordination via @cwdcwd/agent-bridge |

## Quick Start

```bash
npm install
npm run dev     # start dev server
npm test        # run tests (229 tests, 10 files)
npm run build   # compile to dist/
```

## API Endpoints

**Auth policy**: all `GET` endpoints are **public** (read-only dashboard for humans — no API key, no sign-in). All mutations (`POST`/`PATCH`/`DELETE`) require `DOOMTRADE_API_KEY` via `Authorization: Bearer` or `X-API-Key` (fleet crons + A2A agents).

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check (for Railway) |
| GET | `/api/health` | API health with mode info |
| GET | `/api/dashboard` | **Public** batch endpoint powering the dashboard UI — one request returns everything (agents, leaderboard, per-agent portfolio/positions/trades/analytics, market ticker, research). Server-cached: 5s agents, 60s market, 5min research. |
| POST | `/api/decisions` | Log a new trading decision 🔑 |
| GET | `/api/decisions` | List decisions (filterable) |
| GET | `/api/decisions/:id` | Get a single decision |
| POST | `/api/trade` | Execute a trade from a decision 🔑 |
| GET | `/api/trades` | List trades (filterable) |
| GET | `/api/trades/:id` | Get a single trade |
| GET | `/api/portfolio` | Current portfolio state + P&L |
| GET | `/api/portfolio/history` | Equity curve history |
| GET | `/api/positions` | Open positions |
| POST | `/api/mode` | Toggle sim/live mode (60s cooldown, confirm required for live) 🔑 |

🔑 = requires API key (mutation). Full reference: [docs/API_REFERENCE.md](docs/API_REFERENCE.md).

The web dashboard (`/`) is a **read-only public monitor** — it polls `GET /api/dashboard` every 10 seconds and requires zero setup from viewers. Trading runs on the fleet agents' cron cycles, not from the UI.

## Safety

- Default mode is **SIM** (simulated trading with $100k paper money)
- Switching to **LIVE** requires `TRADE_MODE=live` env var + API confirmation with 60s cooldown
- Risk limits (all configurable): max 10 positions, 20% max position size, 20 trades/day, 15% max drawdown
- Every API response includes `mode: "sim" | "live"` field

## Deployment (Railway)

### Prerequisites

1. A Railway account with a project
2. A GitHub repo connected to Railway for auto-deploy
3. API keys for Alpaca (stocks) and/or CCXT exchange (crypto) — only needed for live mode

### Environment Variables

Set these in Railway → Variables:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | Auto (Railway) | 3000 | Server port |
| `TRADE_MODE` | No | `sim` | `sim` or `live` |
| `ALPACA_API_KEY_ID` | Live stocks | — | Alpaca API key |
| `ALPACA_API_SECRET_KEY` | Live stocks | — | Alpaca secret |
| `ALPACA_PAPER` | No | `true` | Use Alpaca paper trading endpoint |
| `CCXT_EXCHANGE` | No | `binance` | Crypto exchange id |
| `CCXT_API_KEY` | Live crypto | — | Exchange API key |
| `CCXT_API_SECRET` | Live crypto | — | Exchange API secret |
| `DATABASE_PATH` | No | `./data/doomtrade.db` | SQLite path (use Railway volume) |
| `MAX_OPEN_POSITIONS` | No | `10` | Max concurrent positions |
| `MAX_POSITION_SIZE_PCT` | No | `20` | Max % of equity per position |
| `DAILY_TRADE_LIMIT` | No | `20` | Max trades per day |
| `MAX_DRAWDOWN_PCT` | No | `15` | Max drawdown before blocking trades |
| `SIM_STARTING_BALANCE` | No | `100000` | Sim paper money balance |
| `SIM_FEE_PCT` | No | `0.1` | Sim fee percentage |

### Deploy Steps

1. Push to `main` branch — Railway auto-deploys
2. Add a Railway volume mounted at `/data` for persistent SQLite
3. Set `DATABASE_PATH=/data/doomtrade.db` to use the volume
4. Railway runs `npm run build` then `node dist/index.js`
5. Healthcheck: `GET /health` (Railway monitors this)

### Local Development

```bash
cp .env.example .env  # fill in API keys if testing live mode
npm install
npm run dev
```

## CI

GitHub Actions runs on every push to `main` and PR:
- `npm ci` — install dependencies
- `tsc --noEmit` — type check
- `vitest run` — run all tests
- `npm run build` — verify build

## Agent Integration

DoomTrade uses `@cwdcwd/agent-bridge` for A2A coordination between Doom and Kangbot:

- `AgentCoordinator` wraps `DecisionStore` + `TradeEngine` + `Portfolio`
- Agents submit decisions programmatically via `submitDecision()`
- Peer agent gets notified of decisions, trade executions, and risk blocks
- See `src/integration/agent-integration.ts`

## License

MIT