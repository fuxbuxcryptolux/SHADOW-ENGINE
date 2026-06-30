/**
 * scheduler.ts — lean background job runner
 *
 * Jobs:
 *   harvest  — every 5 min  — check all enabled vaults, fire if profitable
 *   arb      — every 6 hrs  — scan price spreads across chains
 *   swap     — after each profitable harvest (event-driven, not interval)
 */

import { runHarvester } from "./harvester.js";
import { runArbScan } from "./arbScanner.js";
import { logger } from "./logger.js";

const HARVEST_INTERVAL_MS = 5  * 60 * 1000;  // 5 minutes
const ARB_INTERVAL_MS     = 6  * 60 * 60 * 1000; // 6 hours

const timers: NodeJS.Timeout[] = [];

async function safeRun(name: string, fn: () => Promise<unknown>): Promise<void> {
  const t0 = Date.now();
  try {
    const result = await fn();
    logger.info({ job: name, durationMs: Date.now() - t0, result }, "Job completed");
  } catch (err) {
    logger.warn({ job: name, err }, "Job failed");
  }
}

export function startScheduler(): void {
  // Only start if wallet is configured
  if (!process.env["HARVESTER_PRIVATE_KEY"]) {
    logger.warn("HARVESTER_PRIVATE_KEY not set — harvest scheduler disabled");
  } else {
    // Run once immediately on startup, then on interval
    void safeRun("harvest", runHarvester);
    timers.push(setInterval(() => void safeRun("harvest", runHarvester), HARVEST_INTERVAL_MS));
    logger.info({ intervalMs: HARVEST_INTERVAL_MS }, "Harvest scheduler started");
  }

  // Arb scanner runs regardless (read-only, no wallet needed)
  void safeRun("arb", runArbScan);
  timers.push(setInterval(() => void safeRun("arb", runArbScan), ARB_INTERVAL_MS));
  logger.info({ intervalMs: ARB_INTERVAL_MS }, "Arb scanner started");
}

export function stopScheduler(): void {
  timers.forEach(clearInterval);
  timers.length = 0;
}
