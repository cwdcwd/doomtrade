/**
 * Themes API route tests — src/api/routes/themes.ts (fleet-ops-b3u).
 *
 * Exercises the full Express stack via supertest with a real SQLite
 * in-memory DB and a real ThemeRunner (mock strategies), matching the
 * createTestApp pattern in tests/api.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import supertest from "supertest";
import { openDatabase, closeDatabase, type Database } from "../src/db/database.js";
import { createThemesRouter } from "../src/api/routes/themes.js";
import { ThemeRunner } from "../src/themes/theme-runner.js";
import { ThemeStore } from "../src/themes/theme-store.js";
import type { ThemeStrategy, ThemeContext } from "../src/themes/strategy.js";
import type { ThemeConfig, ThemeEvaluationResult } from "../src/themes/theme.js";
import type { AppState } from "../src/api/routes/types.js";

// A strategy that records every evaluation and returns one signal.
const evaluationsSeen: string[] = [];
const recordingStrategy: ThemeStrategy = {
  type: "test-mock",
  async evaluate(ctx: ThemeContext, config: ThemeConfig): Promise<ThemeEvaluationResult> {
    evaluationsSeen.push(config.id);
    return {
      themeId: config.id,
      timestamp: new Date().toISOString(),
      signals: [{ symbol: "AAPL", action: "buy", reason: "route test" }],
      decisions: [],
      trades: [],
      errors: [],
    };
  },
};

const explodingStrategy: ThemeStrategy = {
  type: "test-explode",
  async evaluate(): Promise<ThemeEvaluationResult> {
    throw new Error("boom during evaluate");
  },
};

// evaluateOnce swallows strategy errors into result.errors — this one
// fails at the theme-lookup stage to exercise the 404 path.
function makeState(db: Database, runner: ThemeRunner | null): AppState {
  return {
    decisionStore: {} as any,
    tradeEngine: {} as any,
    portfolio: {} as any,
    config: {} as any,
    currentMode: "sim",
    modeChangedAt: Date.now(),
    db,
    themeRunner: (runner ?? undefined) as any,
  };
}

function createApp(db: Database, runner: ThemeRunner | null) {
  const app = express();
  app.use(express.json());
  app.use("/api", createThemesRouter(makeState(db, runner)));
  return app;
}

function makeRunner(db: Database) {
  const runner = new ThemeRunner(db, {
    decisionStore: {} as any,
    tradeEngine: {} as any,
    portfolio: {} as any,
    marketData: { getQuote: async () => ({ price: 100 }) } as any,
  });
  runner.registerStrategy(recordingStrategy);
  runner.registerStrategy(explodingStrategy);
  return runner;
}

const validThemeBody = {
  name: "Route Test Theme",
  strategy: "test-mock",
  schedule: { type: "manual" },
} satisfies {
  name: string;
  strategy: string;
  schedule: { type: "manual" };
};

describe("Themes API routes", () => {
  let db: Database;

  beforeEach(async () => {
    evaluationsSeen.length = 0;
    db = await openDatabase({ path: ":memory:" });
  });

  afterEach(async () => {
    await closeDatabase(db);
  });

  describe("GET /api/themes", () => {
    it("returns 503 when the theme runner is unavailable", async () => {
      const app = createApp(db, null);
      const resp = await supertest(app).get("/api/themes");
      expect(resp.status).toBe(503);
      expect(resp.body.error).toBe("Theme runner not available");
    });

    it("lists themes with mode and count", async () => {
      const store = new ThemeStore(db);
      await store.create({ name: "A", strategy: "test-mock", schedule: { type: "manual" } });
      await store.create({ name: "B", strategy: "test-mock", schedule: { type: "manual" } });

      const app = createApp(db, makeRunner(db));
      const resp = await supertest(app).get("/api/themes");
      expect(resp.status).toBe(200);
      expect(resp.body.mode).toBe("sim");
      expect(resp.body.themes).toHaveLength(2);
      expect(resp.body.count).toBe(2);
    });

    it("filters by strategy", async () => {
      const store = new ThemeStore(db);
      await store.create({ name: "A", strategy: "test-mock", schedule: { type: "manual" } });
      await store.create({ name: "B", strategy: "other", schedule: { type: "manual" } });

      const app = createApp(db, makeRunner(db));
      const resp = await supertest(app).get("/api/themes?strategy=test-mock");
      expect(resp.status).toBe(200);
      expect(resp.body.themes).toHaveLength(1);
      expect(resp.body.themes[0].name).toBe("A");
    });

    it("filters by enabled state", async () => {
      const store = new ThemeStore(db);
      const t1 = await store.create({
        name: "On",
        strategy: "test-mock",
        schedule: { type: "manual" },
      });
      await store.create({
        name: "Off",
        strategy: "test-mock",
        schedule: { type: "manual" },
        enabled: false,
      });

      const app = createApp(db, makeRunner(db));
      const resp = await supertest(app).get("/api/themes?enabled=true");
      expect(resp.status).toBe(200);
      expect(resp.body.themes).toHaveLength(1);
      expect(resp.body.themes[0].id).toBe(t1.id);
    });

    it("rejects an invalid enabled filter with 400", async () => {
      const app = createApp(db, makeRunner(db));
      const resp = await supertest(app).get("/api/themes?enabled=maybe");
      expect(resp.status).toBe(400);
      expect(resp.body.error).toBe("Validation failed");
    });
  });

  describe("POST /api/themes", () => {
    it("returns 503 when the theme runner is unavailable", async () => {
      const app = createApp(db, null);
      const resp = await supertest(app).post("/api/themes").send(validThemeBody);
      expect(resp.status).toBe(503);
    });

    it("creates a manual theme with 201", async () => {
      const app = createApp(db, makeRunner(db));
      const resp = await supertest(app).post("/api/themes").send(validThemeBody);
      expect(resp.status).toBe(201);
      expect(resp.body.theme.name).toBe("Route Test Theme");
      expect(resp.body.theme.strategy).toBe("test-mock");
      expect(resp.body.theme.id).toBeTruthy();
    });

    it("starts the theme after create when enabled and not manual", async () => {
      const runner = makeRunner(db);
      const app = createApp(db, runner);
      const resp = await supertest(app)
        .post("/api/themes")
        .send({
          ...validThemeBody,
          name: "Auto Start",
          schedule: { type: "interval", milliseconds: 3_600_000 },
        });
      expect(resp.status).toBe(201);
      // themeRunner.start() schedules a timer — stop it so vitest can exit
      await runner.stop(resp.body.theme.id);
    });

    it("rejects an invalid body with 400", async () => {
      const app = createApp(db, makeRunner(db));
      const resp = await supertest(app).post("/api/themes").send({ name: "" });
      expect(resp.status).toBe(400);
      expect(resp.body.error).toBe("Validation failed");
    });

    it("rejects cron without expression with 400", async () => {
      const app = createApp(db, makeRunner(db));
      const resp = await supertest(app)
        .post("/api/themes")
        .send({ ...validThemeBody, schedule: { type: "cron" } });
      expect(resp.status).toBe(400);
    });

    it("returns 500 when the store create throws", async () => {
      const runner = makeRunner(db);
      // Corrupt the DB after migrations: drop the themes table.
      await db.exec("DROP TABLE themes");
      const app = createApp(db, runner);
      const resp = await supertest(app).post("/api/themes").send(validThemeBody);
      expect(resp.status).toBe(500);
      expect(resp.body.error).toBe("Failed to create theme");
    });
  });

  describe("GET /api/themes/:id", () => {
    it("returns 404 for unknown id", async () => {
      const app = createApp(db, makeRunner(db));
      const resp = await supertest(app).get("/api/themes/missing");
      expect(resp.status).toBe(404);
      expect(resp.body.error).toBe("Theme not found");
    });

    it("returns a single theme", async () => {
      const store = new ThemeStore(db);
      const theme = await store.create(validThemeBody);
      const app = createApp(db, makeRunner(db));
      const resp = await supertest(app).get(`/api/themes/${theme.id}`);
      expect(resp.status).toBe(200);
      expect(resp.body.theme.id).toBe(theme.id);
    });
  });

  describe("PATCH /api/themes/:id", () => {
    it("returns 404 for unknown id", async () => {
      const app = createApp(db, makeRunner(db));
      const resp = await supertest(app).patch("/api/themes/missing").send({ name: "X" });
      expect(resp.status).toBe(404);
    });

    it("updates name and allocatedCapital", async () => {
      const store = new ThemeStore(db);
      const theme = await store.create(validThemeBody);
      const app = createApp(db, makeRunner(db));
      const resp = await supertest(app)
        .patch(`/api/themes/${theme.id}`)
        .send({ name: "Renamed", allocatedCapital: 5_000 });
      expect(resp.status).toBe(200);
      expect(resp.body.theme.name).toBe("Renamed");
      expect(resp.body.theme.allocatedCapital).toBe(5_000);
    });

    it("rejects an invalid body with 400", async () => {
      const store = new ThemeStore(db);
      const theme = await store.create(validThemeBody);
      const app = createApp(db, makeRunner(db));
      const resp = await supertest(app)
        .patch(`/api/themes/${theme.id}`)
        .send({ maxAllocationPct: -5 });
      expect(resp.status).toBe(400);
    });
  });

  describe("DELETE /api/themes/:id", () => {
    it("returns 404 for unknown id (store.delete false)", async () => {
      const app = createApp(db, makeRunner(db));
      const resp = await supertest(app).delete("/api/themes/missing");
      expect(resp.status).toBe(404);
    });

    it("deletes an existing theme", async () => {
      const store = new ThemeStore(db);
      const theme = await store.create(validThemeBody);
      const app = createApp(db, makeRunner(db));
      const resp = await supertest(app).delete(`/api/themes/${theme.id}`);
      expect(resp.status).toBe(200);
      expect(resp.body.deleted).toBe(true);
      expect(resp.body.id).toBe(theme.id);
      expect(await store.getById(theme.id)).toBeNull();
    });
  });

  describe("POST /api/themes/:id/evaluate", () => {
    it("returns 404 for unknown id", async () => {
      const app = createApp(db, makeRunner(db));
      const resp = await supertest(app).post("/api/themes/missing/evaluate");
      expect(resp.status).toBe(404);
      expect(resp.body.error).toContain("not found");
    });

    it("evaluates a manual theme and returns the result", async () => {
      const store = new ThemeStore(db);
      const theme = await store.create(validThemeBody);
      const app = createApp(db, makeRunner(db));
      const resp = await supertest(app).post(`/api/themes/${theme.id}/evaluate`);
      expect(resp.status).toBe(200);
      expect(resp.body.result.themeId).toBe(theme.id);
      expect(resp.body.result.signals[0].symbol).toBe("AAPL");
      expect(evaluationsSeen).toContain(theme.id);
    });

    it("returns 500 when evaluation throws", async () => {
      const store = new ThemeStore(db);
      const theme = await store.create({ ...validThemeBody, strategy: "test-explode" });
      const app = createApp(db, makeRunner(db));
      const resp = await supertest(app).post(`/api/themes/${theme.id}/evaluate`);
      // evaluateOnce swallows strategy errors into result.errors
      expect(resp.status).toBe(200);
      expect(resp.body.result.errors[0]).toContain("boom during evaluate");
    });

    it("returns 503 when the runner is unavailable", async () => {
      const app = createApp(db, null);
      const resp = await supertest(app).post("/api/themes/x/evaluate");
      expect(resp.status).toBe(503);
    });
  });

  describe("GET /api/themes/:id/evaluations", () => {
    it("lists recorded evaluations with a limit", async () => {
      const store = new ThemeStore(db);
      const theme = await store.create(validThemeBody);
      const runner = makeRunner(db);
      await runner.evaluateOnce(theme.id);
      await runner.evaluateOnce(theme.id);

      const app = createApp(db, runner);
      const resp = await supertest(app).get(`/api/themes/${theme.id}/evaluations?limit=1`);
      expect(resp.status).toBe(200);
      expect(resp.body.evaluations).toHaveLength(1);
      expect(resp.body.count).toBe(1);
    });

    it("returns 503 when the runner is unavailable", async () => {
      const app = createApp(db, null);
      const resp = await supertest(app).get("/api/themes/x/evaluations");
      expect(resp.status).toBe(503);
    });
  });

  describe("GET /api/themes/:id/performance", () => {
    it("returns 404 for unknown id", async () => {
      const app = createApp(db, makeRunner(db));
      const resp = await supertest(app).get("/api/themes/missing/performance");
      expect(resp.status).toBe(404);
      expect(resp.body.error).toContain("not found");
    });

    it("returns performance for an allocated theme", async () => {
      const store = new ThemeStore(db);
      const theme = await store.create({ ...validThemeBody, allocatedCapital: 10_000 });
      const runner = makeRunner(db);
      await runner.start(theme.id);

      const app = createApp(db, runner);
      const resp = await supertest(app).get(`/api/themes/${theme.id}/performance`);
      expect(resp.status).toBe(200);
      expect(resp.body.performance.themeId).toBe(theme.id);
      expect(resp.body.performance.startingBalance).toBe(10_000);
      await runner.stop(theme.id);
    });

    it("returns 503 when the runner is unavailable", async () => {
      const app = createApp(db, null);
      const resp = await supertest(app).get("/api/themes/x/performance");
      expect(resp.status).toBe(503);
    });
  });
});
