/**
 * Tests for AgentExchange — per-agent simulated trading executor.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { openDatabase, type Database } from "../src/db/database.js";
import { AgentExchange } from "../src/executor/agent-exchange.js";
import { AgentManager } from "../src/agent/agent-manager.js";

let db: Database;
let manager: AgentManager;

beforeEach(async () => {
  db = await openDatabase({ path: ":memory:", url: undefined });
  manager = new AgentManager(db, { defaultStartingBalance: 100, feeRate: 0.001 });
});

describe("AgentManager", () => {
  it("registers a new agent", async () => {
    const agent = await manager.register("TestBot", { startingBalance: 50, strategy: "momentum-rotation" });
    expect(agent.name).toBe("TestBot");
    expect(agent.startingBalance).toBe(50);
    expect(agent.strategy).toBe("momentum-rotation");
    expect(agent.active).toBe(true);
  });

  it("gets an agent by name", async () => {
    await manager.register("TestBot");
    const agent = await manager.getByName("TestBot");
    expect(agent).not.toBeNull();
    expect(agent!.name).toBe("TestBot");
  });

  it("auto-provisions an unknown agent via getOrCreate", async () => {
    const agent = await manager.getOrCreate("NewBot");
    expect(agent.name).toBe("NewBot");
    expect(agent.startingBalance).toBe(100); // default

    // Second call returns existing
    const agent2 = await manager.getOrCreate("NewBot");
    expect(agent2.id).toBe(agent.id);
  });

  it("lists agents with portfolio summaries", async () => {
    await manager.register("Doom", { startingBalance: 100 });
    await manager.register("Kangbot", { startingBalance: 100 });

    const summaries = await manager.list();
    expect(summaries).toHaveLength(2);
    expect(summaries[0].name).toBe("Doom");
    expect(summaries[0].equity).toBe(100); // no trades yet
    expect(summaries[0].cash).toBe(100);
  });

  it("produces a leaderboard ranked by return", async () => {
    const doom = await manager.register("Doom", { startingBalance: 100 });
    const kangbot = await manager.register("Kangbot", { startingBalance: 100 });

    // Give Doom a winning trade (simulate by direct balance manipulation)
    const doomExchange = manager.getExchange(doom.id);
    // Buy something then sell at a higher price
    await doomExchange.placeOrder({
      symbol: "TEST/USDT",
      side: "buy",
      quantity: 10,
      orderType: "limit",
      limitPrice: 1.0,
    });
    await doomExchange.placeOrder({
      symbol: "TEST/USDT",
      side: "sell",
      quantity: 10,
      orderType: "limit",
      limitPrice: 2.0,
    });

    const board = await manager.leaderboard();
    expect(board).toHaveLength(2);
    expect(board[0].name).toBe("Doom"); // made profit
    expect(board[0].totalReturn).toBeGreaterThan(0);
    expect(board[0].rank).toBe(1);
  });

  it("updates an agent's strategy", async () => {
    const agent = await manager.register("TestBot", { strategy: "momentum-rotation" });
    await manager.setStrategy(agent.id, "congress-follower");
    const updated = await manager.getById(agent.id);
    expect(updated!.strategy).toBe("congress-follower");
  });

  it("deactivates an agent", async () => {
    const agent = await manager.register("TestBot");
    await manager.deactivate(agent.id);
    const updated = await manager.getById(agent.id);
    expect(updated!.active).toBe(false);
  });

  it("seeds default agents without duplicating", async () => {
    await manager.seedDefaults([
      { name: "Doom", startingBalance: 100, strategy: "momentum-rotation" },
      { name: "Kangbot", startingBalance: 100, strategy: "congress-follower" },
      { name: "ThanosBot", startingBalance: 100, strategy: "agent-driven" },
    ]);

    // Seed again — should not duplicate
    await manager.seedDefaults([
      { name: "Doom", startingBalance: 100, strategy: "momentum-rotation" },
      { name: "Kangbot", startingBalance: 100, strategy: "congress-follower" },
      { name: "ThanosBot", startingBalance: 100, strategy: "agent-driven" },
    ]);

    const agents = await manager.list();
    expect(agents).toHaveLength(3);
  });
});

describe("AgentExchange", () => {
  it("initializes with starting balance", async () => {
    const agent = await manager.register("TestBot", { startingBalance: 100 });
    const exchange = manager.getExchange(agent.id);
    const balance = await exchange.getBalance();
    expect(balance.cash).toBe(100);
    expect(balance.equity).toBe(100);
    expect(balance.initialCash).toBe(100);
  });

  it("places a buy order and updates position", async () => {
    const agent = await manager.register("TestBot", { startingBalance: 100 });
    const exchange = manager.getExchange(agent.id);

    const result = await exchange.placeOrder({
      symbol: "BTC/USDT",
      side: "buy",
      quantity: 0.001,
      orderType: "limit",
      limitPrice: 50000,
    });

    expect(result.status).toBe("filled");
    expect(result.fillPrice).toBe(50000);

    const positions = await exchange.getPositions();
    expect(positions).toHaveLength(1);
    expect(positions[0].symbol).toBe("BTC/USDT");
    expect(positions[0].quantity).toBe(0.001);
    expect(positions[0].avgEntryPrice).toBe(50000);
  });

  it("deducts cash and fee on buy", async () => {
    const agent = await manager.register("TestBot", { startingBalance: 100 });
    const exchange = manager.getExchange(agent.id);

    await exchange.placeOrder({
      symbol: "ETH/USDT",
      side: "buy",
      quantity: 1,
      orderType: "limit",
      limitPrice: 50,
    });

    const balance = await exchange.getBalance();
    // 50 cost + 0.05 fee (0.1% of 50)
    expect(balance.cash).toBeCloseTo(49.95, 2);
  });

  it("places a sell order and realizes P&L", async () => {
    const agent = await manager.register("TestBot", { startingBalance: 100 });
    const exchange = manager.getExchange(agent.id);

    // Buy at 50
    await exchange.placeOrder({
      symbol: "ETH/USDT",
      side: "buy",
      quantity: 1,
      orderType: "limit",
      limitPrice: 50,
    });

    // Sell at 60
    const sellResult = await exchange.placeOrder({
      symbol: "ETH/USDT",
      side: "sell",
      quantity: 1,
      orderType: "limit",
      limitPrice: 60,
    });

    expect(sellResult.status).toBe("filled");
    expect(sellResult.fillPrice).toBe(60);
    expect(sellResult.realizedPnl).toBeGreaterThan(0);
    // PnL = (60 - 50) * 1 - 0.06 (sell fee) = 9.94
    expect(sellResult.realizedPnl).toBeCloseTo(9.94, 2);
  });

  it("rejects sell without position", async () => {
    const agent = await manager.register("TestBot", { startingBalance: 100 });
    const exchange = manager.getExchange(agent.id);

    const result = await exchange.placeOrder({
      symbol: "BTC/USDT",
      side: "sell",
      quantity: 0.01,
      orderType: "limit",
      limitPrice: 50000,
    });

    expect(result.status).toBe("rejected");
    expect(result.error).toContain("Insufficient position");
  });

  it("tracks trade history", async () => {
    const agent = await manager.register("TestBot", { startingBalance: 100 });
    const exchange = manager.getExchange(agent.id);

    await exchange.placeOrder({
      symbol: "ETH/USDT", side: "buy", quantity: 1, orderType: "limit", limitPrice: 50,
    });
    await exchange.placeOrder({
      symbol: "ETH/USDT", side: "sell", quantity: 1, orderType: "limit", limitPrice: 55,
    });

    const trades = await exchange.getTrades();
    expect(trades).toHaveLength(2);
    // One buy and one sell — order may vary due to same-timestamp ordering
    const sides = trades.map(t => t.side).sort();
    expect(sides).toEqual(["buy", "sell"]);
  });

  it("records portfolio checkpoint", async () => {
    const agent = await manager.register("TestBot", { startingBalance: 100 });
    const exchange = manager.getExchange(agent.id);

    await exchange.placeOrder({
      symbol: "ETH/USDT", side: "buy", quantity: 1, orderType: "limit", limitPrice: 50,
    });

    await exchange.recordCheckpoint();

    const balance = await exchange.getBalance();
    expect(balance.equity).toBeCloseTo(99.95, 2); // 49.95 cash + 50 position
  });

  it("keeps agent portfolios independent", async () => {
    const doom = await manager.register("Doom", { startingBalance: 100 });
    const kangbot = await manager.register("Kangbot", { startingBalance: 100 });

    const doomEx = manager.getExchange(doom.id);
    const kangbotEx = manager.getExchange(kangbot.id);

    await doomEx.placeOrder({
      symbol: "BTC/USDT", side: "buy", quantity: 0.001, orderType: "limit", limitPrice: 50000,
    });

    // Doom has a position, Kangbot doesn't
    const doomPositions = await doomEx.getPositions();
    const kangbotPositions = await kangbotEx.getPositions();
    expect(doomPositions).toHaveLength(1);
    expect(kangbotPositions).toHaveLength(0);

    // Doom cash reduced, Kangbot cash unchanged
    const doomBalance = await doomEx.getBalance();
    const kangbotBalance = await kangbotEx.getBalance();
    expect(doomBalance.cash).toBeLessThan(100);
    expect(kangbotBalance.cash).toBe(100);
  });

  it("rejects buy with insufficient cash", async () => {
    const agent = await manager.register("TestBot", { startingBalance: 100 });
    const exchange = manager.getExchange(agent.id);

    const result = await exchange.placeOrder({
      symbol: "BTC/USDT",
      side: "buy",
      quantity: 1,
      orderType: "limit",
      limitPrice: 50000,
    });

    expect(result.status).toBe("rejected");
    expect(result.error).toContain("Insufficient cash");
  });
});