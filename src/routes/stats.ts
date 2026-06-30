import { Router } from "express";
import { db, defiVaultsTable, defiHarvestHistoryTable } from "../db/index.js";
import { priceSnapshotsTable } from "../db/schema/wallets.js";
import { desc, gte, sql } from "drizzle-orm";
import { getLastSwap } from "../lib/autoSwap.js";

const router = Router();

// GET /api/stats — unified P&L + compound pipeline overview
router.get("/stats", async (_req, res) => {
  try {
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

    // Harvest totals
    const vaults = await db.select().from(defiVaultsTable);
    const history = await db.select().from(defiHarvestHistoryTable);
    const recent  = history.filter(h => h.harvestedAt >= since24h);

    const totalEarned = history.reduce((s, h) => s + parseFloat(h.actualEarnedUsd ?? "0"), 0);
    const earned24h   = recent.reduce((s, h)  => s + parseFloat(h.actualEarnedUsd ?? "0"), 0);
    const totalGas    = history.reduce((s, h) => s + parseFloat(h.gasUsd ?? "0"), 0);
    const netPnl      = totalEarned - totalGas;
    const winRate     = history.length > 0
      ? (history.filter(h => parseFloat(h.actualEarnedUsd ?? "0") > 0).length / history.length) * 100
      : 0;

    // Best vault
    const bestVault = vaults
      .filter(v => v.runCount > 0)
      .sort((a, b) => parseFloat(b.totalActualEarnedUsd ?? "0") - parseFloat(a.totalActualEarnedUsd ?? "0"))[0];

    // Arb opportunities (last 30 min, spread > 0.5%)
    const since30m = new Date(Date.now() - 30 * 60 * 1000);
    const arbSnaps = await db
      .select()
      .from(priceSnapshotsTable)
      .where(gte(priceSnapshotsTable.capturedAt, since30m))
      .orderBy(desc(priceSnapshotsTable.spreadPct))
      .limit(5);

    const topArb = arbSnaps.filter(s => (s.spreadPct ?? 0) >= 0.5);

    res.json({
      harvester: {
        totalHarvests:    history.length,
        totalEarnedUsd:   totalEarned,
        totalGasUsd:      totalGas,
        netPnlUsd:        netPnl,
        earned24hUsd:     earned24h,
        winRatePct:       Math.round(winRate * 10) / 10,
        activeVaults:     vaults.filter(v => v.enabled).length,
        totalVaults:      vaults.length,
        bestVault:        bestVault ? { name: bestVault.name, earned: parseFloat(bestVault.totalActualEarnedUsd ?? "0") } : null,
      },
      swap: {
        enabled:    process.env["AUTO_SWAP_ENABLED"] === "true",
        minUsd:     parseFloat(process.env["AUTO_SWAP_MIN_USD"] ?? "0.50"),
        lastResult: getLastSwap(),
      },
      arb: {
        activeOpportunities: topArb.length,
        topSpreadPct:        topArb[0]?.spreadPct ?? 0,
        topOpportunity:      topArb[0] ?? null,
      },
      generatedAt: new Date().toISOString(),
    });

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// GET /api/stats/pnl-history — daily P&L for charting
router.get("/stats/pnl-history", async (req, res) => {
  try {
    const days = Math.min(parseInt(String(req.query["days"] ?? "30"), 10), 90);
    const since = new Date(Date.now() - days * 86_400_000);

    const rows = await db
      .select({
        day:          sql<string>`to_char(harvested_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')`,
        earnedUsd:    sql<number>`COALESCE(SUM(actual_earned_usd::numeric), 0)::float`,
        gasUsd:       sql<number>`COALESCE(SUM(gas_usd::numeric), 0)::float`,
        harvestCount: sql<number>`COUNT(*)::int`,
      })
      .from(defiHarvestHistoryTable)
      .where(gte(defiHarvestHistoryTable.harvestedAt, since))
      .groupBy(sql`to_char(harvested_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')`)
      .orderBy(sql`to_char(harvested_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')`);

    // Fill zero days
    const byDay = new Map(rows.map(r => [r.day, r]));
    const filled = [];
    for (let i = days - 1; i >= 0; i--) {
      const key = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
      filled.push(byDay.get(key) ?? { day: key, earnedUsd: 0, gasUsd: 0, harvestCount: 0 });
    }

    res.json(filled);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch P&L history" });
  }
});

export default router;
