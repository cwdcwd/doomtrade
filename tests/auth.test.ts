/**
 * Auth policy tests — read-only public GETs, key-gated mutations.
 *
 * Policy (matches src/index.ts wiring):
 *   - GET /api/*            → public (dashboard browsers, no key)
 *   - POST/PATCH/DELETE     → requires API key (fleet crons, A2A)
 *   - /api/health           → always public (Railway healthcheck)
 *   - No DOOMTRADE_API_KEY  → auth disabled (local dev)
 */

import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { authGate } from "../src/api/auth.js";

/** Mounts the REAL production gate — the same middleware src/index.ts mounts. */
function makeApp(key: string) {
  const app = express();
  app.use(express.json());
  app.use("/api", authGate(key));
  app.get("/api/health", (_req, res) => res.json({ status: "ok" }));
  app.get("/api/dashboard", (_req, res) => res.json({ agents: [] }));
  app.get("/api/agents", (_req, res) => res.json({ agents: [] }));
  app.get("/api/agents/:id", (req, res) => res.json({ agent: { id: req.params.id } }));
  app.post("/api/agents", (_req, res) => res.status(201).json({ created: true }));
  app.patch("/api/agents/:id", (_req, res) => res.json({ updated: true }));
  app.delete("/api/agents/:id", (_req, res) => res.json({ deactivated: true }));
  app.post("/api/trade", (_req, res) => res.json({ filled: true }));
  app.post("/api/admin/reset", (_req, res) => res.json({ reset: true }));
  return app;
}

describe("API auth policy — public reads, keyed writes", () => {
  describe("when API key is set (production)", () => {
    const KEY = "secret-test-key-123";
    const app = makeApp(KEY);

    it("GET /api/health is public", async () => {
      const res = await request(app).get("/api/health");
      expect(res.status).toBe(200);
    });

    it("GET /api/dashboard is public (read-only dashboard, no key)", async () => {
      const res = await request(app).get("/api/dashboard");
      expect(res.status).toBe(200);
      expect(res.body.agents).toEqual([]);
    });

    it("GET /api/agents is public", async () => {
      const res = await request(app).get("/api/agents");
      expect(res.status).toBe(200);
    });

    it("POST /api/agents requires the key (401 without)", async () => {
      const res = await request(app).post("/api/agents").send({});
      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Unauthorized");
    });

    it("POST /api/agents accepts Bearer key", async () => {
      const res = await request(app)
        .post("/api/agents")
        .set("Authorization", `Bearer ${KEY}`)
        .send({});
      expect(res.status).toBe(201);
    });

    it("POST /api/agents accepts X-API-Key header", async () => {
      const res = await request(app)
        .post("/api/agents")
        .set("X-API-Key", KEY)
        .send({});
      expect(res.status).toBe(201);
    });

    it("PATCH /api/agents/:id requires the key", async () => {
      const res = await request(app).patch("/api/agents/abc").send({});
      expect(res.status).toBe(401);
    });

    it("DELETE /api/agents/:id requires the key", async () => {
      const res = await request(app).delete("/api/agents/abc");
      expect(res.status).toBe(401);
    });

    it("POST /api/trade requires the key", async () => {
      const res = await request(app).post("/api/trade").send({});
      expect(res.status).toBe(401);
    });

    it("POST /api/trade accepts Bearer key (fleet cron path)", async () => {
      const res = await request(app)
        .post("/api/trade")
        .set("Authorization", `Bearer ${KEY}`)
        .send({});
      expect(res.status).toBe(200);
      expect(res.body.filled).toBe(true);
    });

    it("POST /api/admin/reset requires the key", async () => {
      const res = await request(app).post("/api/admin/reset").send({});
      expect(res.status).toBe(401);
    });

    it("rejects wrong key on mutations", async () => {
      const res = await request(app)
        .post("/api/trade")
        .set("Authorization", "Bearer wrong-key")
        .send({});
      expect(res.status).toBe(401);
    });

    it("rejects malformed Authorization header on mutations", async () => {
      const res = await request(app)
        .post("/api/trade")
        .set("Authorization", "Token abc")
        .send({});
      expect(res.status).toBe(401);
    });

    it("same path: GET public, PATCH keyed — no method confusion bypass", async () => {
      // GET on the same path is public read (200)…
      const read = await request(app).get("/api/agents/abc");
      expect(read.status).toBe(200);
      // …but PATCH on the SAME path without a key is rejected (401)
      const mutate = await request(app).patch("/api/agents/abc").send({});
      expect(mutate.status).toBe(401);
      // and with the key it passes
      const keyed = await request(app)
        .patch("/api/agents/abc")
        .set("Authorization", `Bearer ${KEY}`)
        .send({});
      expect(keyed.status).toBe(200);
    });
  });

  describe("when API key is not set (local dev)", () => {
    const app = makeApp("");

    it("allows reads without auth header", async () => {
      const res = await request(app).get("/api/dashboard");
      expect(res.status).toBe(200);
    });

    it("allows trade execution without auth (local dev)", async () => {
      const res = await request(app).post("/api/trade").send({});
      expect(res.status).toBe(200);
      expect(res.body.filled).toBe(true);
    });
  });
});