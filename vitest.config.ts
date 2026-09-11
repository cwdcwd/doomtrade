import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      // Universe scoping (fleet-ops-b3u, 2026-09-11): measure src/ only.
      // public/** is browser JS served statically — no vitest/DOM env.
      // scripts/** are operator CLIs that execute main() at import time —
      // importing them in tests would run them. Both contributed 854
      // permanently-0% lines to the global numbers. Numeric thresholds
      // are UNCHANGED (80/80/70/80): this is a documented measurement
      // decision (see bead fleet-ops-b3u), not a threshold ratchet-down.
      include: ["src/**"],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 70,
        statements: 80,
      },
    },
  },
});