import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { apiKeyAuth } from "../src/api/auth.js";

function makeApp(key: string) {
  const app = express();
  app.use(express.json());
  const auth = apiKeyAuth(key);
  app.use("/api", (req, res, next) => {
    if (req.path === "/health") return next();
    auth(req, res, next);
  });
  app.get("/api/health", (_req, res) => res.json({ status: "ok" }));
  app.get("/api/portfolio", (_req, res) => res.json({ equity: 100000 }));
  app.post("/api/trade", (_req, res) => res.json({ filled: true }));
  return app;
}

describe("API Key Auth", () => {
  describe("when API key is not set (local dev)", () => {
    const app = makeApp("");

    it("allows all requests without auth header", async () => {
      const res = await request(app).get("/api/portfolio");
      expect(res.status).toBe(200);
    });

    it("allows trade execution without auth", async () => {
      const res = await request(app).post("/api/trade").send({});
      expect(res.status).toBe(200);
    });
  });

  describe("when API key is set", () => {
    const KEY = "secret-test-key-123";
    const app = makeApp(KEY);

    it("rejects requests without auth header (401)", async () => {
      const res = await request(app).get("/api/portfolio");
      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Unauthorized");
    });

    it("rejects requests with wrong key (401)", async () => {
      const res = await request(app)
        .get("/api/portfolio")
        .set("Authorization", "Bearer wrong-key");
      expect(res.status).toBe(401);
    });

    it("accepts Bearer token auth", async () => {
      const res = await request(app)
        .get("/api/portfolio")
        .set("Authorization", `Bearer ${KEY}`);
      expect(res.status).toBe(200);
      expect(res.body.equity).toBe(100000);
    });

    it("accepts X-API-Key header auth", async () => {
      const res = await request(app)
        .get("/api/portfolio")
        .set("X-API-Key", KEY);
      expect(res.status).toBe(200);
    });

    it("allows /api/health without auth (Railway healthcheck)", async () => {
      const res = await request(app).get("/api/health");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("ok");
    });

    it("rejects trade execution without auth (401)", async () => {
      const res = await request(app).post("/api/trade").send({});
      expect(res.status).toBe(401);
    });

    it("accepts trade execution with correct key", async () => {
      const res = await request(app)
        .post("/api/trade")
        .set("Authorization", `Bearer ${KEY}`)
        .send({});
      expect(res.status).toBe(200);
      expect(res.body.filled).toBe(true);
    });

    it("rejects malformed Authorization header", async () => {
      const res = await request(app)
        .get("/api/portfolio")
        .set("Authorization", "Token abc");
      expect(res.status).toBe(401);
    });
  });
});