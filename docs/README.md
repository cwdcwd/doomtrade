# DoomTrade Documentation

> Agent-managed stock and crypto trading platform. TypeScript/Node.js, Express, dual-database (SQLite/Postgres), deployed on Railway.

## Documentation Index

| Document | Description |
| --- | --- |
| [Architecture](ARCHITECTURE.md) | System architecture, subsystem overview, trade execution flow, mermaid diagrams |
| [API Reference](API_REFERENCE.md) | Full REST API documentation with examples for every endpoint |
| [Themes Framework](THEMES.md) | Automated strategy framework — signal sources, strategies, scheduling, sub-accounts |
| [Agent System](AGENTS.md) | Per-agent trading — independent portfolios, risk checks, A2A communication, leaderboard |
| [Database & Config](DEPLOYMENT_AND_CONFIG.md) | Schema (ER diagram), environment variables, CLI tools, deployment, testing |

## Quick Start

```bash
# Clone and install
git clone https://github.com/cwdcwd/doomtrade.git
cd doomtrade
npm install

# Run in sim mode (paper trading, $100K virtual balance)
npm run dev

# Run tests
npx vitest run
```

## What is DoomTrade?

DoomTrade is an agent-managed trading platform where AI agents (Doom, Kangbot, ThanosBot) trade stocks and crypto with independent portfolios, risk-managed execution, and automated strategies.

### Key Capabilities

- **Dual-mode trading**: Sim ($100K paper) or live (Alpaca for stocks, CCXT/Kraken for crypto)
- **Agent portfolios**: Each agent has independent balance, positions, and trade history with per-agent risk checks
- **Automated strategies**: Congress follower, momentum rotation, and agent-driven strategies via the Themes framework
- **Technical research**: SMA, EMA, RSI indicators with buy/sell/neutral signals
- **A2A integration**: Agents communicate and coordinate via Agent-to-Agent protocol
- **414+ tests**: Full test coverage across all subsystems

### Architecture at a Glance

```
DoomTrade
├── API Layer (Express + Zod + API Key Auth)
├── Decision Log (append-only, Zod-validated)
├── Trade Engine (risk checks → executor → trade logging)
├── Executors
│   ├── SimulatedExchange (paper trading)
│   ├── AlpacaExecutor (live stocks)
│   ├── CCXTExecutor (live crypto)
│   └── AgentExchange (per-agent portfolios)
├── Portfolio (P&L, equity curve, position tracking)
├── Market Data (Alpaca + CCXT, auto-routing by symbol)
├── Research (SMA, EMA, RSI, signals)
├── Themes Framework
│   ├── CongressFollower strategy
│   ├── MomentumRotation strategy
│   └── AgentDriven strategy
├── Agent System
│   ├── AgentManager (registry, leaderboard)
│   ├── AgentTradingPipeline (autonomous execution)
│   └── AgentCoordinator (A2A communication)
└── Database (SQLite for dev, Postgres for production)
```

### Default Agents

| Agent | Strategy | Starting Balance |
| --- | --- | --- |
| Doom | momentum-rotation | $100,000 |
| Kangbot | congress-follower | $100,000 |
| ThanosBot | momentum-rotation | $100,000 | Screens crypto universe for momentum (was agent-driven) |

### CLI Tools

```bash
npx tsx scripts/trade.ts --symbol BTC/USDT --action buy --qty 0.01 --rationale "Bullish" --confidence 8
npx tsx scripts/status.ts --portfolio
npx tsx scripts/history.ts --analytics
npx tsx scripts/research.ts --symbol AAPL
```

## Project Structure

```
doomtrade/
├── src/
│   ├── agent/          # Agent manager, trading pipeline
│   ├── api/            # Express routes, Zod schemas, auth
│   ├── db/             # Database abstraction (SQLite + Postgres)
│   ├── decision/       # Append-only decision log
│   ├── engine/         # Trade engine + agent trade engine
│   ├── executor/       # Executor interface + implementations
│   ├── integration/    # A2A agent coordination
│   ├── market/         # Market data service (Alpaca + CCXT)
│   ├── portfolio/      # Portfolio tracking, P&L, equity curve
│   ├── research/       # Technical indicators + research service
│   ├── themes/         # Automated strategy framework
│   ├── config.ts       # Zod-validated env config
│   └── index.ts        # Entry point
├── scripts/            # CLI tools
├── tests/              # 405+ vitest tests
├── docs/               # This documentation
├── public/             # Dashboard (Datastar)
└── railway.json         # Railway deployment config
```

## License

Private project. See repository for details.