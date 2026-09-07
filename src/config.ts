/**
 * config.ts — Environment variable loading and validation with Zod.
 * All configuration is validated at startup — invalid config crashes early.
 */

import { z } from "zod";

const ConfigSchema = z.object({
  port: z.number().int().positive().default(3000),
  tradeMode: z.enum(["sim", "live"]).default("sim"),

  // Alpaca (stocks)
  alpacaKeyId: z.string().default(""),
  alpacaSecretKey: z.string().default(""),
  alpacaPaper: z.boolean().default(true),

  // CCXT (crypto)
  ccxtExchange: z.string().default("binance"),
  ccxtApiKey: z.string().default(""),
  ccxtApiSecret: z.string().default(""),

  // Database
  databasePath: z.string().default("./data/doomtrade.db"),

  // Risk limits
  maxOpenPositions: z.number().int().positive().default(10),
  maxPositionSizePct: z.number().positive().max(100).default(20),
  dailyTradeLimit: z.number().int().positive().default(20),
  maxDrawdownPct: z.number().positive().max(100).default(15),

  // Sim settings
  simStartingBalance: z.number().positive().default(100_000),
  simFeePct: z.number().nonnegative().default(0.1),

  // API security
  apiKey: z.string().default(""),
});

export type Config = z.infer<typeof ConfigSchema>;

/**
 * Load and validate configuration from environment variables.
 * Throws on invalid config — fail fast at startup.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  return ConfigSchema.parse({
    port: env.PORT ? parseInt(env.PORT, 10) : undefined,
    tradeMode: env.TRADE_MODE,
    alpacaKeyId: env.ALPACA_API_KEY_ID,
    alpacaSecretKey: env.ALPACA_API_SECRET_KEY,
    alpacaPaper: env.ALPACA_PAPER !== "false",
    ccxtExchange: env.CCXT_EXCHANGE,
    ccxtApiKey: env.CCXT_API_KEY,
    ccxtApiSecret: env.CCXT_API_SECRET,
    databasePath: env.DATABASE_PATH,
    maxOpenPositions: env.MAX_OPEN_POSITIONS ? parseInt(env.MAX_OPEN_POSITIONS, 10) : undefined,
    maxPositionSizePct: env.MAX_POSITION_SIZE_PCT ? parseFloat(env.MAX_POSITION_SIZE_PCT) : undefined,
    dailyTradeLimit: env.DAILY_TRADE_LIMIT ? parseInt(env.DAILY_TRADE_LIMIT, 10) : undefined,
    maxDrawdownPct: env.MAX_DRAWDOWN_PCT ? parseFloat(env.MAX_DRAWDOWN_PCT) : undefined,
    simStartingBalance: env.SIM_STARTING_BALANCE ? parseFloat(env.SIM_STARTING_BALANCE) : undefined,
    simFeePct: env.SIM_FEE_PCT ? parseFloat(env.SIM_FEE_PCT) : undefined,
    apiKey: env.DOOMTRADE_API_KEY,
  });
}

export type TradeMode = "sim" | "live";