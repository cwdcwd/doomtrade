/**
 * Themes API routes.
 *
 * GET    /api/themes
 * POST   /api/themes
 * GET    /api/themes/:id
 * PATCH  /api/themes/:id
 * DELETE /api/themes/:id
 * POST   /api/themes/:id/evaluate
 * GET    /api/themes/:id/evaluations
 * GET    /api/themes/:id/performance
 */

import { Router, type Request, type Response } from "express";
import {
  type AppState,
  type ThemeSchedule,
  CreateThemeBodySchema,
  UpdateThemeBodySchema,
  ListThemesQuerySchema,
  errorMessage,
} from "./types.js";

export function createThemesRouter(state: AppState): Router {
  const router = Router();

  router.get("/themes", async (req: Request, res: Response) => {
    if (!state.themeRunner) {
      res.status(503).json({ error: "Theme runner not available" });
      return;
    }
    const parsed = ListThemesQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation failed", details: parsed.error.issues });
      return;
    }

    const { ThemeStore } = await import("../../themes/theme-store.js");
    const store = new ThemeStore(state.db);
    const themes = await store.list({
      strategy: parsed.data.strategy,
      enabled: parsed.data.enabled !== undefined ? parsed.data.enabled === "true" : undefined,
    });
    res.json({ mode: state.currentMode, themes, count: themes.length });
  });

  router.post("/themes", async (req: Request, res: Response) => {
    if (!state.themeRunner) {
      res.status(503).json({ error: "Theme runner not available" });
      return;
    }
    const parsed = CreateThemeBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation failed", details: parsed.error.issues });
      return;
    }

    const { ThemeStore } = await import("../../themes/theme-store.js");
    const store = new ThemeStore(state.db);
    try {
      const input = {
        ...parsed.data,
        schedule: parsed.data.schedule as ThemeSchedule,
      };
      const theme = await store.create(input);
      if (theme.enabled && theme.schedule.type !== "manual") {
        await state.themeRunner.start(theme.id);
      }
      res.status(201).json({ mode: state.currentMode, theme });
    } catch (err) {
      res.status(500).json({ error: "Failed to create theme", message: errorMessage(err) });
    }
  });

  router.get("/themes/:id", async (req: Request, res: Response) => {
    if (!state.themeRunner) {
      res.status(503).json({ error: "Theme runner not available" });
      return;
    }
    const { ThemeStore } = await import("../../themes/theme-store.js");
    const store = new ThemeStore(state.db);
    const theme = await store.getById(String(req.params.id));
    if (!theme) {
      res.status(404).json({ error: "Theme not found", id: req.params.id });
      return;
    }
    res.json({ mode: state.currentMode, theme });
  });

  router.patch("/themes/:id", async (req: Request, res: Response) => {
    if (!state.themeRunner) {
      res.status(503).json({ error: "Theme runner not available" });
      return;
    }
    const parsed = UpdateThemeBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation failed", details: parsed.error.issues });
      return;
    }

    const { ThemeStore } = await import("../../themes/theme-store.js");
    const store = new ThemeStore(state.db);
    const theme = await store.update(String(req.params.id), {
      ...parsed.data,
      schedule: parsed.data.schedule as any,
    });
    if (!theme) {
      res.status(404).json({ error: "Theme not found", id: req.params.id });
      return;
    }
    res.json({ mode: state.currentMode, theme });
  });

  router.delete("/themes/:id", async (req: Request, res: Response) => {
    if (!state.themeRunner) {
      res.status(503).json({ error: "Theme runner not available" });
      return;
    }
    const id = String(req.params.id);
    await state.themeRunner.stop(id);

    const { ThemeStore } = await import("../../themes/theme-store.js");
    const store = new ThemeStore(state.db);
    const deleted = await store.delete(id);
    if (!deleted) {
      res.status(404).json({ error: "Theme not found", id });
      return;
    }
    res.json({ mode: state.currentMode, deleted: true, id });
  });

  router.post("/themes/:id/evaluate", async (req: Request, res: Response) => {
    if (!state.themeRunner) {
      res.status(503).json({ error: "Theme runner not available" });
      return;
    }
    try {
      const result = await state.themeRunner.evaluateOnce(String(req.params.id));
      res.json({ mode: state.currentMode, result });
    } catch (err) {
      const status = errorMessage(err).includes("not found") ? 404 : 500;
      res.status(status).json({ error: errorMessage(err) });
    }
  });

  router.get("/themes/:id/evaluations", async (req: Request, res: Response) => {
    if (!state.themeRunner) {
      res.status(503).json({ error: "Theme runner not available" });
      return;
    }
    const { ThemeStore } = await import("../../themes/theme-store.js");
    const store = new ThemeStore(state.db);
    const limit = parseInt(String(req.query.limit ?? "50"), 10);
    const evaluations = await store.listEvaluations(String(req.params.id), limit);
    res.json({ mode: state.currentMode, evaluations, count: evaluations.length });
  });

  router.get("/themes/:id/performance", async (req: Request, res: Response) => {
    if (!state.themeRunner) {
      res.status(503).json({ error: "Theme runner not available" });
      return;
    }
    try {
      const performance = await state.themeRunner.getPerformance(String(req.params.id));
      res.json({ mode: state.currentMode, performance });
    } catch (err) {
      const status = errorMessage(err).includes("not found") ? 404 : 500;
      res.status(status).json({ error: errorMessage(err) });
    }
  });

  return router;
}
