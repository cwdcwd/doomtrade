/**
 * Decisions API routes.
 *
 * POST /api/decisions
 * GET  /api/decisions
 * GET  /api/decisions/:id
 */

import { Router, type Request, type Response } from "express";
import {
  type AppState,
  CreateDecisionBodySchema,
  ListDecisionsQuerySchema,
  errorMessage,
} from "./types.js";

export function createDecisionsRouter(state: AppState): Router {
  const router = Router();

  router.post("/decisions", async (req: Request, res: Response) => {
    const parsed = CreateDecisionBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation failed", details: parsed.error.issues });
      return;
    }

    try {
      const decision = await state.decisionStore.create(parsed.data);
      res.status(201).json({ mode: state.currentMode, decision });
    } catch (err) {
      res.status(500).json({ error: "Failed to create decision", message: errorMessage(err) });
    }
  });

  router.get("/decisions", async (req: Request, res: Response) => {
    const parsed = ListDecisionsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation failed", details: parsed.error.issues });
      return;
    }

    const decisions = await state.decisionStore.list(parsed.data);
    const total = await state.decisionStore.count(parsed.data);
    res.json({
      mode: state.currentMode,
      decisions,
      total,
      count: decisions.length,
    });
  });

  router.get("/decisions/:id", async (req: Request, res: Response) => {
    const decision = await state.decisionStore.getById(String(req.params.id));
    if (!decision) {
      res.status(404).json({ error: "Decision not found", id: req.params.id });
      return;
    }
    res.json({ mode: state.currentMode, decision });
  });

  return router;
}
