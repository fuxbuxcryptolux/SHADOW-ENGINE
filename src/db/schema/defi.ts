import { pgTable, serial, text, boolean, timestamp, numeric, integer, index } from "drizzle-orm/pg-core";

// ── DeFi Harvest Vaults ───────────────────────────────────────────────────────
// Stores the registry of DeFi protocol vaults to monitor and auto-compound.
// The harvester reads pending bounty rewards from each vault's strategy contract,
// compares them against estimated gas cost, and fires harvest() when profitable.

export const defiVaultsTable = pgTable("defi_vaults", {
  id:               serial("id").primaryKey(),
  name:             text("name").notNull(),
  protocol:         text("protocol").notNull().default("beefy"),      // beefy | yearn | custom
  chain:            text("chain").notNull().default("base"),           // base | arbitrum | ethereum
  vaultAddress:     text("vault_address").notNull(),                   // ERC-4626 vault or main contract
  strategyAddress:  text("strategy_address"),                          // resolved at runtime if null
  wantToken:        text("want_token"),                                // e.g. "USDC", "ETH"
  enabled:          boolean("enabled").notNull().default(true),
  minProfitUsd:     numeric("min_profit_usd", { precision: 10, scale: 4 }).default("0.10"),
  // Execution stats
  lastHarvestedAt:      timestamp("last_harvested_at"),
  lastTxHash:           text("last_tx_hash"),
  totalBountyEarnedUsd: numeric("total_bounty_earned_usd", { precision: 14, scale: 6 }).default("0"),
  runCount:             integer("run_count").notNull().default(0),
  errorCount:           integer("error_count").notNull().default(0),
  lastError:            text("last_error"),
  lastBountyUsd:        numeric("last_bounty_usd", { precision: 10, scale: 6 }),
  lastGasUsd:           numeric("last_gas_usd", { precision: 10, scale: 6 }),
  // Actual measured values — derived from WETH balance delta after each harvest tx.
  // rewardCalibration: ratio of (actual WETH received USD) / (callReward() USD estimate).
  //   Null until first real harvest. Used to gate future harvests on real-world profit.
  rewardCalibration:    numeric("reward_calibration", { precision: 14, scale: 10 }),
  lastActualProfitUsd:  numeric("last_actual_profit_usd", { precision: 10, scale: 6 }),
  totalActualEarnedUsd: numeric("total_actual_earned_usd", { precision: 14, scale: 6 }).default("0"),
  addedAt:              timestamp("added_at").defaultNow().notNull(),
});

export type DefiVault    = typeof defiVaultsTable.$inferSelect;
export type NewDefiVault = typeof defiVaultsTable.$inferInsert;

// ── DeFi Harvest History ──────────────────────────────────────────────────────
// One row per successful harvest tx. Used to build the P&L time-series chart.
// Kept separate from defi_vaults to preserve history even after vault edits/resets.

export const defiHarvestHistoryTable = pgTable("defi_harvest_history", {
  id:              serial("id").primaryKey(),
  vaultId:         integer("vault_id").notNull().references(() => defiVaultsTable.id, { onDelete: "cascade" }),
  vaultName:       text("vault_name").notNull(),
  chain:           text("chain").notNull(),
  txHash:          text("tx_hash").notNull(),
  actualEarnedUsd: numeric("actual_earned_usd", { precision: 14, scale: 6 }).notNull(),
  gasUsd:          numeric("gas_usd", { precision: 10, scale: 6 }).notNull(),
  harvestedAt:     timestamp("harvested_at").notNull().defaultNow(),
}, (t) => [
  index("defi_harvest_history_harvested_at_idx").on(t.harvestedAt),
]);

export type DefiHarvestHistory    = typeof defiHarvestHistoryTable.$inferSelect;
export type NewDefiHarvestHistory = typeof defiHarvestHistoryTable.$inferInsert;
