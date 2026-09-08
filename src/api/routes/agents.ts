/**
 * Agents API routes.
 *
 * POST   /api/agents
 * GET    /api/agents
 * GET    /api/agents/leaderboard
 * GET    /api/agents/:id
 * PATCH  /api/agents/:id
 * DELETE /api/agents/:id
 * GET    /api/agents/:id/portfolio
 * GET    /api/agents/:id/positions
 * GET    /api/agents/:id/trades
 * GET    /api/agents/:id/analytics
 * POST   /api/agents/:id/evaluate
 * POST   /api/agents/:id/trade
 * POST   /api/agents/u2a-cycle
 */

import { Router, type Request, type Response } from "express";
import {
  type AppState,
  CreateAgentBodySchema,
  UpdateAgentBodySchema,
  ListAgentTradesQuerySchema,
  errorMessage,
} from "./types.js";

export function createAgentsRouter(state: AppState): Router {
  const router = Router();

  router.post("/agents", async (req: Request, res: Response) => {
    if (!state.agentManager) {
      res.status(503).json({ error: "Agent manager not available" });
      return;
    }
    const parsed = CreateAgentBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation failed", details: parsed.error.issues });
      return;
    }
    try {
      const agent = await state.agentManager.register(parsed.data.name, {
        startingBalance: parsed.data.startingBalance,
        strategy: parsed.data.strategy,
      });
      res.status(201).json({ mode: state.currentMode, agent });
    } catch (err) {
      res.status(500).json({ error: "Failed to register agent", message: errorMessage(err) });
    }
  });

  router.get("/agents", async (_req: Request, res: Response) => {
    if (!state.agentManager) {
      res.status(503).json({ error: "Agent manager not available" });
      return;
    }
    try {
      const agents = await state.agentManager.list();
      res.json({ mode: state.currentMode, agents, count: agents.length });
    } catch (err) {
      res.status(500).json({ error: "Failed to list agents", message: errorMessage(err) });
    }
  });

  router.get("/agents/leaderboard", async (_req: Request, res: Response) => {
    if (!state.agentManager) {
      res.status(503).json({ error: "Agent manager not available" });
      return;
    }
    try {
      const leaderboard = await state.agentManager.leaderboard();
      res.json({ mode: state.currentMode, leaderboard, count: leaderboard.length });
    } catch (err) {
      res.status(500).json({ error: "Failed to get leaderboard", message: errorMessage(err) });
    }
  });

  router.get("/agents/:id", async (req: Request, res: Response) => {
    if (!state.agentManager) {
      res.status(503).json({ error: "Agent manager not available" });
      return;
    }
    const agent = await state.agentManager.getById(String(req.params.id));
    if (!agent) {
      res.status(404).json({ error: "Agent not found", id: req.params.id });
      return;
    }
    res.json({ mode: state.currentMode, agent });
  });

  router.patch("/agents/:id", async (req: Request, res: Response) => {
    if (!state.agentManager) {
      res.status(503).json({ error: "Agent manager not available" });
      return;
    }
    const parsed = UpdateAgentBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation failed", details: parsed.error.issues });
      return;
    }

    const agentId = String(req.params.id);
    const agent = await state.agentManager.getById(agentId);
    if (!agent) {
      res.status(404).json({ error: "Agent not found", id: agentId });
      return;
    }

    const { execRun, convertPlaceholders } = await import("../../db/database.js");
    const db = state.db;

    try {
      if (parsed.data.strategy !== undefined) {
        const sql = convertPlaceholders("UPDATE agents SET strategy = ? WHERE id = ?", db.backend);
        await execRun(db, sql, [parsed.data.strategy, agentId]);
      }
      if (parsed.data.active !== undefined) {
        const sql = convertPlaceholders("UPDATE agents SET active = ? WHERE id = ?", db.backend);
        await execRun(db, sql, [parsed.data.active ? 1 : 0, agentId]);
      }
      if (parsed.data.startingBalance !== undefined) {
        const sql = convertPlaceholders(
          "UPDATE agents SET starting_balance = ? WHERE id = ?",
          db.backend,
        );
        await execRun(db, sql, [parsed.data.startingBalance, agentId]);
      }

      const updated = await state.agentManager.getById(agentId);
      res.json({ mode: state.currentMode, agent: updated });
    } catch (err) {
      res.status(500).json({ error: "Failed to update agent", message: errorMessage(err) });
    }
  });

  router.delete("/agents/:id", async (req: Request, res: Response) => {
    if (!state.agentManager) {
      res.status(503).json({ error: "Agent manager not available" });
      return;
    }
    const agentId = String(req.params.id);
    const agent = await state.agentManager.getById(agentId);
    if (!agent) {
      res.status(404).json({ error: "Agent not found", id: agentId });
      return;
    }
    try {
      await state.agentManager.deactivate(agentId);
      res.json({ mode: state.currentMode, deactivated: true, id: agentId });
    } catch (err) {
      res.status(500).json({ error: "Failed to deactivate agent", message: errorMessage(err) });
    }
  });

  router.get("/agents/:id/portfolio", async (req: Request, res: Response) => {
    if (!state.agentTradeEngine) {
      res.status(503).json({ error: "Agent trade engine not available" });
      return;
    }
    const agentId = String(req.params.id);
    if (!state.agentManager) {
      res.status(503).json({ error: "Agent manager not available" });
      return;
    }
    const agent = await state.agentManager.getById(agentId);
    if (!agent) {
      res.status(404).json({ error: "Agent not found", id: agentId });
      return;
    }
    try {
      const portfolio = await state.agentTradeEngine.getPortfolio(agentId);
      res.json({ mode: state.currentMode, agentId, portfolio });
    } catch (err) {
      res.status(500).json({ error: "Failed to get portfolio", message: errorMessage(err) });
    }
  });

  router.get("/agents/:id/positions", async (req: Request, res: Response) => {
    if (!state.agentTradeEngine) {
      res.status(503).json({ error: "Agent trade engine not available" });
      return;
    }
    const agentId = String(req.params.id);
    if (!state.agentManager) {
      res.status(503).json({ error: "Agent manager not available" });
      return;
    }
    const agent = await state.agentManager.getById(agentId);
    if (!agent) {
      res.status(404).json({ error: "Agent not found", id: agentId });
      return;
    }
    try {
      const positions = await state.agentTradeEngine.getPositions(agentId);
      res.json({ mode: state.currentMode, agentId, positions, count: positions.length });
    } catch (err) {
      res.status(500).json({ error: "Failed to get positions", message: errorMessage(err) });
    }
  });

  router.get("/agents/:id/trades", async (req: Request, res: Response) => {
    if (!state.agentTradeEngine) {
      res.status(503).json({ error: "Agent trade engine not available" });
      return;
    }
    const parsed = ListAgentTradesQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation failed", details: parsed.error.issues });
      return;
    }
    const agentId = String(req.params.id);
    if (!state.agentManager) {
      res.status(503).json({ error: "Agent manager not available" });
      return;
    }
    const agent = await state.agentManager.getById(agentId);
    if (!agent) {
      res.status(404).json({ error: "Agent not found", id: agentId });
      return;
    }
    try {
      const trades = await state.agentTradeEngine.getTrades(
        agentId,
        parsed.data.limit,
        parsed.data.offset,
      );
      res.json({ mode: state.currentMode, agentId, trades, count: trades.length });
    } catch (err) {
      res.status(500).json({ error: "Failed to get trades", message: errorMessage(err) });
    }
  });

  router.get("/agents/:id/analytics", async (req: Request, res: Response) => {
    if (!state.agentTradeEngine) {
      res.status(503).json({ error: "Agent trade engine not available" });
      return;
    }
    const agentId = String(req.params.id);
    if (!state.agentManager) {
      res.status(503).json({ error: "Agent manager not available" });
      return;
    }
    const agent = await state.agentManager.getById(agentId);
    if (!agent) {
      res.status(404).json({ error: "Agent not found", id: agentId });
      return;
    }
    try {
      const analytics = await state.agentTradeEngine.getAnalytics(agentId);
      res.json({ mode: state.currentMode, agentId, analytics });
    } catch (err) {
      res.status(500).json({ error: "Failed to get analytics", message: errorMessage(err) });
    }
  });

  router.post("/agents/:id/evaluate", async (req: Request, res: Response) => {
    const agentId = String(req.params.id);

    if (!state.agentPipeline) {
      res.status(503).json({
        error: "Agent pipeline not available",
        message: "AgentTradingPipeline is not initialized on this server",
        agentId,
      });
      return;
    }

    if (!state.agentManager) {
      res.status(503).json({
        error: "Agent manager not available",
        message: "AgentManager is not initialized on this server",
        agentId,
      });
      return;
    }

    try {
      // Verify agent exists
      const agent = await state.agentManager.getById(agentId);
      if (!agent) {
        res.status(404).json({
          error: "Agent not found",
          agentId,
        });
        return;
      }

      if (!agent.active) {
        res.status(409).json({
          error: "Agent is not active",
          message: "Cannot evaluate a disabled agent",
          agentId,
        });
        return;
      }

      if (!agent.strategy) {
        res.status(409).json({
          error: "Agent has no strategy assigned",
          message: "Assign a strategy via PATCH /api/agents/:id before evaluating",
          agentId,
        });
        return;
      }

      const result = await state.agentPipeline.runAgentCycle(agentId, agent.name, agent.strategy);

      res.json({
        agentId: result.agentId,
        agentName: result.agentName,
        strategy: result.strategy,
        signals: result.signals,
        trades: result.trades,
        errors: result.errors,
        equityBefore: result.equityBefore,
        equityAfter: result.equityAfter,
        pnlChange: result.pnlChange,
      });
    } catch (err) {
      res.status(500).json({
        error: "Strategy evaluation failed",
        message: errorMessage(err),
        agentId,
      });
    }
  });

  // ── Direct trade execution on an agent's exchange ──────────────

  router.post("/agents/:id/trade", async (req: Request, res: Response) => {
    const agentId = String(req.params.id);

    if (!state.agentManager) {
      res.status(503).json({ error: "Agent manager not available" });
      return;
    }

    const agent = await state.agentManager.getById(agentId);
    if (!agent) {
      res.status(404).json({ error: "Agent not found", agentId });
      return;
    }

    const { symbol, side, quantity, orderType, limitPrice } = req.body as {
      symbol?: string;
      side?: string;
      quantity?: number;
      orderType?: string;
      limitPrice?: number;
    };

    if (!symbol || !side || !quantity || quantity <= 0) {
      res.status(400).json({ error: "Missing required fields: symbol, side, quantity" });
      return;
    }

    try {
      const exchange = state.agentManager.getExchange(agentId);
      const result = await exchange.placeOrder({
        symbol,
        side: side as "buy" | "sell",
        quantity,
        orderType: (orderType as "market" | "limit") ?? "market",
        limitPrice,
      });

      res.json({
        agentId,
        agentName: agent.name,
        status: result.status,
        fillPrice: result.fillPrice,
        fee: result.fee,
        realizedPnl: result.realizedPnl,
        error: result.error,
      });
    } catch (err) {
      res.status(500).json({ error: "Trade failed", message: errorMessage(err) });
    }
  });

  // ── A2A coordination: run a full multi-agent trading cycle ─────

  router.post("/agents/a2a-cycle", async (_req: Request, res: Response) => {
    if (!state.a2aCoordinator) {
      res.status(503).json({
        error: "A2A coordinator not available",
        message: "A2ATradingCoordinator is not initialized on this server",
      });
      return;
    }

    try {
      const result = await state.a2aCoordinator.runCycle();
      res.json(result);
    } catch (err) {
      res.status(500).json({
        error: "A2A cycle failed",
        message: errorMessage(err),
      });
    }
  });

  return router;
}
