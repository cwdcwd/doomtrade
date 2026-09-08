import type { Migration } from "./types.js";

const migration: Migration = {
  version: 8,
  name: "decisions_agent_any_name",
  // Drop the CHECK(agent IN ('doom', 'kangbot')) constraint from decisions
  // to allow any agent name (per-agent trading architecture).
  // SQLite cannot ALTER TABLE DROP CONSTRAINT, so we recreate the table.
  // Postgres drops the constraint by name.
  postgresSql: `
      DO $$
      BEGIN
        -- Drop the check constraint if it exists
        IF EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE table_name = 'decisions' AND constraint_type = 'CHECK'
            AND constraint_name = 'decisions_agent_check'
        ) THEN
          ALTER TABLE decisions DROP CONSTRAINT decisions_agent_check;
        END IF;
        -- Also try the auto-generated name pattern
        IF EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE table_name = 'decisions' AND constraint_type = 'CHECK'
            AND constraint_name = 'decisions_agent_check1'
        ) THEN
          ALTER TABLE decisions DROP CONSTRAINT decisions_agent_check1;
        END IF;
      END $$;
    `,
  sqliteSql: `
      -- SQLite: recreate the table without the agent CHECK constraint.
      -- Only do this if the constraint still exists.
      CREATE TABLE IF NOT EXISTS decisions_new (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        agent TEXT NOT NULL,
        symbol TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('buy', 'sell', 'hold')),
        quantity REAL NOT NULL,
        price_at_decision REAL NOT NULL,
        rationale TEXT NOT NULL,
        confidence INTEGER NOT NULL CHECK (confidence >= 1 AND confidence <= 10),
        mode TEXT NOT NULL CHECK (mode IN ('sim', 'live')),
        market_context TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO decisions_new (id, timestamp, agent, symbol, action, quantity, price_at_decision, rationale, confidence, mode, market_context, created_at)
      SELECT id, timestamp, agent, symbol, action, quantity, price_at_decision, rationale, confidence, mode, market_context, created_at FROM decisions;
      DROP TABLE decisions;
      ALTER TABLE decisions_new RENAME TO decisions;
      CREATE INDEX IF NOT EXISTS idx_decisions_agent ON decisions(agent);
      CREATE INDEX IF NOT EXISTS idx_decisions_symbol ON decisions(symbol);
      CREATE INDEX IF NOT EXISTS idx_decisions_timestamp ON decisions(timestamp);
    `,
};

export default migration;
