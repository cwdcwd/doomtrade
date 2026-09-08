/**
 * Ordered list of database migrations.
 *
 * Each migration is applied in version order. Already-applied migrations
 * are skipped (tracked in the `_migrations` table).
 */
import type { Migration } from "./types.js";

import migration001 from "./001_initial_schema.js";
import migration002 from "./002_trades_table.js";
import migration003 from "./003_sim_tables.js";
import migration004 from "./004_portfolio_history.js";
import migration005 from "./005_themes.js";
import migration006 from "./006_sim_sub_orders_realized_pnl.js";
import migration007 from "./007_agent_tables.js";
import migration008 from "./008_decisions_agent_any_name.js";

export { type Migration } from "./types.js";

export const migrations: Migration[] = [
  migration001,
  migration002,
  migration003,
  migration004,
  migration005,
  migration006,
  migration007,
  migration008,
];
