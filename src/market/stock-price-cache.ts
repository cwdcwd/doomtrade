/**
 * PriceCache — background price refresher behind the sim's sync price provider.
 *
 * AgentExchange.getCurrentPrice must be synchronous, but live quotes require
 * async network calls (CCXT for crypto, Yahoo Finance for stocks). This cache
 * refreshes quotes in the background on an interval and serves them from an
 * in-memory map. Best-effort: on fetch failure the last known price is kept.
 *
 * Symbols are discovered from open agent_positions (any symbol currently held)
 * plus an explicit watch list for symbols strategies trade before holding.
 */

import type { Database } from "../db/database.js";
import { execAll, convertPlaceholders } from "../db/database.js";
import { isCryptoSymbol } from "./market.js";
import type { MarketDataService } from "./market.js";

const YAHOO_CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart";

export interface PriceCacheConfig {
  db: Database;
  marketData: MarketDataService;
  /** Refresh interval in ms (default 60s) */
  intervalMs?: number;
  /** Extra symbols to always refresh (e.g. default crypto universe) */
  watchSymbols?: string[];
}

export class PriceCache {
  private db: Database;
  private marketData: MarketDataService;
  private intervalMs: number;
  private watchSymbols: Set<string>;
  private prices = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private refreshing = false;

  constructor(config: PriceCacheConfig) {
    this.db = config.db;
    this.marketData = config.marketData;
    this.intervalMs = config.intervalMs ?? 60_000;
    this.watchSymbols = new Set(config.watchSymbols ?? []);
  }

  /** Synchronous lookup — returns last refreshed price or null. */
  get(symbol: string): number | null {
    return this.prices.get(symbol) ?? null;
  }

  /** Track a symbol that isn't held yet (refreshed on next tick). */
  addWatchSymbol(symbol: string): void {
    this.watchSymbols.add(symbol);
  }

  /**
   * Fetch a single stock quote from Yahoo Finance's public chart endpoint.
   * No API key required. Returns null on any failure.
   */
  static async fetchStockQuote(symbol: string): Promise<number | null> {
    try {
      const url = `${YAHOO_CHART_URL}/${encodeURIComponent(symbol)}?interval=1d&range=1d`;
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) DoomTrade/1.0" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as {
        chart?: { result?: { meta?: { regularMarketPrice?: number } }[] };
      };
      const price = data.chart?.result?.[0]?.meta?.regularMarketPrice;
      return typeof price === "number" && price > 0 ? price : null;
    } catch {
      return null;
    }
  }

  /** Refresh all known symbols once. Safe to call concurrently (no-ops). */
  async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const symbols = await this.symbolsToRefresh();
      const [cryptoSymbols, stockSymbols] = partition(Array.from(symbols), isCryptoSymbol);

      await Promise.all([
        ...cryptoSymbols.map(async (sym) => {
          try {
            const quote = await this.marketData.getQuote(sym);
            if (quote.price > 0) this.prices.set(sym, quote.price);
          } catch {
            /* keep last known price */
          }
        }),
        ...stockSymbols.map(async (sym) => {
          const price = await PriceCache.fetchStockQuote(sym);
          if (price !== null) this.prices.set(sym, price);
        }),
      ]);
    } finally {
      this.refreshing = false;
    }
  }

  /** Start the background refresh loop (immediate first refresh). */
  start(): void {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Symbols held as open positions, plus watched symbols. */
  private async symbolsToRefresh(): Promise<Set<string>> {
    const symbols = new Set(this.watchSymbols);
    try {
      const sql = convertPlaceholders(
        "SELECT DISTINCT symbol FROM agent_positions WHERE quantity > 0",
        this.db.backend,
      );
      const rows = await execAll<{ symbol: string }>(this.db, sql);
      for (const row of rows) symbols.add(row.symbol);
    } catch {
      /* table may not exist yet — watch list only */
    }
    return symbols;
  }
}

function partition<T>(items: T[], predicate: (item: T) => boolean): [T[], T[]] {
  const yes: T[] = [];
  const no: T[] = [];
  for (const item of items) {
    (predicate(item) ? yes : no).push(item);
  }
  return [yes, no];
}