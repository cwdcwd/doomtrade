/**
 * Strategy interface for experimental themes.
 *
 * Each strategy implementation evaluates signals and produces decisions
 * on each scheduled tick. Strategies are registered with the ThemeRunner
 * by their `type` identifier.
 */

import type { ThemeConfig, ThemeEvaluationResult } from "./theme.js";
import type { DecisionStore } from "../decision/decision-store.js";
import type { TradeEngine } from "../engine/trade-engine.js";
import type { Portfolio } from "../portfolio/portfolio.js";
import type { MarketDataService } from "../market/market.js";
import type { Position } from "../executor/executor.js";
import type { Database } from "../db/database.js";

/**
 * Context passed to strategies — provides access to platform services.
 */
export interface ThemeContext {
  /** Database client for persistence */
  db: Database;
  /** Market data service for price/indicator lookups */
  marketData: MarketDataService;
  /** Decision store for creating decisions */
  decisionStore: DecisionStore;
  /** Trade engine for executing decisions */
  tradeEngine: TradeEngine;
  /** Portfolio service for balance/position queries */
  portfolio: Portfolio;
  /** Current equity of the theme's sub-account */
  getEquity(): Promise<number>;
  /** Current positions in the theme's sub-account */
  getPositions(): Promise<Position[]>;
  /** Fetch current price for a symbol */
  getQuote(symbol: string): Promise<number>;
  /** Theme ID for attribution */
  themeId: string;
  /** Optional executor for trade execution. When provided (by the agent
   *  pipeline), strategies should use this instead of creating a
   *  ThemeSubAccount. Falls back to ThemeSubAccount when absent (theme runner). */
  exchange?: import("../executor/executor.js").Executor;
}

/**
 * A theme strategy implementation.
 *
 * Register with ThemeRunner by calling `registerStrategy(instance)`.
 * The `type` field must match `ThemeConfig.strategy`.
 */
export interface ThemeStrategy {
  /** Strategy type identifier — matches ThemeConfig.strategy */
  readonly type: string;

  /**
   * Evaluate the strategy: gather signals and produce decisions.
   * Called on each scheduled tick.
   */
  evaluate(
    ctx: ThemeContext,
    config: ThemeConfig,
  ): Promise<ThemeEvaluationResult>;
}