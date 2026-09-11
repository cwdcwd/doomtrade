/**
 * Postgres adapter tests — src/db/postgres.ts (fleet-ops-b3u).
 *
 * CI has no Postgres server; the pg Pool is mocked at module level.
 * runMigrations is also mocked — migration SQL executes against real
 * SQLite elsewhere (database.test coverage exists for the SQL itself).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const queryMock = vi.fn();
const releaseMock = vi.fn();
const endMock = vi.fn();

vi.mock("pg", () => {
  const client = {
    query: (...args: unknown[]) => queryMock(...args),
    release: () => releaseMock(),
  };
  const Pool = vi.fn().mockImplementation(() => ({
    connect: async () => client,
    end: async () => endMock(),
  }));
  return { Pool };
});

// runMigrations runs the full migration chain — mock it to count calls.
const runMigrationsMock = vi.fn();
vi.mock("../src/db/database.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/db/database.js")>();
  return {
    ...actual,
    runMigrations: (...args: unknown[]) => runMigrationsMock(...args),
  };
});

const { openPostgresDatabase, closePostgresDatabase } = await import("../src/db/postgres.js");

describe("Postgres adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("opens a pool, connects, and runs migrations", async () => {
    queryMock.mockResolvedValue({ rows: [] });
    const db = await openPostgresDatabase({ url: "postgres://localhost/fleet" });
    expect(db.backend).toBe("postgres");
    expect(runMigrationsMock).toHaveBeenCalledWith(db);
    expect(runMigrationsMock).toHaveBeenCalledTimes(1);
  });

  it("run converts ? placeholders to $N", async () => {
    queryMock.mockResolvedValue({ rows: [] });
    const db = await openPostgresDatabase({ url: "postgres://x" });
    await db.run("INSERT INTO t (a) VALUES (?)", ["x"]);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain("VALUES ($1)");
    expect(params).toEqual(["x"]);
  });

  it("run replaces {now} with NOW()", async () => {
    queryMock.mockResolvedValue({ rows: [] });
    const db = await openPostgresDatabase({ url: "postgres://x" });
    await db.run("INSERT INTO t (ts) VALUES ({now})");
    expect(queryMock.mock.calls[0][0]).toContain("NOW()");
  });

  it("exec does not convert placeholders (DDL-style)", async () => {
    queryMock.mockResolvedValue({ rows: [] });
    const db = await openPostgresDatabase({ url: "postgres://x" });
    await db.exec("CREATE TABLE t (x INT)");
    expect(queryMock.mock.calls[0][0]).toBe("CREATE TABLE t (x INT)");
  });

  it("all returns rows and converts placeholders", async () => {
    queryMock.mockResolvedValue({ rows: [{ version: 1 }, { version: 2 }] });
    const db = await openPostgresDatabase({ url: "postgres://x" });
    const rows = await db.all("SELECT version FROM _migrations WHERE version > ?", [0]);
    expect(rows).toEqual([{ version: 1 }, { version: 2 }]);
    expect(queryMock.mock.calls[0][0]).toContain("version > $1");
  });

  it("get returns the first row or null", async () => {
    queryMock.mockResolvedValue({ rows: [{ version: 7 }] });
    const db = await openPostgresDatabase({ url: "postgres://x" });
    expect(await db.get("SELECT version FROM t WHERE id = ?", [7])).toEqual({ version: 7 });

    queryMock.mockResolvedValue({ rows: [] });
    expect(await db.get("SELECT version FROM t WHERE id = ?", [8])).toBeNull();
  });

  it("get returns null for an empty result set", async () => {
    const db = await openPostgresDatabase({ url: "postgres://x" });
    queryMock.mockResolvedValue({ rows: [] });
    expect(await db.get("SELECT version FROM t WHERE id = ?", [8])).toBeNull();
  });
});

describe("closePostgresDatabase", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  it("releases the client and ends the pool", async () => {
    queryMock.mockResolvedValue({ rows: [] });
    const db = await openPostgresDatabase({ url: "postgres://x" });
    await closePostgresDatabase(db);
    expect(releaseMock).toHaveBeenCalledTimes(1);
    expect(endMock).toHaveBeenCalledTimes(1);
  });

  it("no-ops on a non-postgres client", async () => {
    const sqlite = { backend: "sqlite", run: vi.fn(), exec: vi.fn(), all: vi.fn(), get: vi.fn() };
    await closePostgresDatabase(sqlite as any);
    expect(releaseMock).not.toHaveBeenCalled();
    expect(endMock).not.toHaveBeenCalled();
  });
});
