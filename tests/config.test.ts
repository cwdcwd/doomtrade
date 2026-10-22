import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

describe("config", () => {
  it("loads with defaults when no env vars set", () => {
    const config = loadConfig({});
    expect(config.port).toBe(3000);
    expect(config.tradeMode).toBe("sim");
    expect(config.alpacaPaper).toBe(true);
    expect(config.simStartingBalance).toBe(100_000);
    expect(config.simFeePct).toBe(0.1);
  });

  it("parses trade mode from env", () => {
    const config = loadConfig({ TRADE_MODE: "live" });
    expect(config.tradeMode).toBe("live");
  });

  it("parses port from env", () => {
    const config = loadConfig({ PORT: "8080" });
    expect(config.port).toBe(8080);
  });

  it("throws on invalid trade mode", () => {
    expect(() => loadConfig({ TRADE_MODE: "yolo" })).toThrow();
  });

  it("throws on negative port", () => {
    expect(() => loadConfig({ PORT: "-1" })).toThrow();
  });

  it("parses risk limits from env", () => {
    const config = loadConfig({
      MAX_OPEN_POSITIONS: "5",
      DAILY_TRADE_LIMIT: "50",
      MAX_DRAWDOWN_PCT: "25",
    });
    expect(config.maxOpenPositions).toBe(5);
    expect(config.dailyTradeLimit).toBe(50);
    expect(config.maxDrawdownPct).toBe(25);
  });

  it("alpacaPaper defaults true, only false when explicitly set", () => {
    expect(loadConfig({}).alpacaPaper).toBe(true);
    expect(loadConfig({ ALPACA_PAPER: "false" }).alpacaPaper).toBe(false);
    expect(loadConfig({ ALPACA_PAPER: "true" }).alpacaPaper).toBe(true);
  });
});