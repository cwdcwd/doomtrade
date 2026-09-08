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

    const response = await fetch(url, { headers });

    if (!response.ok) {
      throw new Error(`Bargo API error: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as BargoTradeResponse;

    return data.trades
      .filter((t) => t.ticker && t.type !== "exchange")
      .map((t): ThemeSignal => {
        const action: "buy" | "sell" =
          t.type === "purchase" ? "buy" : "sell";

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