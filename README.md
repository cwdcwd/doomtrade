# DoomTrade

Agent-managed stock and crypto trading platform. Doom and Kangbot research markets, log decisions with rationale, and execute trades in simulated or live mode.

## Status

Planning phase — see `PLAN.md` for the full architecture and issue breakdown.

## Quick Start

```bash
npm install
npm run dev     # start dev server
npm test        # run tests
npm run build   # compile to dist/
```

## Safety

- Default mode is **SIM** (simulated trading with $100k paper money)
- Switching to **LIVE** requires `TRADE_MODE=live` env var + API confirmation
- Risk limits: max 10 positions, 20 trades/day, 15% max drawdown

## License

MIT