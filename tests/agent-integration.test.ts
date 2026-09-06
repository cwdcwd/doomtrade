import { describe, it, expect, beforeEach, vi } from "vitest";
import { openDatabase } from "../src/db/database.js";
import { DecisionStore } from "../src/decision/decision-store.js";
import { SimulatedExchange } from "../src/executor/simulated.js";
import { TradeEngine } from "../src/engine/trade-engine.js";
import { Portfolio } from "../src/portfolio/portfolio.js";
import { AgentCoordinator } from "../src/integration/agent-integration.js";

// ── Mock A2AClient ──────────────────────────────────────────────

const mockNotify = vi.fn().mockResolvedValue(undefined);
const mockSendMessage = vi.fn().mockResolvedValue(undefined);

vi.mock("@cwdcwd/agent-bridge", () => ({
  A2AClient: vi.fn().mockImplementation(() => ({
    notify: mockNotify,
    sendMessage: mockSendMessage,
  })),
}));

// ── Helpers ─────────────────────────────────────────────────────

async function createCoordinator() {
  const db = await openDatabase({ path: ":memory:" });
  const decisionStore = new DecisionStore(db);
  const priceMap: Record<string, number> = { AAPL: 150, TSLA: 250, "BTC/USDT": 68000 };
  const executor = new SimulatedExchange(db, {
    initialCash: 100_000,
    feeRate: 0.001,
    getCurrentPrice: (symbol: string) => priceMap[symbol] ?? null,
  });
  const tradeEngine = new TradeEngine(db, executor, {
    tradeMode: "sim",
    maxOpenPositions: 10,
    maxPositionSizePct: 20,
    dailyTradeLimit: 20,
    maxDrawdownPct: 15,
  });
  const portfolio = new Portfolio(db, executor, {
    mode: "sim",
    initialCapital: 100_000,
  });

  const coordinator = new AgentCoordinator(
    decisionStore,
    tradeEngine,
    portfolio,
    {
      peerEndpoint: "https://ai.lan/v1/agents/test-agent",
      peerToken: "test-token",
      selfName: "doom",
    },
  );

  return { coordinator, decisionStore, tradeEngine, portfolio, executor, db };
}

// ── Tests ───────────────────────────────────────────────────────

