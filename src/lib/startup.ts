/**
 * startup.ts — one-time DB cleanup on server start
 *
 * Clears corrupted zero-calibration values left by the buggy
 * pre-block-pinning measurement. Safe to run on every restart.
 */

import { db } from "../db/index.js";
import { defiVaultsTable } from "../db/schema/defi.js";
import { eq, sql } from "drizzle-orm";
import { logger } from "./logger.js";

export async function runStartupReset(): Promise<void> {
  try {
    // Clear the '0.000000000' sentinel that the old measurement bug wrote
    const result = await db
      .update(defiVaultsTable)
      .set({ rewardCalibration: null })
      .where(sql`reward_calibration = '0.0000000000'`);
    logger.info("Startup calibration reset complete");
  } catch (err) {
    logger.warn({ err }, "Startup reset failed (non-fatal)");
  }
}
