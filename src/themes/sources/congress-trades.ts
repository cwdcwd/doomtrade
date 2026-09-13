/**
 * CongressTradesSignalSource — fetches congressional stock trade disclosures
 * from the Bargo Congress Trades API.
 *
 * Free, no key required for anonymous access (30 req/day, 100 rows).
 * Base URL: https://www.bargo.ai/free-apis/congress/v1
 *
 * Each congressional trade becomes a ThemeSignal mirroring the action:
 * - "purchase" -> buy
 * - "sale" / "sale_full" / "sale_partial" -> sell
 * - "exchange" -> hold (skip)
 *
 * Quota resilience (fleet-ops-miz): the anonymous tier is 30 requests/day
 * per egress IP and a 429 carries no Retry-After. A module-level TTL cache
 * (outliving per-evaluation source instances) absorbs repeat cycles, and
 * once quota is exhausted the last good payload is served stale — safe,
 * because ThemeStore's signalHash dedup discards already-processed
 * disclosures and congressional disclosures lag transactions by weeks.
 */

import type { SignalSource } from "../signal-source.js";
import type { ThemeSignal } from "../theme.js";

/** Bargo API trade record */
interface BargoTrade {
  member: string;
  member_slug: string;
  chamber: "house" | "senate";
  state: string;
  ticker: string;
  asset: string;
  type: "purchase" | "sale" | "sale_full" | "sale_partial" | "exchange";
  amount_range: string;
  transaction_date: string;
  disclosure_date: string;
  est_price: number | null;
  recent_price: number | null;
  perf_pct: number | null;
  outcome: string | null;
  filing_portal: string;
}

interface BargoTradeResponse {
  trades: BargoTrade[];
  page: number;
  limit: number;
  count: number;
}

const BARGO_BASE_URL = "https://www.bargo.ai/free-apis/congress/v1";

/** How long a successful response is served from cache (default 15 min). */
const DEFAULT_CACHE_TTL_MS = 15 * 60_000;

/** Fetch timeout — a hung Bargo call must not stall a cron cycle. */
const FETCH_TIMEOUT_MS = 10_000;

/**
 * When X-RateLimit-Remaining drops to this floor, stop hitting the API
 * until the next UTC midnight. Preserves a small manual-evaluate budget.
 */
const QUOTA_FLOOR = 3;

/**
 * Typed 429: thrown only when the quota is exhausted AND no cached payload
 * exists (fresh process). Callers can distinguish it from network failures.
 */
export class BargoRateLimitError extends Error {
  constructor(
    /** True when this is quota preemption (floor reached), not a 429 seen. */
    public readonly preempted: boolean,
  ) {
    super(
      "Bargo API daily rate limit reached (30 req/day anonymous). " +
        "Quota resets at next UTC midnight; a free key at " +
        "https://www.bargo.ai/free-apis/dash raises the limit (BARGO_API_KEY).",
    );
    this.name = "BargoRateLimitError";
  }
}

interface CacheEntry {
  /** Parsed trades payload from the last successful response. */
  data: BargoTradeResponse;
  /** When the entry was written (successful fetch), epoch ms. */
  writtenAt: number;
}

/** Module-level cache — source instances are per-evaluation and throwaway. */
const responseCache = new Map<string, CacheEntry>();

/**
 * URL -> epoch ms until which the URL is quota-blocked. Cleared lazily;
 * the anonymous quota window is the UTC calendar day.
 */
const quotaBlockedUntil = new Map<string, number>();

function nextUtcMidnight(now = new Date()): number {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return next.getTime();
}

/** Test seam: wipe all module-level cache/quota state. */
export function __resetBargoCache(): void {
  responseCache.clear();
  quotaBlockedUntil.clear();
}

