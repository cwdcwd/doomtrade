import type { Migration } from "./types.js";

const migration: Migration = {
  version: 6,
  name: "sim_sub_orders_realized_pnl",
  // For Postgres: conditional add. For SQLite: the column may already exist
  // in the CREATE TABLE (migration 5), so we catch the duplicate error.
  // The migration runner records the version regardless after success.
  postgresSql: `
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'sim_sub_orders' AND column_name = 'realized_pnl'
        ) THEN
          ALTER TABLE sim_sub_orders ADD COLUMN realized_pnl REAL NOT NULL DEFAULT 0;
        END IF;
      END $$;
    `,
  sqliteSql: `
      ALTER TABLE sim_sub_orders ADD COLUMN realized_pnl REAL NOT NULL DEFAULT 0;
    `,
};

export default migration;
