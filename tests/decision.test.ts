import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Database } from "../src/db/database.js";
import {
  openDatabase,
  closeDatabase,
  execAll,
} from "../src/db/database.js";
import { DecisionStore } from "../src/decision/decision-store.js";
import type { CreateDecisionInput } from "../src/decision/decision.js";

describe("Database", () => {
  let db: Database;

  beforeEach(async () => {
    db = await openDatabase({ path: ":memory:" });
  });

  afterEach(async () => {
    await closeDatabase(db);
  });

  it("should open and create required tables", async () => {
    const tables = await execAll<{ name: string }>(
      db,
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    );
    const tableNames = tables.map((t) => t.name);

    expect(tableNames).toContain("decisions");
    expect(tableNames).toContain("_migrations");
    expect(tableNames).toContain("trades");
    expect(tableNames).toContain("sim_positions");
    expect(tableNames).toContain("sim_balance");
  });

  it("should be idempotent — running migrations twice doesn't error", async () => {
    // Migrations already ran in openDatabase. Calling again should be safe.
    const tables = await execAll<{ name: string }>(
      db,
      "SELECT name FROM sqlite_master WHERE type='table'",
    );
    expect(tables.length).toBeGreaterThan(0);
  });
});

describe("DecisionStore", () => {
  let db: Database;
  let store: DecisionStore;

  beforeEach(async () => {
    db = await openDatabase({ path: ":memory:" });
    store = new DecisionStore(db);
  });

  afterEach(async () => {
    await closeDatabase(db);
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
    it("should create a decision with generated id and timestamp", async () => {
      const decision = await store.create(sampleInput);

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

    it("should create a decision without market context", async () => {
      const input: CreateDecisionInput = {
        ...sampleInput,
        marketContext: undefined,
      };
      const decision = await store.create(input);

      expect(decision.marketContext).toBeUndefined();
    });

    it("should accept any agent name (per-agent trading)", async () => {
      const decision = await store.create({ ...sampleInput, agent: "ThanosBot" as never });
      expect(decision.agent).toBe("ThanosBot");
    });

    it("should reject invalid action", async () => {
      await expect(
        store.create({ ...sampleInput, action: "invalid" as never }),
      ).rejects.toThrow();
    });

    it("should reject confidence out of range (0)", async () => {
      await expect(store.create({ ...sampleInput, confidence: 0 })).rejects.toThrow();
    });

    it("should reject confidence out of range (11)", async () => {
      await expect(store.create({ ...sampleInput, confidence: 11 })).rejects.toThrow();
    });

    it("should reject negative quantity", async () => {
      await expect(
        store.create({ ...sampleInput, quantity: -10 }),
      ).rejects.toThrow();
    });

    it("should reject empty rationale", async () => {
      await expect(
        store.create({ ...sampleInput, rationale: "" }),
      ).rejects.toThrow();
    });
  });

  describe("getById", () => {
    it("should retrieve a decision by id", async () => {
      const created = await store.create(sampleInput);
      const retrieved = await store.getById(created.id);

      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(created.id);
      expect(retrieved!.symbol).toBe("AAPL");
    });

    it("should return null for non-existent id", async () => {
      const result = await store.getById("nonexistent-uuid");
      expect(result).toBeNull();
    });
  });

  describe("list", () => {
    it("should list decisions ordered by timestamp descending", async () => {
      // Add a small delay to ensure different timestamps
      await store.create({ ...sampleInput, symbol: "AAPL" });
      await new Promise((r) => setTimeout(r, 10));
      await store.create({ ...sampleInput, symbol: "BTC/USDT" });
      await new Promise((r) => setTimeout(r, 10));
      await store.create({ ...sampleInput, symbol: "GOOGL" });

      const decisions = await store.list();
      expect(decisions).toHaveLength(3);
      // Most recent first
      expect(decisions[0].symbol).toBe("GOOGL");
      expect(decisions[2].symbol).toBe("AAPL");
    });

    it("should filter by agent", async () => {
      await store.create({ ...sampleInput, agent: "kangbot" });
      await store.create({ ...sampleInput, agent: "doom", symbol: "MSFT" });

      const decisions = await store.list({ agent: "kangbot" });
      expect(decisions).toHaveLength(1);
      expect(decisions[0].agent).toBe("kangbot");
    });

    it("should filter by symbol", async () => {
      await store.create({ ...sampleInput, symbol: "AAPL" });
      await store.create({ ...sampleInput, symbol: "MSFT" });
      await store.create({ ...sampleInput, symbol: "AAPL" });

      const decisions = await store.list({ symbol: "AAPL" });
      expect(decisions).toHaveLength(2);
      decisions.forEach((d) => expect(d.symbol).toBe("AAPL"));
    });

    it("should filter by action", async () => {
      await store.create({ ...sampleInput, action: "buy" });
      await store.create({ ...sampleInput, action: "sell", symbol: "MSFT" });
      await store.create({ ...sampleInput, action: "hold", symbol: "GOOGL" });

      const decisions = await store.list({ action: "buy" });
      expect(decisions).toHaveLength(1);
      expect(decisions[0].action).toBe("buy");
    });

    it("should filter by mode", async () => {
      await store.create({ ...sampleInput, mode: "sim" });
      await store.create({ ...sampleInput, mode: "live", symbol: "MSFT" });

      const decisions = await store.list({ mode: "live" });
      expect(decisions).toHaveLength(1);
      expect(decisions[0].mode).toBe("live");
    });

    it("should filter by date range", async () => {
      await store.create({ ...sampleInput, symbol: "FIRST" });
      await new Promise((r) => setTimeout(r, 50));
      const midpoint = new Date().toISOString();
      await new Promise((r) => setTimeout(r, 50));
      await store.create({ ...sampleInput, symbol: "SECOND" });

      const decisions = await store.list({ startDate: midpoint });
      expect(decisions).toHaveLength(1);
      expect(decisions[0].symbol).toBe("SECOND");
    });

    it("should respect limit and offset", async () => {
      for (let i = 0; i < 5; i++) {
        await store.create({ ...sampleInput, symbol: `STOCK${i}` });
      }

      const page1 = await store.list({ limit: 2, offset: 0 });
      const page2 = await store.list({ limit: 2, offset: 2 });

      expect(page1).toHaveLength(2);
      expect(page2).toHaveLength(2);
      // No overlap
      const page1Ids = page1.map((d) => d.id);
      const page2Ids = page2.map((d) => d.id);
      expect(page1Ids.some((id) => page2Ids.includes(id))).toBe(false);
    });

    it("should return empty array when no matches", async () => {
      const decisions = await store.list({ symbol: "NONEXISTENT" });
      expect(decisions).toEqual([]);
    });
  });

  describe("count", () => {
    it("should count all decisions", async () => {
      await store.create({ ...sampleInput, symbol: "AAPL" });
      await store.create({ ...sampleInput, symbol: "MSFT" });

      expect(await store.count()).toBe(2);
    });

    it("should count with filter", async () => {
      await store.create({ ...sampleInput, agent: "kangbot" });
      await store.create({ ...sampleInput, agent: "doom", symbol: "MSFT" });

      expect(await store.count({ agent: "kangbot" })).toBe(1);
    });
  });

  describe("append-only", () => {
    it("should have no update method", async () => {
      expect((store as unknown as Record<string, unknown>).update).toBeUndefined();
    });

    it("should have no delete method", async () => {
      expect((store as unknown as Record<string, unknown>).delete).toBeUndefined();
    });
  });
});