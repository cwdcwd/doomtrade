/**
 * Express API routes for DoomTrade.
 *
 * This file re-exports from the split route modules under ./routes/.
 * The createApiRouter function and AppState type are preserved here
 * for backward compatibility with existing imports.
 *
 * Endpoints:
 *   GET  /api/health
 *   POST /api/decisions
 *   GET  /api/decisions
 *   GET  /api/decisions/:id
 *   POST /api/trade
 *   GET  /api/trades
 *   GET  /api/trades/analytics
 *   GET  /api/trades/:id
 *   GET  /api/portfolio
 *   GET  /api/portfolio/history
 *   GET  /api/positions
 *   GET  /api/market/quote?symbol=BTC/USDT
 *   GET  /api/market/bars?symbol=BTC/USDT&timeframe=1Day&range=3m
 *   GET  /api/market/snapshot?symbols=BTC/USDT,ETH/USDT
 *   GET  /api/market/quote/:symbol
 *   GET  /api/market/bars/:symbol
 *   GET  /api/research/analyze?symbol=BTC/USDT&timeframe=1Day&range=6m
 *   POST /api/mode
 *   GET    /api/themes
 *   POST   /api/themes
 *   GET    /api/themes/:id
 *   PATCH  /api/themes/:id
 *   DELETE /api/themes/:id
 *   POST   /api/themes/:id/evaluate
 *   GET    /api/themes/:id/evaluations
 *   GET    /api/themes/:id/performance
 *   POST   /api/agents
 *   GET    /api/agents
 *   GET    /api/agents/leaderboard
 *   GET    /api/agents/:id
 *   PATCH  /api/agents/:id
 *   DELETE /api/agents/:id
 *   GET    /api/agents/:id/portfolio
 *   GET    /api/agents/:id/positions
 *   GET    /api/agents/:id/trades
 *   GET    /api/agents/:id/analytics
 *   POST   /api/agents/:id/evaluate
 *   POST   /api/agents/:id/trade
 *   POST   /api/agents/a2a-cycle
 *   POST /api/admin/reset
 */

export { createApiRouter, type AppState } from "./routes/index.js";
