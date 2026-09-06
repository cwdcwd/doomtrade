/**
 * market.ts — Unified market data interface.
 *
 * Auto-detects stock vs crypto by symbol format:
 * - `AAPL`, `TSLA`, `GOOGL` → stock (Alpaca)
 * - `BTC/USDT`, `ETH/USD` → crypto (CCXT)
 *
 * The factory `createMarketDataService()` returns the right adapter based on symbol.
 */

import { z } from "zod";

// ── Types ──────────────────────────────────────────────────────

export const QuoteSchema = z.object({
  symbol: z.string(),
  price: z.number().positive(),
  bid: z.number().optional(),
  ask: z.number().optional(),
  timestamp: z.string(),
  source: z.enum(["alpaca", "ccxt"]),
});
export type Quote = z.infer<typeof QuoteSchema>;

export const BarSchema = z.object({
  symbol: z.string(),
  timestamp: z.string(),
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number(),
  volume: z.number(),
  source: z.enum(["alpaca", "ccxt"]),
});
export type Bar = z.infer<typeof BarSchema>;

export const SnapshotSchema = z.object({
  symbol: z.string(),
  price: z.number().positive(),
  change: z.number().optional(),
  changePct: z.number().optional(),
  volume: z.number().optional(),
  timestamp: z.string(),
  source: z.enum(["alpaca", "ccxt"]),
});
export type Snapshot = z.infer<typeof SnapshotSchema>;

export type Timeframe = "1Min" | "5Min" | "15Min" | "1Hour" | "1Day";

// ── Interface ──────────────────────────────────────────────────

export interface MarketDataService {
  getQuote(symbol: string): Promise<Quote>;
  getBars(symbol: string, timeframe: Timeframe, range: string): Promise<Bar[]>;
  getSnapshot(symbols: string[]): Promise<Snapshot[]>;
}

// ── Symbol utilities ───────────────────────────────────────────

/** Detect if a symbol is crypto (contains `/`) or stock. */
export function isCryptoSymbol(symbol: string): boolean {
  return symbol.includes("/");
}

/** Detect if a symbol is a stock (no `/`, uppercase letters). */
export function isStockSymbol(symbol: string): boolean {
  return !symbol.includes("/") && /^[A-Z]+$/.test(symbol);
}

// ── Factory ────────────────────────────────────────────────────

export interface MarketDataConfig {
  alpacaKeyId: string;
  alpacaSecretKey: string;
  alpacaPaper: boolean;
  ccxtExchange: string;
  ccxtApiKey: string;
  ccxtApiSecret: string;
}

/**
 * Create a market data service that routes to the right adapter
 * based on symbol format.
 */
export function createMarketDataService(config: MarketDataConfig): MarketDataService {
  // Lazy-load adapters so missing API keys don't crash at startup
  let alpacaAdapter: MarketDataService | undefined;
  let ccxtAdapter: MarketDataService | undefined;

  async function getAlpaca(): Promise<MarketDataService> {
    if (!alpacaAdapter) {
      const { AlpacaMarketData } = await import("./alpaca-data.js");
      alpacaAdapter = new AlpacaMarketData(config.alpacaKeyId, config.alpacaSecretKey, config.alpacaPaper);
    }
    return alpacaAdapter;
  }

  async function getCCXT(): Promise<MarketDataService> {
    if (!ccxtAdapter) {
      const { CCXTMarketData } = await import("./ccxt-data.js");
      ccxtAdapter = new CCXTMarketData(config.ccxtExchange, config.ccxtApiKey, config.ccxtApiSecret);
    }
    return ccxtAdapter;
  }

  async function route(symbol: string): Promise<MarketDataService> {
    return isCryptoSymbol(symbol) ? getCCXT() : getAlpaca();
  }

  return {
    async getQuote(symbol: string): Promise<Quote> {
      return (await route(symbol)).getQuote(symbol);
    },
    async getBars(symbol: string, timeframe: Timeframe, range: string): Promise<Bar[]> {
      return (await route(symbol)).getBars(symbol, timeframe, range);
    },
    async getSnapshot(symbols: string[]): Promise<Snapshot[]> {
      const stockSymbols = symbols.filter((s) => isStockSymbol(s));
      const cryptoSymbols = symbols.filter((s) => isCryptoSymbol(s));
      const results: Snapshot[] = [];

      if (stockSymbols.length > 0) {
        const alpaca = await getAlpaca();
        results.push(...await alpaca.getSnapshot(stockSymbols));
      }
      if (cryptoSymbols.length > 0) {
        const ccxt = await getCCXT();
        results.push(...await ccxt.getSnapshot(cryptoSymbols));
      }

      return results;
    },
  };
}
