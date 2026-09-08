/**
 * Tests for Congress Follower strategy and CongressTradesSignalSource.
 *
 * The Bargo API calls are mocked — we don't hit the real API in tests.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { openDatabase, closeDatabase, type DbClient } from "../src/db/database.js";
import { ThemeStore } from "../src/themes/theme-store.js";
import { ThemeSubAccount } from "../src/themes/theme-sub-account.js";
import { CongressTradesSignalSource } from "../src/themes/sources/congress-trades.js";
import { CongressFollowerStrategy } from "../src/themes/strategies/congress-follower.js";
import type { ThemeContext } from "../src/themes/strategy.js";
import type { ThemeConfig } from "../src/themes/theme.js";

let db: DbClient;

beforeEach(async () => {
  db = await openDatabase({ path: ":memory:" });
});

// ── CongressTradesSignalSource ──────────────────────────────────

describe("CongressTradesSignalSource", () => {
  it("fetches and parses trades from Bargo API", async () => {
    const mockTrades = {
      trades: [
        {
          member: "Nancy Pelosi",
          member_slug: "nancy-pelosi",
          chamber: "house",
          state: "CA",
          ticker: "NVDA",
          asset: "NVIDIA Corporation",
          type: "purchase",
          amount_range: "$1,001 - $15,000",
          transaction_date: "2026-08-15",
          disclosure_date: "2026-09-01",
          est_price: 120.50,
          recent_price: 180.25,
          perf_pct: 49.6,
          outcome: "winner",
          filing_portal: "https://disclosures-clerk.house.gov",
        },
        {
          member: "Nancy Pelosi",
          member_slug: "nancy-pelosi",
          chamber: "house",
          state: "CA",
          ticker: "AAPL",
          asset: "Apple Inc.",
          type: "sale_full",
          amount_range: "$50,001 - $100,000",
          transaction_date: "2026-08-10",
          disclosure_date: "2026-08-25",
          est_price: 195.00,
          recent_price: 190.00,
          perf_pct: -2.6,
          outcome: "loser",
          filing_portal: "https://disclosures-clerk.house.gov",
        },
        {
          member: "Nancy Pelosi",
          member_slug: "nancy-pelosi",
          chamber: "house",
          state: "CA",
          ticker: "SPY",
          asset: "SPDR S&P 500 ETF",
          type: "exchange",
          amount_range: "$1,001 - $15,000",
          transaction_date: "2026-08-05",
          disclosure_date: "2026-08-20",
          est_price: 450.00,
          recent_price: 455.00,
          perf_pct: 1.1,
          outcome: null,
          filing_portal: "https://disclosures-clerk.house.gov",
        },
      ],
      page: 0,
      limit: 100,
      count: 3,
    };

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      json: async () => mockTrades,
    } as Response);

    const source = new CongressTradesSignalSource({ member: "Pelosi" });
    const signals = await source.fetchSignals();

    // Exchange type should be filtered out
    expect(signals).toHaveLength(2);
    expect(signals[0].symbol).toBe("NVDA");
    expect(signals[0].action).toBe("buy");
    expect(signals[0].priceAtSignal).toBe(120.50);
    expect(signals[0].reason).toContain("Nancy Pelosi");
    expect(signals[0].reason).toContain("bought");

    expect(signals[1].symbol).toBe("AAPL");
    expect(signals[1].action).toBe("sell");
    expect(signals[1].reason).toContain("sold");
  });

  it("filters by purchase type only", async () => {
    const mockTrades = {
      trades: [
        {
          member: "Tommy Tuberville",
          member_slug: "tommy-tuberville",
          chamber: "senate",
          state: "AL",
          ticker: "BA",
          asset: "Boeing",
          type: "purchase",
          amount_range: "$100,001 - $250,000",
          transaction_date: "2026-09-10",
          disclosure_date: "2026-09-17",
          est_price: 150.00,
          recent_price: 160.00,
          perf_pct: 6.7,
          outcome: "winner",
          filing_portal: "https://efdsearch.senate.gov",
        },
      ],
      page: 0,
      limit: 100,
      count: 1,
    };

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      json: async () => mockTrades,
    } as Response);

    const source = new CongressTradesSignalSource({
      member: "Tuberville",
      type: "purchase",
    });
    const signals = await source.fetchSignals();

    expect(signals).toHaveLength(1);
    expect(signals[0].action).toBe("buy");
    expect(signals[0].metadata).toHaveProperty("chamber", "senate");
  });

  it("handles API error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
      json: async () => ({}),
    } as Response);

    const source = new CongressTradesSignalSource({ member: "Pelosi" });
    await expect(source.fetchSignals()).rejects.toThrow("Bargo API error: 429");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });
});

// ── CongressFollowerStrategy ────────────────────────────────────

describe("CongressFollowerStrategy", () => {
  function buildContext(themeId: string): ThemeContext {
    return {
      db,
      marketData: { getQuote: async () => ({ price: 100 }) } as any,
      decisionStore: {} as any,
      tradeEngine: {} as any,
      portfolio: {} as any,
      themeId,
      getEquity: async () => 50_000,
      getPositions: async () => [],
      getQuote: async () => 100,
    };
  }

  it("returns error when politician param is missing", async () => {
    const strategy = new CongressFollowerStrategy();
    const config: ThemeConfig = {
      id: "test-1",
      name: "Test",
      strategy: "congress-follower",
      mode: "sim",
      schedule: { type: "manual" },
      maxAllocationPct: 5,
      maxTotalAllocationPct: 40,
      maxPositions: 10,
      params: {},
      enabled: true,
      allocatedCapital: 10_000,
    };

    const result = await strategy.evaluate(buildContext("test-1"), config);
    expect(result.errors).toContain("Missing required param: politician");
    expect(result.signals).toHaveLength(0);
  });

  it("returns error when sub-account is not initialized", async () => {
    const store = new ThemeStore(db);
    const theme = await store.create({
      name: "Pelosi Follower",
      strategy: "congress-follower",
      schedule: { type: "manual" },
      params: { politician: "Pelosi" },
    });

    // Mock the Bargo API to return a trade
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        trades: [
          {
            member: "Nancy Pelosi",
            member_slug: "nancy-pelosi",
            chamber: "house",
            state: "CA",
            ticker: "NVDA",
            asset: "NVIDIA",
            type: "purchase",
            amount_range: "$1,001 - $15,000",
            transaction_date: "2026-09-10",
            disclosure_date: "2026-09-15",
            est_price: 120.00,
            recent_price: 180.00,
            perf_pct: 50,
            outcome: "winner",
            filing_portal: "https://disclosures-clerk.house.gov",
          },
        ],
        page: 0,
        limit: 100,
        count: 1,
      }),
    } as Response);

    const strategy = new CongressFollowerStrategy();
    const config = await store.getById(theme.id);
    const result = await strategy.evaluate(buildContext(theme.id), config!);

    expect(result.errors).toContain("Sub-account not initialized — no capital allocated");
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0].symbol).toBe("NVDA");

    vi.restoreAllMocks();
  });

  it("places trades when sub-account is initialized", async () => {
    const store = new ThemeStore(db);
    const theme = await store.create({
      name: "Pelosi Follower",
      strategy: "congress-follower",
      schedule: { type: "manual" },
      params: { politician: "Pelosi" },
      allocatedCapital: 50_000,
      maxAllocationPct: 10,
    });

    // Initialize sub-account
    const sub = new ThemeSubAccount(db, theme.id, {
      feeRate: 0,
      getCurrentPrice: (sym) => sym === "NVDA" ? 120 : null,
    });
    await sub.initialize(50_000);

    // Mock the Bargo API
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        trades: [
          {
            member: "Nancy Pelosi",
            member_slug: "nancy-pelosi",
            chamber: "house",
            state: "CA",
            ticker: "NVDA",
            asset: "NVIDIA",
            type: "purchase",
            amount_range: "$1,001 - $15,000",
            transaction_date: "2026-09-10",
            disclosure_date: "2026-09-15",
            est_price: 120.00,
            recent_price: 180.00,
            perf_pct: 50,
            outcome: "winner",
            filing_portal: "https://disclosures-clerk.house.gov",
          },
        ],
        page: 0,
        limit: 100,
        count: 1,
      }),
    } as Response);

    const strategy = new CongressFollowerStrategy();
    const config = await store.getById(theme.id);

    // Build context with the same price provider
    const ctx: ThemeContext = {
      db,
      marketData: { getQuote: async () => ({ price: 120 }) } as any,
      decisionStore: {} as any,
      tradeEngine: {} as any,
      portfolio: {} as any,
      themeId: theme.id,
      getEquity: async () => {
        const bal = await sub.getBalance();
        return bal.equity;
      },
      getPositions: async () => sub.getPositions(),
      getQuote: async () => 120,
    };

    const result = await strategy.evaluate(ctx, config!);

    expect(result.signals).toHaveLength(1);
    expect(result.signals[0].symbol).toBe("NVDA");
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0].status).toBe("filled");
    expect(result.trades[0].symbol).toBe("NVDA");
    expect(result.errors).toHaveLength(0);

    // Verify signal was deduped
    const processed = await store.isSignalProcessed(
      theme.id,
      "nancy-pelosi-NVDA-2026-09-10-buy",
    );
    expect(processed).toBe(true);

    vi.restoreAllMocks();
  });

  it("deduplicates previously processed signals", async () => {
    const store = new ThemeStore(db);
    const theme = await store.create({
      name: "Pelosi Follower",
      strategy: "congress-follower",
      schedule: { type: "manual" },
      params: { politician: "Pelosi" },
      allocatedCapital: 50_000,
    });

    // Initialize sub-account
    const sub = new ThemeSubAccount(db, theme.id, {
      feeRate: 0,
      getCurrentPrice: () => 120,
    });
    await sub.initialize(50_000);

    // Pre-record the signal to simulate it already being processed
    await store.recordSignal(
      theme.id,
      "nancy-pelosi-NVDA-2026-09-10-buy",
      "NVDA",
      "buy",
    );

    // Mock Bargo API returning the same trade
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        trades: [
          {
            member: "Nancy Pelosi",
            member_slug: "nancy-pelosi",
            chamber: "house",
            state: "CA",
            ticker: "NVDA",
            asset: "NVIDIA",
            type: "purchase",
            amount_range: "$1,001 - $15,000",
            transaction_date: "2026-09-10",
            disclosure_date: "2026-09-15",
            est_price: 120.00,
            recent_price: 180.00,
            perf_pct: 50,
            outcome: "winner",
            filing_portal: "https://disclosures-clerk.house.gov",
          },
        ],
        page: 0,
        limit: 100,
        count: 1,
      }),
    } as Response);

    const strategy = new CongressFollowerStrategy();
    const config = await store.getById(theme.id);

    const ctx: ThemeContext = {
      db,
      marketData: { getQuote: async () => ({ price: 120 }) } as any,
      decisionStore: {} as any,
      tradeEngine: {} as any,
      portfolio: {} as any,
      themeId: theme.id,
      getEquity: async () => 50_000,
      getPositions: async () => [],
      getQuote: async () => 120,
    };

    const result = await strategy.evaluate(ctx, config!);

    // Signal should be filtered out by dedup
    expect(result.signals).toHaveLength(0);
    expect(result.trades).toHaveLength(0);

    vi.restoreAllMocks();
  });
});