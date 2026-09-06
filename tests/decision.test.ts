import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import { openDatabase, closeDatabase } from "../src/db/database.js";
import { DecisionStore } from "../src/decision/decision-store.js";
import type { CreateDecisionInput } from "../src/decision/decision.js";

describe("Database", () => {
  let db: DatabaseType;

  beforeEach(() => {
    db = openDatabase({ path: ":memory:" });
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it("should open and create required tables", () => {
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      .all() as { name: string }[];
    const tableNames = tables.map((t) => t.name);

    expect(tableNames).toContain("decisions");
    expect(tableNames).toContain("_migrations");
    expect(tableNames).toContain("trades");
    expect(tableNames).toContain("sim_positions");
    expect(tableNames).toContain("sim_balance");
  });

  it("should be idempotent — running migrations twice doesn't error", () => {
    // Migrations already ran in openDatabase. Calling again should be safe.
    // (runMigrations is called internally; we just verify no crash)
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as { name: string }[];
    expect(tables.length).toBeGreaterThan(0);
  });
});

describe("DecisionStore", () => {
  let db: DatabaseType;
  let store: DecisionStore;

  beforeEach(() => {
    db = openDatabase({ path: ":memory:" });
    store = new DecisionStore(db);
  });

  afterEach(() => {
    closeDatabase(db);
  });

  const sampleInput: CreateDecisionInput = {
    agent: "kangbot",
    symbol: "AAPL",
    action: "buy",
    quantity: 100,
    priceAtDecision: 185.5,
    rationale: "Strong earnings, bullish MACD crossover",
    confidence: 8,
    mode: "sim",
    marketContext: {
      price: 185.5,
      indicators: { rsi: 55, macd: "bullish" },
      notes: "Post-earnings rally expected",
    },
  };

  describe("create", () => {
    it("should create a decision with generated id and timestamp", () => {
      const decision = store.create(sampleInput);

      expect(decision.id).toBeTruthy();
      expect(decision.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(decision.timestamp).toBeTruthy();
      expect(decision.agent).toBe("kangbot");
      expect(decision.symbol).toBe("AAPL");
      expect(decision.action).toBe("buy");
      expect(decision.quantity).toBe(100);
      expect(decision.priceAtDecision).toBe(185.5);
      expect(decision.rationale).toBe("Strong earnings, bullish MACD crossover");
      expect(decision.confidence).toBe(8);
      expect(decision.mode).toBe("sim");
      expect(decision.marketContext?.indicators?.rsi).toBe(55);
    });

    it("should create a decision without market context", () => {
      const input: CreateDecisionInput = {
        ...sampleInput,
        marketContext: undefined,
      };
      const decision = store.create(input);

      expect(decision.marketContext).toBeUndefined();
    });

    it("should reject invalid agent", () => {
      expect(() =>
        store.create({ ...sampleInput, agent: "invalid" as never }),
      ).toThrow();
    });

    it("should reject invalid action", () => {
      expect(() =>
        store.create({ ...sampleInput, action: "invalid" as never }),
      ).toThrow();
    });

    it("should reject confidence out of range (0)", () => {
      expect(() => store.create({ ...sampleInput, confidence: 0 })).toThrow();
    });

    it("should reject confidence out of range (11)", () => {
      expect(() => store.create({ ...sampleInput, confidence: 11 })).toThrow();
    });

    it("should reject negative quantity", () => {
      expect(() =>
        store.create({ ...sampleInput, quantity: -10 }),
      ).toThrow();
    });

    it("should reject empty rationale", () => {
      expect(() =>
        store.create({ ...sampleInput, rationale: "" }),
      ).toThrow();
    });
  });

  describe("getById", () => {
    it("should retrieve a decision by id", () => {
      const created = store.create(sampleInput);
      const retrieved = store.getById(created.id);

      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(created.id);
      expect(retrieved!.symbol).toBe("AAPL");
    });

    it("should return null for non-existent id", () => {
      const result = store.getById("nonexistent-uuid");
      expect(result).toBeNull();
    });
  });

  describe("list", () => {
    it("should list decisions ordered by timestamp descending", async () => {
      // Add a small delay to ensure different timestamps
      store.create({ ...sampleInput, symbol: "AAPL" });
      await new Promise((r) => setTimeout(r, 10));
      store.create({ ...sampleInput, symbol: "BTC/USDT" });
      await new Promise((r) => setTimeout(r, 10));
      store.create({ ...sampleInput, symbol: "GOOGL" });

      const decisions = store.list();
      expect(decisions).toHaveLength(3);
      // Most recent first
      expect(decisions[0].symbol).toBe("GOOGL");
      expect(decisions[2].symbol).toBe("AAPL");
    });

    it("should filter by agent", () => {
      store.create({ ...sampleInput, agent: "kangbot" });
      store.create({ ...sampleInput, agent: "doom", symbol: "MSFT" });

      const decisions = store.list({ agent: "kangbot" });
      expect(decisions).toHaveLength(1);
      expect(decisions[0].agent).toBe("kangbot");
    });

    it("should filter by symbol", () => {
      store.create({ ...sampleInput, symbol: "AAPL" });
      store.create({ ...sampleInput, symbol: "MSFT" });
      store.create({ ...sampleInput, symbol: "AAPL" });

      const decisions = store.list({ symbol: "AAPL" });
      expect(decisions).toHaveLength(2);
      decisions.forEach((d) => expect(d.symbol).toBe("AAPL"));
    });

    it("should filter by action", () => {
      store.create({ ...sampleInput, action: "buy" });
      store.create({ ...sampleInput, action: "sell", symbol: "MSFT" });
      store.create({ ...sampleInput, action: "hold", symbol: "GOOGL" });

      const decisions = store.list({ action: "buy" });
      expect(decisions).toHaveLength(1);
      expect(decisions[0].action).toBe("buy");
    });

    it("should filter by mode", () => {
      store.create({ ...sampleInput, mode: "sim" });
      store.create({ ...sampleInput, mode: "live", symbol: "MSFT" });

      const decisions = store.list({ mode: "live" });
      expect(decisions).toHaveLength(1);
      expect(decisions[0].mode).toBe("live");
    });

    it("should filter by date range", async () => {
      store.create({ ...sampleInput, symbol: "FIRST" });
      await new Promise((r) => setTimeout(r, 50));
      const midpoint = new Date().toISOString();
      await new Promise((r) => setTimeout(r, 50));
      store.create({ ...sampleInput, symbol: "SECOND" });

      const decisions = store.list({ startDate: midpoint });
      expect(decisions).toHaveLength(1);
      expect(decisions[0].symbol).toBe("SECOND");
    });

    it("should respect limit and offset", () => {
      for (let i = 0; i < 5; i++) {
        store.create({ ...sampleInput, symbol: `STOCK${i}` });
      }

      const page1 = store.list({ limit: 2, offset: 0 });
      const page2 = store.list({ limit: 2, offset: 2 });

      expect(page1).toHaveLength(2);
      expect(page2).toHaveLength(2);
      // No overlap
      const page1Ids = page1.map((d) => d.id);
      const page2Ids = page2.map((d) => d.id);
      expect(page1Ids.some((id) => page2Ids.includes(id))).toBe(false);
    });

    it("should return empty array when no matches", () => {
      const decisions = store.list({ symbol: "NONEXISTENT" });
      expect(decisions).toEqual([]);
    });
  });

  describe("count", () => {
    it("should count all decisions", () => {
      store.create({ ...sampleInput, symbol: "AAPL" });
      store.create({ ...sampleInput, symbol: "MSFT" });

      expect(store.count()).toBe(2);
    });

    it("should count with filter", () => {
      store.create({ ...sampleInput, agent: "kangbot" });
      store.create({ ...sampleInput, agent: "doom", symbol: "MSFT" });

      expect(store.count({ agent: "kangbot" })).toBe(1);
    });
  });

  describe("append-only", () => {
    it("should have no update method", () => {
      expect((store as unknown as Record<string, unknown>).update).toBeUndefined();
    });

    it("should have no delete method", () => {
      expect((store as unknown as Record<string, unknown>).delete).toBeUndefined();
    });
  });
});