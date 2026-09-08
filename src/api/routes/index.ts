/**
 * Route aggregator — combines all domain routers into a single Express Router.
 *
 * Re-exports AppState and createApiRouter for backward compatibility.
 */

import { Router } from "express";
import type { AppState } from "./types.js";

export { type AppState } from "./types.js";
export { MODE_COOLDOWN_SECONDS } from "./types.js";

import { createHealthRouter, createAdminRouter } from "./health.js";
import { createDecisionsRouter } from "./decisions.js";
import { createTradesRouter } from "./trades.js";
import { createPortfolioRouter } from "./portfolio.js";
import { createMarketRouter } from "./market.js";
import { createResearchRouter } from "./research.js";
import { createThemesRouter } from "./themes.js";
import { createAgentsRouter } from "./agents.js";
import { createModeRouter } from "./mode.js";

/**
 * Create the full API router with all domain routes mounted.
 *
 * Route order matters: more specific paths (e.g. /trades/analytics)
 * must be registered before parameterized ones (e.g. /trades/:id).
 * Each domain router preserves its own internal ordering.
 */
export function createApiRouter(state: AppState): Router {
  const router = Router();

  router.use(createHealthRouter(state));
  router.use(createDecisionsRouter(state));
  router.use(createTradesRouter(state));
  router.use(createPortfolioRouter(state));
  router.use(createMarketRouter(state));
  router.use(createResearchRouter(state));
  router.use(createThemesRouter(state));
  router.use(createAgentsRouter(state));
  router.use(createModeRouter(state));
  router.use(createAdminRouter(state));

  return router;
}
