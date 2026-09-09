/**
 * CongressFollower strategy — mirrors trades made by a specific politician.
 *
 * Fetches congressional trade disclosures via the Bargo API, deduplicates
 * against previously processed signals, allocates from the theme's
 * sub-account, creates Decisions, and executes trades.
 *
 * Buys mirror purchase disclosures; when `mirrorAction` is "all", sale
 * disclosures are also mirrored — selling the held quantity of that symbol,
 * never more. Signals are recorded as processed once a *decision* is made
 * (trade placed or explicitly skipped) — not only on fill — so a signal
 * rejected by allocation limits is not re-evaluated every cycle.
 * Disclosures older than `maxSignalAgeDays` (default 30) are ignored: the
 * market has long since priced them in.
 *
 * Strategy type: "congress-follower"
 *
 * Required params:
 * - politician: name of the politician to follow (partial match)
 *
 * Optional params:
 * - mirrorAction: "buys-only" (default) or "all"
 * - maxSignalAgeDays: ignore disclosures older than N days (default 30)
 * - apiKey: Bargo API key (optional, raises rate limits)
 */

import { randomUUID } from "node:crypto";
import type { ThemeStrategy, ThemeContext } from "../strategy.js";
import type { ThemeConfig, ThemeEvaluationResult, ThemeSignal } from "../theme.js";
import type { OrderResult, Position } from "../../executor/executor.js";
import { CongressTradesSignalSource } from "../sources/congress-trades.js";
import { ThemeSubAccount } from "../theme-sub-account.js";
import { ThemeStore } from "../theme-store.js";
import { isWithinAllocationLimit } from "../allocation-check.js";
import { errorMessage } from "../../util/error.js";

interface CongressFollowerParams {
  politician: string;
  mirrorAction?: "buys-only" | "all";
  maxSignalAgeDays?: number;
  apiKey?: string;
}

/** Default maximum age of a disclosure for it to still be actionable. */
const DEFAULT_MAX_SIGNAL_AGE_DAYS = 30;

/** Anything both AgentExchange and ThemeSubAccount satisfy for order placement. */
type OrderPlacer = Pick<NonNullable<ThemeContext["exchange"]>, "placeOrder">;

export class CongressFollowerStrategy implements ThemeStrategy {
  readonly type = "congress-follower";

  async evaluate(ctx: ThemeContext, config: ThemeConfig): Promise<ThemeEvaluationResult> {
    const params = config.params as unknown as CongressFollowerParams;
    const timestamp = new Date().toISOString();
    const errors: string[] = [];

    if (!params.politician) {
      return {
        themeId: config.id,
        timestamp,
        signals: [],
        decisions: [],
        trades: [],
        errors: ["Missing required param: politician"],
      };
    }

    const maxSignalAgeDays = params.maxSignalAgeDays ?? DEFAULT_MAX_SIGNAL_AGE_DAYS;
    const mirrorSells = params.mirrorAction === "all";

    // Fetch signals from Bargo API. Buys-only (default) filters at the API
    // level; mirroring sales fetches both and splits by action below.
    const source = new CongressTradesSignalSource({
      member: params.politician,
      type: mirrorSells ? undefined : "purchase",
      apiKey: params.apiKey,
      limit: 50,
    });

    let signals: ThemeSignal[];
    try {
      signals = await source.fetchSignals();
    } catch (err) {
      return {
        themeId: config.id,
        timestamp,
        signals: [],
        decisions: [],
        trades: [],
        errors: [`Failed to fetch signals: ${errorMessage(err)}`],
      };
    }

    const store = new ThemeStore(ctx.db);

    // Dedup + age filter. Age-expired signals are recorded as processed so
    // they never come back; fresh ones proceed to evaluation. Identical
    // disclosures (same member/symbol/date/action) are collapsed in-cycle.
    const newSignals: ThemeSignal[] = [];
    const seenHashes = new Set<string>();
    for (const signal of signals) {
      const signalHash = this.hashSignal(signal);
      if (seenHashes.has(signalHash)) continue;
      const processed = await store.isSignalProcessed(config.id, signalHash);
      if (processed) continue;
      seenHashes.add(signalHash);

      if (this.signalAgeDays(signal) > maxSignalAgeDays) {
        await store.recordSignal(
          config.id,
          signalHash,
          signal.symbol,
          signal.action,
          signal.metadata as Record<string, unknown>,
        );
        continue;
      }

      newSignals.push(signal);
    }

    if (newSignals.length === 0) {
      return {
        themeId: config.id,
        timestamp,
        signals: [],
        decisions: [],
        trades: [],
        errors: [],
      };
    }

    // Get sub-account for execution — use ctx.exchange (AgentExchange)
    // when provided by the agent pipeline, otherwise fall back to ThemeSubAccount.
    const subAccount =
      ctx.exchange ??
      new ThemeSubAccount(ctx.db, config.id, {
        getCurrentPrice: (symbol: string) => {
          // Synchronous fallback — limit orders carry their own fill price.
          return null;
        },
      });

    // Get current equity for allocation
    let equity = 0;
    try {
      const balance = await subAccount.getBalance();
      equity = balance.equity;
    } catch {
      errors.push("Sub-account not initialized — no capital allocated");
      return {
        themeId: config.id,
        timestamp,
        signals: newSignals,
        decisions: [],
        trades: [],
        errors,
      };
    }

    const decisions: ThemeEvaluationResult["decisions"] = [];
    const trades: ThemeEvaluationResult["trades"] = [];

    // Positions snapshot — refreshed after each fill so allocation checks
    // and sell sizing always see current holdings.
    let positions: Position[] = await subAccount.getPositions();

    // Cash on hand for buy sizing (refreshed after each fill).
    let cash = (await subAccount.getBalance()).cash;

    for (const signal of newSignals) {
      const signalHash = this.hashSignal(signal);

      // Record the signal as processed once a decision is made (trade
      // placed or skipped with a reason). Recording only on fill would
      // make rejected signals re-fire every cycle.
      const recordProcessed = () =>
        store.recordSignal(
          config.id,
          signalHash,
          signal.symbol,
          signal.action,
          signal.metadata as Record<string, unknown>,
        );

      if (signal.action === "hold") {
        await recordProcessed();
        continue;
      }

      const price = signal.priceAtSignal ?? 0;
      if (price <= 0) {
        errors.push(`No price for ${signal.symbol} — skipping`);
        await recordProcessed();
        continue;
      }

      let filled: OrderResult | null = null;
      if (signal.action === "buy") {
        filled = await this.executeBuy(config, subAccount, equity, cash, signal, price, positions, errors);
      } else {
        filled = await this.executeSell(subAccount, signal, price, positions, errors);
      }

      if (filled) {
        trades.push(filled as ThemeEvaluationResult["trades"][number]);
        // Refresh holdings + equity + cash after a fill
        positions = await subAccount.getPositions();
        const balance = await subAccount.getBalance();
        equity = balance.equity;
        cash = balance.cash;
      }

      await recordProcessed();
    }

    return {
      themeId: config.id,
      timestamp,
      signals: newSignals,
      decisions,
      trades,
      errors,
    };
  }

