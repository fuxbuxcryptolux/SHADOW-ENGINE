import { Router } from "express";
import { runArbScan, scanArbitrageOpportunities } from "../lib/arbScanner.js";
import { db } from "../db/index.js";
import { priceSnapshotsTable } from "../db/schema/wallets.js";
import { desc, gte } from "drizzle-orm";

const router = Router();

// GET /api/arb — latest snapshots from DB (last 24h, sorted by spread)
router.get("/arb", async (req, res) => {
  try {
    const hours = parseInt(String(req.query["hours"] ?? "24"), 10);
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);
    const snapshots = await db
      .select()
      .from(priceSnapshotsTable)
      .where(gte(priceSnapshotsTable.capturedAt, since))
      .orderBy(desc(priceSnapshotsTable.spreadPct))
      .limit(50);
    res.json({ snapshots, count: snapshots.length });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch arb data" });
  }
});

// POST /api/arb/scan — trigger a fresh scan
router.post("/arb/scan", async (_req, res) => {
  try {
    const results = await runArbScan();
    res.json({ results, count: results.length, scannedAt: new Date() });
  } catch (err) {
    res.status(500).json({ error: "Scan failed" });
  }
});

export default router;
