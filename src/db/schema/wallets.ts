import { pgTable, text, serial, real, timestamp } from "drizzle-orm/pg-core";

// Only the price snapshot table is needed for the standalone harvester's
// arb scanner. Wallet/airdrop-claim tables were dropped — they belonged to
// Shadow Engine's full opportunity-feed system, not the harvester.

export const priceSnapshotsTable = pgTable("price_snapshots", {
  id: serial("id").primaryKey(),
  tokenSymbol: text("token_symbol").notNull(),
  chainA: text("chain_a").notNull(),
  chainB: text("chain_b").notNull(),
  priceA: real("price_a").notNull(),
  priceB: real("price_b").notNull(),
  spreadPct: real("spread_pct").notNull(),
  spreadUsd: real("spread_usd"),
  poolAddressA: text("pool_address_a"),
  poolAddressB: text("pool_address_b"),
  capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
});

export type PriceSnapshot = typeof priceSnapshotsTable.$inferSelect;