  // ── Private helpers ───────────────────────────────────────────

  /**
   * Mirror a purchase disclosure. Size: maxAllocationPct of current equity.
   * Returns the filled OrderResult, or null when skipped/rejected (reason
   * pushed to `errors`).
   */
  private async executeBuy(
    config: ThemeConfig,
    subAccount: OrderPlacer,
    equity: number,
    cash: number,
    signal: ThemeSignal,
    price: number,
    positions: Position[],
    errors: string[],
  ): Promise<OrderResult | null> {
    // Size: maxAllocationPct of equity, capped by cash on hand (leaving
    // room for the fee). Equity-based sizing alone would try to spend more
    // than the account holds once most capital is deployed.
    const maxAllocation = Math.min(
      equity * (config.maxAllocationPct / 100),
      Math.max(0, cash * 0.995),
    );
    const qty = maxAllocation / price;
    if (qty <= 0) {
      errors.push(`Insufficient allocation for ${signal.symbol} at $${price}`);
      return null;
    }

    // Check max positions
    const hasPosition = positions.some((p) => p.symbol === signal.symbol);
    if (!hasPosition && positions.length >= config.maxPositions) {
      errors.push(`Max positions reached — skipping ${signal.symbol}`);
      return null;
    }

    // Enforce maxTotalAllocationPct (fixes #37)
    const buyValue = qty * price;
    const check = isWithinAllocationLimit(
      positions,
      equity,
      config.maxTotalAllocationPct,
      config.maxAllocationPct,
      buyValue,
    );
    if (!check.allowed) {
      errors.push(`Allocation limit for ${signal.symbol}: ${check.reason}`);
      return null;
    }

    // Place order — pass signal price as limitPrice so the sub-account
    // doesn't need a price provider.
    try {
      const result = await subAccount.placeOrder({
        symbol: signal.symbol,
        side: "buy",
        quantity: qty,
        orderType: "limit",
        limitPrice: price,
        clientOrderId: randomUUID(),
      });

      if (result.status === "filled") return result;
      if (result.status === "rejected") {
        errors.push(`Order rejected for ${signal.symbol}: ${result.error}`);
      }
      return null;
    } catch (err) {
      errors.push(`Trade failed for ${signal.symbol}: ${errorMessage(err)}`);
      return null;
    }
  }

  /**
   * Mirror a sale disclosure: sell the held quantity of the symbol — never
   * more. If we don't hold the symbol, skip silently (nothing to mirror).
   */
  private async executeSell(
    subAccount: OrderPlacer,
    signal: ThemeSignal,
    price: number,
    positions: Position[],
    errors: string[],
  ): Promise<OrderResult | null> {
    const held = positions.find((p) => p.symbol === signal.symbol && p.quantity > 0);
    if (!held) return null;

    try {
      const result = await subAccount.placeOrder({
        symbol: signal.symbol,
        side: "sell",
        quantity: held.quantity,
        orderType: "limit",
        limitPrice: price,
        clientOrderId: randomUUID(),
      });

      if (result.status === "filled") return result;
      if (result.status === "rejected") {
        errors.push(`Sell rejected for ${signal.symbol}: ${result.error}`);
      }
      return null;
    } catch (err) {
      errors.push(`Sell failed for ${signal.symbol}: ${errorMessage(err)}`);
      return null;
    }
  }

  /** Deterministic dedup hash: member + symbol + date + action. */
  private hashSignal(signal: ThemeSignal): string {
    const meta = signal.metadata as Record<string, unknown>;
    return `${meta.member_slug}-${signal.symbol}-${meta.transaction_date}-${signal.action}`;
  }

  /** Age of the disclosure in days — the clock starts at DISCLOSURE, when
   * the market first learns of the trade. A trade done 2026-07-24 may be
   * disclosed 2026-08-21; the follower acts at disclosure time, so the age
   * filter must use disclosure_date, not transaction_date. */
  private signalAgeDays(signal: ThemeSignal): number {
    const meta = signal.metadata as Record<string, unknown>;
    const discDate = meta.disclosure_date as string | undefined;
    if (!discDate) return Number.POSITIVE_INFINITY;
    const then = Date.parse(discDate);
    if (Number.isNaN(then)) return Number.POSITIVE_INFINITY;
    return (Date.now() - then) / (1000 * 60 * 60 * 24);
  }
}