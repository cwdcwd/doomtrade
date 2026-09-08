/**
 * Shared types and imports for route modules.
 *
 * The AppState interface and common dependencies are re-exported here so
 * each domain route file can import from a single location.
 */

import type { Router, Request, Response, NextFunction } from "express";
import type { DecisionStore } from "../../decision/decision-store.js";
import type { TradeEngine } from "../../engine/trade-engine.js";
import type { Portfolio } from "../../portfolio/portfolio.js";
import type { Config } from "../../config.js";
import type { MarketDataService } from "../../market/market.js";
import type { ResearchService } from "../../research/research.js";
import type { ThemeRunner } from "../../themes/theme-runner.js";
import type { ThemeSchedule } from "../../themes/theme.js";
import {
  CreateDecisionBodySchema,
  ListDecisionsQuerySchema,
  ExecuteTradeBodySchema,
  PortfolioHistoryQuerySchema,
  ToggleModeBodySchema,
  ListTradesQuerySchema,
  TradeAnalyticsQuerySchema,
  CreateThemeBodySchema,
  UpdateThemeBodySchema,
  ListThemesQuerySchema,
  CreateAgentBodySchema,
  UpdateAgentBodySchema,
  ListAgentTradesQuerySchema,
} from "../schemas.js";
import { z } from "zod";
import { errorMessage } from "../../util/error.js";

export {
  type Router,
  type Request,
  type Response,
  type NextFunction,
  type DecisionStore,
  type TradeEngine,
  type Portfolio,
  type Config,
  type MarketDataService,
  type ResearchService,
  type ThemeRunner,
  type ThemeSchedule,
  CreateDecisionBodySchema,
  ListDecisionsQuerySchema,
  ExecuteTradeBodySchema,
  PortfolioHistoryQuerySchema,
  ToggleModeBodySchema,
  ListTradesQuerySchema,
  TradeAnalyticsQuerySchema,
  CreateThemeBodySchema,
  UpdateThemeBodySchema,
  ListThemesQuerySchema,
  CreateAgentBodySchema,
  UpdateAgentBodySchema,
  ListAgentTradesQuerySchema,
  z,
  errorMessage,
};

// ── App state container ─────────────────────────────────────────

export interface AppState {
  decisionStore: DecisionStore;
  tradeEngine: TradeEngine;
  portfolio: Portfolio;
  config: Config;
  /** Mutable mode — can be toggled at runtime via POST /api/mode */
  currentMode: "sim" | "live";
  /** Timestamp when mode was last toggled — for cooldown enforcement */
  modeChangedAt: number;
  /** Market data service — optional, may not be available without API keys */
  marketData?: MarketDataService;
  /** Research service for technical analysis */
  research?: ResearchService;
  /** Theme runner for experimental strategies */
  themeRunner?: ThemeRunner;
  /** Database instance for direct access (theme store, etc.) */
  db: import("../../db/database.js").Database;
  /** Agent manager for per-agent portfolios */
  agentManager?: import("../../agent/agent-manager.js").AgentManager;
  /** Per-agent trade engine for risk-scoped execution */
  agentTradeEngine?: import("../../engine/agent-trade-engine.js").AgentTradeEngine;
  /** Agent trading pipeline for strategy evaluation */
  agentPipeline?: import("../../agent/trading-pipeline.js").AgentTradingPipeline;
  /** A2A trading coordinator for multi-agent orchestration */
  a2aCoordinator?: import("../../integration/a2a-trading-coordinator.js").A2ATradingCoordinator;
}

// ── Mode toggle cooldown (seconds) ──────────────────────────────

export const MODE_COOLDOWN_SECONDS = 60;
