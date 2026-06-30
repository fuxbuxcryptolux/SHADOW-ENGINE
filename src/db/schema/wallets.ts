import {
  pgTable,
  text,
  serial,
  boolean,
  real,
  timestamp,
  integer,
  jsonb,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const walletsTable = pgTable("wallets", {
  id: serial("id").primaryKey(),
  label: text("label").notNull(),
  address: text("address").notNull().unique(),
  chain: text("chain").notNull(), // 'ethereum' | 'base' | 'arbitrum'
  encryptedKey: text("encrypted_key").notNull(),
  active: boolean("active").notNull().default(true),
  nativeBalanceEth: real("native_balance_eth"),
  balanceCheckedAt: timestamp("balance_checked_at", { withTimezone: true }),
  totalClaimedUsd: real("total_claimed_usd").notNull().default(0),
  claimCount: integer("claim_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const airdropClaimsTable = pgTable("airdrop_claims", {
  id: serial("id").primaryKey(),
  opportunityId: integer("opportunity_id"),           // nullable — proof_ready rows may not link to feed item
  distributorId: integer("distributor_id"),           // FK to airdrop_distributors
  walletId: integer("wallet_id").notNull(),
  walletAddress: text("wallet_address").notNull(),
  chain: text("chain").notNull(),
  contractAddress: text("contract_address"),
  txHash: text("tx_hash"),
  status: text("status").notNull().default("pending"), // pending | proof_ready | success | failed | skipped
  // Merkle proof data — stored so scheduler can execute without re-fetching
  merkleIndex: integer("merkle_index"),
  merkleAmount: text("merkle_amount"),                // wei as decimal string
  merkleProof: jsonb("merkle_proof").$type<string[]>(),
  amountTokens: real("amount_tokens"),
  amountUsd: real("amount_usd"),
  errorMessage: text("error_message"),
  attemptedAt: timestamp("attempted_at", { withTimezone: true }).notNull().defaultNow(),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
});

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

export const insertWalletSchema = createInsertSchema(walletsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertAirdropClaimSchema = createInsertSchema(airdropClaimsTable).omit({
  id: true,
});
export const insertPriceSnapshotSchema = createInsertSchema(priceSnapshotsTable).omit({
  id: true,
});

export type Wallet = typeof walletsTable.$inferSelect;
export type InsertWallet = z.infer<typeof insertWalletSchema>;
export type AirdropClaim = typeof airdropClaimsTable.$inferSelect;
export type InsertAirdropClaim = z.infer<typeof insertAirdropClaimSchema>;
export type PriceSnapshot = typeof priceSnapshotsTable.$inferSelect;
