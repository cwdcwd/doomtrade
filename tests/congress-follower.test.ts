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

  it("correctly calculates quantity as Math.floor(maxAllocation / price)", async () => {
    const store = new ThemeStore(db);
    const theme = await store.create({
      name: "Qty Calc Test",
      strategy: "congress-follower",
      schedule: { type: "manual" },
      params: { politician: "Pelosi" },
      allocatedCapital: 50_000,
      maxAllocationPct: 10,  // 10% of 50,000 = 5,000 max allocation
    });

    const sub = new ThemeSubAccount(db, theme.id, {
      feeRate: 0,
      getCurrentPrice: (sym) => sym === "NVDA" ? 120 : null,
    });
    await sub.initialize(50_000);

    // Mock Bargo API returning a trade with price 120
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
      getEquity: async () => {
        const bal = await sub.getBalance();
        return bal.equity;
      },
      getPositions: async () => sub.getPositions(),
      getQuote: async () => 120,
    };

    const result = await strategy.evaluate(ctx, config!);

    expect(result.trades).toHaveLength(1);
    // maxAllocation = 50000 * 0.10 = 5000, price = 120, qty = 5000/120 = 41.67
    expect(result.trades[0].quantity).toBe(5000 / 120);
    expect(result.trades[0].quantity).toBeCloseTo(41.67, 1);

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
// ── Regression tests: fixes for the Kangbot lockup (2026-09-09) ──

describe("CongressFollowerStrategy — regression fixes", () => {
  /** Build a context backed by a real ThemeSubAccount with a price provider. */
  function subCtx(
    themeId: string,
    sub: ThemeSubAccount,
    prices: Record<string, number> = { NVDA: 120, MSFT: 500, INTC: 120, AAPL: 200, BE: 120 },
  ): ThemeContext {
    const priceOf = (s: string) => prices[s] ?? 100;
    return {
      db,
      marketData: { getQuote: async (s: string) => ({ price: priceOf(s) }) } as any,
      decisionStore: {} as any,
      tradeEngine: {} as any,
      portfolio: {} as any,
      themeId,
      getEquity: async () => (await sub.getBalance()).equity,
      getPositions: async () => sub.getPositions(),
      getQuote: async (s: string) => priceOf(s),
    };
  }

  function pelosiConfig(id: string, overrides: Partial<ThemeConfig> = {}): ThemeConfig {
    return {
      id,
      name: "Pelosi Follower",
      strategy: "congress-follower",
      mode: "sim",
      schedule: { type: "manual" },
      maxAllocationPct: 25,
      maxTotalAllocationPct: 95,
      maxPositions: 10,
      params: { politician: "Pelosi" },
      enabled: true,
      allocatedCapital: 1_000,
      ...overrides,
    };
  }

  /** Mock a fresh Bargo purchase disclosure. */
  function mockPurchase(opts: { ticker?: string; price?: number; txDate?: string; discDate?: string } = {}) {
    const now = Date.now();
    const txDate = opts.txDate ?? new Date(now - 7 * 86400_000).toISOString().slice(0, 10);
    const discDate = opts.discDate ?? new Date(now - 1 * 86400_000).toISOString().slice(0, 10);
    return {
      trades: [
        {
          member: "Nancy Pelosi",
          member_slug: "nancy-pelosi",
          chamber: "house",
          state: "CA",
          ticker: opts.ticker ?? "NVDA",
          asset: "NVIDIA",
          type: "purchase",
          amount_range: "$1,001 - $15,000",
          transaction_date: txDate,
          disclosure_date: discDate,
          est_price: opts.price ?? 120.0,
          recent_price: opts.price ?? 120.0,
          perf_pct: 0,
          outcome: null,
          filing_portal: "https://disclosures-clerk.house.gov",
        },
      ],
      page: 0,
      limit: 100,
      count: 1,
    };
  }

  it("records rejected signals as processed so they don't re-fire every cycle", async () => {
    const store = new ThemeStore(db);
    const theme = await store.create({
      name: "Regress Reject",
      strategy: "congress-follower",
      schedule: { type: "manual" },
      params: { politician: "Pelosi" },
      allocatedCapital: 1_000,
      maxAllocationPct: 25,
    });

    const sub = new ThemeSubAccount(db, theme.id, { feeRate: 0, getCurrentPrice: () => 100 });
    await sub.initialize(1_000);
    const ctx = subCtx(theme.id, sub);
    const strategy = new CongressFollowerStrategy();

    // Two buys of the same symbol on different dates — the second must be
    // rejected by the single-position allocation limit (25% of equity) but
    // still recorded as processed.
    const payload = {
      trades: [
        {
          member: "Nancy Pelosi", member_slug: "nancy-pelosi", chamber: "house", state: "CA",
          ticker: "NVDA", asset: "NVIDIA", type: "purchase",
          amount_range: "$1,001 - $15,000",
          transaction_date: new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10),
          disclosure_date: new Date(Date.now() - 1 * 86400_000).toISOString().slice(0, 10),
          est_price: 100, recent_price: 100, perf_pct: 0, outcome: null,
          filing_portal: "https://disclosures-clerk.house.gov",
        },
        {
          member: "Nancy Pelosi", member_slug: "nancy-pelosi", chamber: "house", state: "CA",
          ticker: "MSFT", asset: "Microsoft", type: "purchase",
          amount_range: "$1,001 - $15,000",
          transaction_date: new Date(Date.now() - 6 * 86400_000).toISOString().slice(0, 10),
          disclosure_date: new Date(Date.now() - 1 * 86400_000).toISOString().slice(0, 10),
          est_price: 500, recent_price: 500, perf_pct: 0, outcome: null,
          filing_portal: "https://disclosures-clerk.house.gov",
        },
      ],
      page: 0, limit: 100, count: 2,
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true, json: async () => payload } as Response);

    const config = await store.getById(theme.id);
    const r1 = await strategy.evaluate(ctx, config!);
    // NVDA fills (250 = 25% of equity). MSFT buy (250) is rejected by the
    // total-exposure limit (default maxTotalAllocationPct = 40 → 400 cap;
    // 250 + 250 = 500 > 400) — exactly the Kangbot production scenario.
    expect(r1.trades).toHaveLength(1);
    expect(r1.errors.length).toBeGreaterThanOrEqual(1);
    expect(r1.errors.some((e) => e.includes("Allocation limit"))).toBe(true);

    // Second cycle: same disclosures — the rejected MSFT signal must NOT
    // re-fire (it was recorded as processed at decision time, not fill time).
    const r2 = await strategy.evaluate(ctx, config!);
    expect(r2.signals).toHaveLength(0);
    expect(r2.trades).toHaveLength(0);
    expect(r2.errors).toHaveLength(0);

    vi.restoreAllMocks();
  });

  it("ignores disclosures older than maxSignalAgeDays (by disclosure date)", async () => {
    const store = new ThemeStore(db);
    const theme = await store.create({
      name: "Regress Age",
      strategy: "congress-follower",
      schedule: { type: "manual" },
      params: { politician: "Pelosi" },
      allocatedCapital: 1_000,
      maxAllocationPct: 25,
    });

    const sub = new ThemeSubAccount(db, theme.id, { feeRate: 0, getCurrentPrice: () => 100 });
    await sub.initialize(1_000);
    const ctx = subCtx(theme.id, sub);
    const strategy = new CongressFollowerStrategy();

    // Transaction 40 days ago, disclosed 35 days ago — too old by both clocks.
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => mockPurchase({
        ticker: "AAPL",
        price: 200,
        txDate: new Date(Date.now() - 40 * 86400_000).toISOString().slice(0, 10),
        discDate: new Date(Date.now() - 35 * 86400_000).toISOString().slice(0, 10),
      }),
    } as Response);

    const config = await store.getById(theme.id);
    const r1 = await strategy.evaluate(ctx, config!);
    expect(r1.signals).toHaveLength(0);
    expect(r1.trades).toHaveLength(0);

    vi.restoreAllMocks();
  });

  it("acts on recently-disclosed old trades (disclosure date is the clock)", async () => {
    const store = new ThemeStore(db);
    const theme = await store.create({
      name: "Regress Fresh Disclosure",
      strategy: "congress-follower",
      schedule: { type: "manual" },
      params: { politician: "Pelosi" },
      allocatedCapital: 1_000,
      maxAllocationPct: 25,
    });

    const sub = new ThemeSubAccount(db, theme.id, { feeRate: 0, getCurrentPrice: () => 120 });
    await sub.initialize(1_000);
    const ctx = subCtx(theme.id, sub);
    const strategy = new CongressFollowerStrategy();

    // Transaction 45 days ago but DISCLOSED yesterday — actionable: the
    // market only learned of it at disclosure. (This is the Pelosi BE case.)
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => mockPurchase({
        ticker: "BE",
        price: 120,
        txDate: new Date(Date.now() - 45 * 86400_000).toISOString().slice(0, 10),
        discDate: new Date(Date.now() - 1 * 86400_000).toISOString().slice(0, 10),
      }),
    } as Response);

    const config = await store.getById(theme.id);
    const r1 = await strategy.evaluate(ctx, config!);
    expect(r1.signals).toHaveLength(1);
    expect(r1.trades).toHaveLength(1);
    expect((r1.trades[0] as any).symbol).toBe("BE");
    expect((r1.trades[0] as any).status).toBe("filled");

    vi.restoreAllMocks();
  });

  it("mirrors a sale by selling held quantity — never a buy-sized amount", async () => {
    const store = new ThemeStore(db);
    const theme = await store.create({
      name: "Regress Sell Mirror",
      strategy: "congress-follower",
      schedule: { type: "manual" },
      params: { politician: "Pelosi", mirrorAction: "all" },
      allocatedCapital: 1_000,
      maxAllocationPct: 25,
    });

    const sub = new ThemeSubAccount(db, theme.id, { feeRate: 0, getCurrentPrice: () => 120 });
    await sub.initialize(1_000);
    const ctx = subCtx(theme.id, sub);
    const strategy = new CongressFollowerStrategy();

    // First: buy NVDA (fills 250/120 = 2.0833 units)
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      json: async () => mockPurchase({ ticker: "NVDA", price: 120 }),
    } as Response);
    const config = await store.getById(theme.id);
    const r1 = await strategy.evaluate(ctx, config!);
    expect(r1.trades).toHaveLength(1);

    // Then: Pelosi sells NVDA — strategy must sell the HELD quantity (2.0833),
    // not a buy-sized amount like 250/120-ish… which would coincidentally be
    // the same. Use a different price to prove sizing: sell at 200 → if it
    // were buy-sized it would be 250/200 = 1.25, not 2.0833.
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        trades: [
          {
            member: "Nancy Pelosi", member_slug: "nancy-pelosi", chamber: "house", state: "CA",
            ticker: "NVDA", asset: "NVIDIA", type: "sale_full",
            amount_range: "$15,001 - $50,000",
            transaction_date: new Date(Date.now() - 2 * 86400_000).toISOString().slice(0, 10),
            disclosure_date: new Date(Date.now() - 1 * 86400_000).toISOString().slice(0, 10),
            est_price: 200, recent_price: 200, perf_pct: 0, outcome: null,
            filing_portal: "https://disclosures-clerk.house.gov",
          },
        ],
        page: 0, limit: 100, count: 1,
      }),
    } as Response);

    const r2 = await strategy.evaluate(ctx, config!);
    expect(r2.trades).toHaveLength(1);
    const sell = r2.trades[0] as any;
    expect(sell.side).toBe("sell");
    expect(sell.symbol).toBe("NVDA");
    // Held quantity, not buy-sized (1.25) — assert approximately
    expect(sell.quantity).toBeCloseTo(2.0833, 3);

    // Position fully closed
    const positions = await sub.getPositions();
    expect(positions.filter((p) => p.symbol === "NVDA")).toHaveLength(0);

    vi.restoreAllMocks();
  });

  it("caps buy size at available cash so near-fully-deployed accounts still trade", async () => {
    const store = new ThemeStore(db);
    const theme = await store.create({
      name: "Regress Cash Cap",
      strategy: "congress-follower",
      schedule: { type: "manual" },
      params: { politician: "Pelosi" },
      allocatedCapital: 1_000,
      maxAllocationPct: 90,       // single-position limit high enough to not mask the cash cap
      maxTotalAllocationPct: 100, // total limit high enough to expose the cash cap
    });

    // Prices: everything marks at 120 (fill price), so equity stays honest.
    const sub = new ThemeSubAccount(db, theme.id, { feeRate: 0, getCurrentPrice: () => 120 });
    await sub.initialize(1_000);
    const ctx = subCtx(theme.id, sub, { NVDA: 120, INTC: 120 });
    const strategy = new CongressFollowerStrategy();

    // Pre-buy 8 INTC @ 120 = 960 → 40 cash left, equity 1000.
    await sub.placeOrder({
      symbol: "INTC", side: "buy", quantity: 8, orderType: "limit", limitPrice: 120,
    } as any);

    // Fresh NVDA signal: 90% of equity would be 900/120 = 7.5 units, but only
    // ~40 cash exists. The buy must size to cash (~0.33 units), not reject.
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      json: async () => mockPurchase({ ticker: "NVDA", price: 120 }),
    } as Response);

    const config = await store.getById(theme.id);
    const r1 = await strategy.evaluate(ctx, config!);
    expect(r1.errors).toHaveLength(0);
    expect(r1.trades).toHaveLength(1);
    const trade = r1.trades[0] as any;
    expect(trade.symbol).toBe("NVDA");
    expect(trade.status).toBe("filled");
    // Cash-capped (~40/120 ≈ 0.33), not equity-sized (7.5)
    expect(trade.quantity).toBeLessThan(0.4);
    expect(trade.quantity).toBeGreaterThan(0.3);

    vi.restoreAllMocks();
  });
});
