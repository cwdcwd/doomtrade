/**
 * Dashboard API routes — public read-only batch endpoint.
 *
 * GET /api/dashboard
 *
 * Returns everything the dashboard renders in ONE request:
 * agents, leaderboard, per-agent portfolio/positions/trades/analytics,
 * market snapshot, per-symbol research (RSI + signal), health/mode.
 *
 * Public (no API key): the dashboard is read-only for humans; all
 * mutations remain key-gated for fleet machines (crons, A2A).
 *
 * Server-side caching keeps this cheap under anonymous load:
 *   - payload cached 5s (dashboard polls every 10s)
 *   - market snapshot cached 60s (Kraken)
 *   - research/analysis cached 5 min (expensive: ~3s Kraken fetch per symbol)
 * Cache is shared across ALL anonymous viewers — N browsers cost the
 * upstream exchanges 1 set of fetches, not N.
 */

import { Router, type Request, type Response } from "express";
import { type AppState } from "./types.js";

const TICKER_SYMBOLS = [
  "BTC/USDT",
  "ETH/USDT",
  "SOL/USDT",
  "XRP/USDT",
  "ADA/USDT",
  "DOGE/USDT",
  "AVAX/USDT",
];

const RECENT_TRADES_LIMIT = 5;

/** Generic memo cache: value + expiry. */
function createCache() {
  const store = new Map<string, { value: unknown; expiresAt: number }>();
  return {
    async get<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
      const hit = store.get(key);
      const now = Date.now();
      if (hit && hit.expiresAt > now) return hit.value as T;
      const value = await load();
      store.set(key, { value, expiresAt: now + ttlMs });
      return value;
    },
  };
}

export function createDashboardRouter(state: AppState): Router {
  const router = Router();
  const cache = createCache();

  router.get("/dashboard", async (_req: Request, res: Response) => {
    try {
      // ── Agents (5s cache) ──────────────────────────────────────
      // Only active agents — same policy as the leaderboard. Inactive
      // agents (e.g. a retired TestAgent) are hidden from the public view.
      const agents = await cache.get("agents", 5_000, async () => {
        if (!state.agentManager) return [];
        const all = await state.agentManager.list();
        return all.filter((a) => a.active);
      });

      const leaderboard = await cache.get("leaderboard", 5_000, async () => {
        if (!state.agentManager) return [];
        return state.agentManager.leaderboard();
      });

      // ── Per-agent details (5s cache) ────────────────────────────
      const details = await Promise.all(
        agents.map(async (a) => {
          const [portfolio, positions, trades, analytics] = await Promise.all([
            cache.get(`pf:${a.id}`, 5_000, () =>
              state.agentTradeEngine?.getPortfolio(a.id) ?? Promise.resolve(null)),
            cache.get(`pos:${a.id}`, 5_000, () =>
              state.agentTradeEngine?.getPositions(a.id) ?? Promise.resolve([])),
            cache.get(`trd:${a.id}`, 5_000, () =>
              state.agentTradeEngine?.getTrades(a.id, RECENT_TRADES_LIMIT) ?? Promise.resolve([])),
            cache.get(`ana:${a.id}`, 5_000, () =>
              state.agentTradeEngine?.getAnalytics(a.id) ?? Promise.resolve(null)),
          ]);
          return { agent: a, portfolio, positions, trades, analytics };
        }),
      );

      // ── Market ticker (60s cache — Kraken upstream) ─────────────
      const snapshots = await cache.get("mkt:snap", 60_000, async () => {
        if (!state.marketData) return [];
        try {
          return await state.marketData.getSnapshot(TICKER_SYMBOLS);
        } catch {
          return [];
        }
      });

      // ── Research: RSI + combined signal per symbol (5 min cache) ─
      const research = await Promise.all(
        TICKER_SYMBOLS.map(async (symbol) => {
          try {
            const analysis = await cache.get(`rsrch:${symbol}`, 300_000, () => {
              if (!state.research) return Promise.resolve(null);
              return state.research
                .analyze(symbol, "1Day", "1m")
                .catch(() => null);
            });
            return { symbol, analysis };
          } catch {
            return { symbol, analysis: null };
          }
        }),
      );

      res.json({
        mode: state.currentMode,
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        agents: details,
        leaderboard,
        market: { snapshots, research },
      });
    } catch (err) {
      res.status(500).json({ error: "Failed to build dashboard payload" });
    }
  });

  return router;
}