describe("AgentCoordinator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("submitDecision", () => {
    it("should create a decision and notify the peer agent", async () => {
      const { coordinator } = await createCoordinator();

      const decision = await coordinator.submitDecision({
        agent: "doom",
        symbol: "AAPL",
        action: "buy",
        quantity: 10,
        rationale: "Strong earnings beat, undervalued",
        confidence: 8,
        priceAtDecision: 150.5,
        mode: "sim",
      });

      expect(decision).toBeDefined();
      expect(decision.id).toBeDefined();
      expect(decision.symbol).toBe("AAPL");
      expect(decision.action).toBe("buy");
      expect(decision.quantity).toBe(10);
      expect(decision.agent).toBe("doom");

      // Should notify peer
      expect(mockNotify).toHaveBeenCalledWith(
        "decision:created",
        expect.objectContaining({
          decisionId: decision.id,
          agent: "doom",
          symbol: "AAPL",
          action: "buy",
          quantity: 10,
          confidence: 8,
        }),
        "doom",
      );
    });

    it("should store the decision in the decision store", async () => {
      const { coordinator, decisionStore } = await createCoordinator();

      const decision = await coordinator.submitDecision({
        agent: "kangbot",
        symbol: "BTC/USDT",
        action: "sell",
        quantity: 0.5,
        rationale: "RSI overbought, taking profit",
        confidence: 7,
        priceAtDecision: 68000,
        mode: "sim",
      });

      const stored = decisionStore.getById(decision.id);
      expect(stored).toBeDefined();
      expect(stored!.symbol).toBe("BTC/USDT");
      expect(stored!.action).toBe("sell");
    });

    it("should handle hold decisions", async () => {
      const { coordinator } = await createCoordinator();

      const decision = await coordinator.submitDecision({
        agent: "doom",
        symbol: "TSLA",
        action: "hold",
        quantity: 1,
        rationale: "Waiting for better entry point",
        confidence: 5,
        priceAtDecision: 250,
        mode: "sim",
      });

      expect(decision.action).toBe("hold");
      expect(mockNotify).toHaveBeenCalledWith(
        "decision:created",
        expect.objectContaining({ action: "hold" }),
        "doom",
      );
    });
  });

  describe("executeDecision", () => {
    it("should execute a buy decision and notify the peer of the fill", async () => {
      const { coordinator } = await createCoordinator();

      const decision = await coordinator.submitDecision({
        agent: "doom",
        symbol: "AAPL",
        action: "buy",
        quantity: 10,
        rationale: "Strong fundamentals",
        confidence: 8,
        priceAtDecision: 150,
        mode: "sim",
      });

      // Clear the decision:created notification
      mockNotify.mockClear();

      await coordinator.executeDecision(decision.id);

      // Should notify trade:executed
      expect(mockNotify).toHaveBeenCalledWith(
        "trade:executed",
        expect.objectContaining({
          decisionId: decision.id,
          symbol: "AAPL",
          status: "filled",
        }),
        "doom",
      );
    });

    it("should throw for a non-existent decision", async () => {
      const { coordinator } = await createCoordinator();

      await expect(
        coordinator.executeDecision("nonexistent-id"),
      ).rejects.toThrow("Decision not found: nonexistent-id");
    });

    it("should notify peer when risk checks block a trade", async () => {
      const { coordinator } = await createCoordinator();

      // Create a decision with a huge quantity that will exceed position size limit
      const decision = await coordinator.submitDecision({
        agent: "doom",
        symbol: "AAPL",
        action: "buy",
        quantity: 1000,
        rationale: "Going big",
        confidence: 3,
        priceAtDecision: 150,
        mode: "sim",
      });

      // Clear the decision:created notification
      mockNotify.mockClear();

      await coordinator.executeDecision(decision.id);

      // Should notify trade:blocked (risk check fails on position size)
      expect(mockNotify).toHaveBeenCalledWith(
        "trade:blocked",
        expect.objectContaining({
          decisionId: decision.id,
          reasons: expect.any(Array),
        }),
        "doom",
      );
    });

    it("should handle hold decisions (no trade executed)", async () => {
      const { coordinator } = await createCoordinator();

      const decision = await coordinator.submitDecision({
        agent: "doom",
        symbol: "TSLA",
        action: "hold",
        quantity: 1,
        rationale: "Waiting",
        confidence: 5,
        priceAtDecision: 250,
        mode: "sim",
      });

      mockNotify.mockClear();

      await coordinator.executeDecision(decision.id);

      // Hold decisions pass risk checks but don't execute orders
      // No trade:executed or trade:blocked notification
      expect(mockNotify).not.toHaveBeenCalledWith(
        "trade:executed",
        expect.anything(),
        expect.anything(),
      );
    });
  });

  describe("getPortfolioStatus", () => {
    it("should return portfolio snapshot and P&L", async () => {
      const { coordinator } = await createCoordinator();

      const status = await coordinator.getPortfolioStatus();

      expect(status.snapshot).toBeDefined();
      expect(status.snapshot.equity).toBe(100_000);
      expect(status.snapshot.cash).toBe(100_000);
      expect(status.snapshot.mode).toBe("sim");
      expect(status.pnl).toBeDefined();
      expect(status.pnl.unrealized).toBe(0);
      expect(status.pnl.realized).toBe(0);
    });
  });

  describe("sendMessage", () => {
    it("should send a freeform message to the peer", async () => {
      const { coordinator } = await createCoordinator();

      await coordinator.sendMessage("Hey Kangbot, check AAPL earnings");

      expect(mockSendMessage).toHaveBeenCalledWith(
        "Hey Kangbot, check AAPL earnings",
        "doom",
      );
    });
  });
});