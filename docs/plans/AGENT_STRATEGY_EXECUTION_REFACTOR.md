# Agent Strategy Execution Refactor

**Created:** 2026-09-08
**Status:** Planning → Execution
**Problem:** Strategies execute trades via `ThemeSubAccount` (writes to `theme_subaccounts` / `sim_sub_positions` / `sim_sub_orders`), but agent API endpoints read from `agent_balance` / `agent_positions` / `agent_orders`. Trades executed by the `AgentTradingPipeline` are invisible to the agent portfolio/positions/trades endpoints.

## Root Cause

All three strategies (`momentum-rotation`, `congress-follower`, `agent-driven`) create a `ThemeSubAccount` directly:

```ts
const subAccount = new ThemeSubAccount(ctx.db, config.id, { ... });
```

They then call `subAccount.getBalance()`, `subAccount.getPositions()`, and `subAccount.placeOrder()`. These read/write the theme sub-account tables.

The `AgentTradingPipeline.runAgentCycle()` passes the agent's `AgentExchange` through `ThemeContext` (`getEquity`, `getPositions`, `getQuote`), but the strategies **ignore those context methods** and create their own `ThemeSubAccount` instead. So the agent's exchange is never used for trade execution.

## Solution

Add an optional `exchange` field to `ThemeContext` that provides the same `Executor` interface (`placeOrder`, `getBalance`, `getPositions`). When the pipeline builds context for an agent, it passes the `AgentExchange`. When the theme runner builds context, it passes a `ThemeSubAccount` (unchanged). Strategies use `ctx.exchange` when available, falling back to creating a `ThemeSubAccount` only when `ctx.exchange` is absent.

### Changes

#### 1. Extend `ThemeContext` (src/themes/strategy.ts)

Add optional `exchange` field:

```ts
export interface ThemeContext {
  // ... existing fields ...
  /** Optional executor for trade execution. When provided, strategies
   *  should use this instead of creating a ThemeSubAccount. */
  exchange?: import("../executor/executor.js").Executor;
}
```

#### 2. Update `AgentTradingPipeline.buildContext()` (src/agent/trading-pipeline.ts)

Pass the `AgentExchange` as `ctx.exchange`:

```ts
private async buildContext(agentId: string, exchange: AgentExchange): Promise<ThemeContext> {
  return {
    db: this.config.db,
    marketData: this.config.marketData,
    decisionStore: null as any,
    tradeEngine: null as any,
    portfolio: null as any,
    themeId: agentId,
    exchange,  // ← NEW: strategies will use this
    getEquity: async () => { ... },  // unchanged
    getPositions: async () => { ... },  // unchanged
    getQuote: async (symbol) => { ... },  // unchanged
  };
}
```

#### 3. Update `ThemeRunner.buildContext()` (src/themes/theme-runner.ts)

Pass the `ThemeSubAccount` as `ctx.exchange` (it already implements `Executor`):

```ts
return {
  // ... existing fields ...
  exchange: subAccount,  // ← NEW: same object, now also accessible via ctx.exchange
};
```

#### 4. Update all three strategies

Replace the `new ThemeSubAccount(ctx.db, config.id, ...)` pattern with:

```ts
// Use ctx.exchange if provided (agent pipeline), otherwise create a sub-account (theme runner)
const subAccount = ctx.exchange ?? new ThemeSubAccount(ctx.db, config.id, { ... });
```

This is a one-line change per strategy — the rest of the code stays the same because both `AgentExchange` and `ThemeSubAccount` implement the `Executor` interface with the same method signatures (`getBalance()`, `getPositions()`, `placeOrder()`).

**Files to change:**
- `src/themes/strategies/momentum-rotation.ts` — use `ctx.exchange` fallback
- `src/themes/strategies/congress-follower.ts` — use `ctx.exchange` fallback
- `src/themes/strategies/agent-driven.ts` — use `ctx.exchange` fallback

#### 5. Remove `ensureSubAccount()` from the pipeline

The `ensureSubAccount()` method in `AgentTradingPipeline` was a workaround that created theme rows and sub-account rows to satisfy the FK constraint. Once strategies use `ctx.exchange` (the `AgentExchange`), they no longer create `ThemeSubAccount` instances, so the sub-account tables are never touched. The `ensureSubAccount()` method can be removed entirely.

**However**, the `ThemeStore.recordSignal()` calls in the strategies still write to `theme_signals` which has a FK on `theme_id → themes(id)`. So we still need the theme row to exist. Move just the theme row creation to `buildContext()` and drop the sub-account part.

#### 6. Remove the `ensureSubAccount` call from `runAgentCycle()`

Delete the `await this.ensureSubAccount(...)` line. The theme row creation (for signal dedup FK) moves to a simpler `ensureThemeRow()` method.

#### 7. Update tests

- `tests/congress-follower.test.ts` — pass `exchange` in context (or verify fallback works)
- `tests/trading-pipeline.test.ts` — verify exchange is passed through
- `tests/a2a-trading-coordinator.test.ts` — verify trades now show up in agent tables
- `tests/agent-api.test.ts` — add test: after evaluate, positions and trades are visible via agent API

### Verification

1. `npm run build` — tsc clean
2. `npx vitest run` — all tests pass
3. Deploy to Railway
4. `POST /api/agents/:id/evaluate` on Kangbot
5. `GET /api/agents/:id/positions` — should show the position
6. `GET /api/agents/:id/trades` — should show the trade
7. `GET /api/agents/:id/portfolio` — cash should be reduced, equity should include position value
8. `GET /api/agents/leaderboard` — should reflect the updated equity

### What This Does NOT Change

- Theme runner behavior (strategies still use ThemeSubAccount when run via themes)
- AgentExchange implementation (no changes needed — already implements Executor)
- ThemeSubAccount implementation (no changes needed — still used by theme runner)
- Strategy logic (signals, allocation checks, dedup — all unchanged)
- API endpoints (no changes needed)