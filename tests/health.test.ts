import { describe, it, expect } from "vitest";
import express from "express";
import supertest from "supertest";

// Create a minimal app for testing the health endpoint
function createApp() {
  const app = express();
  app.use(express.json());
  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      mode: "sim",
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    });
  });
  return app;
}

describe("health endpoint", () => {
  it("returns 200 with status ok", async () => {
    const app = createApp();
    const resp = await supertest(app).get("/health");
    expect(resp.status).toBe(200);
    expect(resp.body.status).toBe("ok");
  });

  it("includes mode field", async () => {
    const app = createApp();
    const resp = await supertest(app).get("/health");
    expect(resp.body.mode).toBe("sim");
  });

  it("includes timestamp", async () => {
    const app = createApp();
    const resp = await supertest(app).get("/health");
    expect(resp.body.timestamp).toBeTruthy();
    expect(new Date(resp.body.timestamp).toString()).not.toBe("Invalid Date");
  });

  it("includes uptime", async () => {
    const app = createApp();
    const resp = await supertest(app).get("/health");
    expect(typeof resp.body.uptime).toBe("number");
    expect(resp.body.uptime).toBeGreaterThanOrEqual(0);
  });
});