export interface CongressTradesSignalSourceConfig {
  /** Politician name (partial match, case-insensitive) */
  member?: string;
  /** Filter by ticker */
  ticker?: string;
  /** Filter by chamber */
  chamber?: "house" | "senate";
  /** Filter by transaction type */
  type?: "purchase" | "sale";
  /** Max results per fetch */
  limit?: number;
  /** API key (optional, raises rate limits) */
  apiKey?: string;
  /** Cache TTL override, ms (tests). */
  cacheTtlMs?: number;
  /** Skip the cache + quota guard entirely (tests). */
  disableCache?: boolean;
}

export class CongressTradesSignalSource implements SignalSource {
  readonly name = "congress-trades";

  constructor(private config: CongressTradesSignalSourceConfig = {}) {}

  async fetchSignals(): Promise<ThemeSignal[]> {
    const params = new URLSearchParams();
    if (this.config.member) params.set("member", this.config.member);
    if (this.config.ticker) params.set("ticker", this.config.ticker);
    if (this.config.chamber) params.set("chamber", this.config.chamber);
    if (this.config.type) params.set("type", this.config.type);
    params.set("limit", String(this.config.limit ?? 100));

    const url = `${BARGO_BASE_URL}/trades?${params.toString()}`;
    const headers: Record<string, string> = {};
    if (this.config.apiKey) {
      headers["X-Api-Key"] = this.config.apiKey;
    }

    const ttlMs = this.config.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    const now = Date.now();

    if (!this.config.disableCache) {
      // Quota-blocked URL: serve stale cache (if any) or fail typed.
      const blockedUntil = quotaBlockedUntil.get(url) ?? 0;
      if (now < blockedUntil) {
        const stale = responseCache.get(url);
        if (stale) return this.toSignals(stale.data);
        throw new BargoRateLimitError(true);
      }

      // Fresh cache: served without touching the API.
      const cached = responseCache.get(url);
      if (cached && now - cached.writtenAt < ttlMs) {
        return this.toSignals(cached.data);
      }
    }

    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (response.status === 429) {
      // Daily quota exhausted. No Retry-After is sent — block until UTC
      // midnight and prefer the last good payload over failing the cycle.
      if (!this.config.disableCache) {
        quotaBlockedUntil.set(url, nextUtcMidnight());
        const stale = responseCache.get(url);
        if (stale) return this.toSignals(stale.data);
      }
      throw new BargoRateLimitError(false);
    }

    if (!response.ok) {
      throw new Error(`Bargo API error: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as BargoTradeResponse;

    if (!this.config.disableCache) {
      responseCache.set(url, { data, writtenAt: now });

      // Quota floor: preserve a manual-evaluate budget by preemptively
      // serving cache once the anonymous allowance is nearly spent.
      // (Test mocks may omit headers entirely — read defensively.)
      const remaining = Number(response.headers?.get("x-ratelimit-remaining"));
      if (Number.isFinite(remaining) && remaining <= QUOTA_FLOOR) {
        quotaBlockedUntil.set(url, nextUtcMidnight());
      }
    }

    return this.toSignals(data);
  }

  private toSignals(data: BargoTradeResponse): ThemeSignal[] {
    return data.trades
      .filter((t) => t.ticker && t.type !== "exchange")
      .map((t): ThemeSignal => {
        const action: "buy" | "sell" = t.type === "purchase" ? "buy" : "sell";

        return {
          symbol: t.ticker,
          action,
          priceAtSignal: t.est_price ?? undefined,
          reason: `${t.member} (${t.chamber}, ${t.state}) ${t.type === "purchase" ? "bought" : "sold"} ${t.amount_range} on ${t.transaction_date}, disclosed ${t.disclosure_date}`,
          metadata: {
            member: t.member,
            member_slug: t.member_slug,
            chamber: t.chamber,
            state: t.state,
            asset: t.asset,
            trade_type: t.type,
            amount_range: t.amount_range,
            transaction_date: t.transaction_date,
            disclosure_date: t.disclosure_date,
            est_price: t.est_price,
            recent_price: t.recent_price,
            perf_pct: t.perf_pct,
            filing_portal: t.filing_portal,
          },
        };
      });
  }
}
