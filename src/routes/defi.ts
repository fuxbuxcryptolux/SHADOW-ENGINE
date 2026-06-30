import { Router } from "express";
import { db } from "../db/index.js";
import { defiVaultsTable, defiHarvestHistoryTable } from "../db/schema/defi.js";
import { activityTable } from "../db/schema/activity.js";
import { appSettingsTable } from "../db/schema/appSettings.js";
import { eq, sql, gte } from "drizzle-orm";
import { runHarvester, discoverBeefyVaults, getHarvesterStatus, fetchCallRewards, subscribeToHarvestEvents } from "../lib/harvester.js";
import { logger } from "../lib/logger.js";
import dns from "node:dns/promises";
import { isIPv4 } from "node:net";

const router = Router();

// GET /defi/status — wallet info + last run results
router.get("/defi/status", async (req, res) => {
  const status = getHarvesterStatus();
  const vaults = await db.select().from(defiVaultsTable).orderBy(defiVaultsTable.addedAt);
  res.json({ ...status, vaults });
});

// GET /defi/vaults — list all vaults
router.get("/defi/vaults", async (req, res) => {
  const vaults = await db.select().from(defiVaultsTable).orderBy(defiVaultsTable.addedAt);
  res.json(vaults);
});

// GET /defi/vaults/rewards — live callReward() for all enabled vaults
router.get("/defi/vaults/rewards", async (req, res) => {
  try {
    const rewards = await fetchCallRewards();
    res.json(rewards);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    req.log.warn({ err: msg }, "fetchCallRewards failed");
    res.status(500).json({ error: msg });
  }
});

// POST /defi/vaults — add a vault
router.post("/defi/vaults", async (req, res) => {
  const { name, protocol, chain, vaultAddress, strategyAddress, wantToken, minProfitUsd } = req.body as {
    name?: string; protocol?: string; chain?: string;
    vaultAddress?: string; strategyAddress?: string;
    wantToken?: string; minProfitUsd?: string;
  };

  if (!name || !vaultAddress || !chain) {
    res.status(400).json({ error: "name, vaultAddress, and chain are required" });
    return;
  }

  const [vault] = await db.insert(defiVaultsTable).values({
    name,
    protocol:        protocol ?? "beefy",
    chain,
    vaultAddress:    vaultAddress.toLowerCase(),
    strategyAddress: strategyAddress?.toLowerCase() ?? null,
    wantToken:       wantToken ?? null,
    minProfitUsd:    minProfitUsd ?? "0.10",
  }).returning();

  res.json(vault);
});

// PUT /defi/vaults/:id — update vault (enable/disable, threshold)
router.put("/defi/vaults/:id", async (req, res) => {
  const id = parseInt(req.params["id"] ?? "0", 10);
  const { enabled, minProfitUsd, name, strategyAddress } = req.body as {
    enabled?: boolean; minProfitUsd?: string; name?: string; strategyAddress?: string;
  };

  const updates: Partial<typeof defiVaultsTable.$inferInsert> = {};
  if (enabled   !== undefined) updates.enabled       = enabled;
  if (minProfitUsd)            updates.minProfitUsd  = minProfitUsd;
  if (name)                    updates.name          = name;
  if (strategyAddress)         updates.strategyAddress = strategyAddress.toLowerCase();

  const [vault] = await db.update(defiVaultsTable).set(updates).where(eq(defiVaultsTable.id, id)).returning();
  if (!vault) { res.status(404).json({ error: "Vault not found" }); return; }
  res.json(vault);
});

// PATCH /defi/vaults/:id — partial update (minProfitUsd and/or enabled)
router.patch("/defi/vaults/:id", async (req, res) => {
  const id = parseInt(req.params["id"] ?? "0", 10);
  const { enabled, minProfitUsd } = req.body as { enabled?: boolean; minProfitUsd?: number };

  const updates: Partial<typeof defiVaultsTable.$inferInsert> = {};
  if (enabled      !== undefined) updates.enabled      = enabled;
  if (minProfitUsd !== undefined) updates.minProfitUsd = String(minProfitUsd);

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "Nothing to update" });
    return;
  }

  const [vault] = await db.update(defiVaultsTable).set(updates).where(eq(defiVaultsTable.id, id)).returning();
  if (!vault) { res.status(404).json({ error: "Vault not found" }); return; }
  req.log.info({ id, updates }, "Vault patched");
  res.json(vault);
});

// DELETE /defi/vaults/:id
router.delete("/defi/vaults/:id", async (req, res) => {
  const id = parseInt(req.params["id"] ?? "0", 10);
  await db.delete(defiVaultsTable).where(eq(defiVaultsTable.id, id));
  res.json({ ok: true });
});

// POST /defi/harvest — run full harvest cycle
router.post("/defi/harvest", async (req, res) => {
  req.log.info("Manual DeFi harvest triggered");
  try {
    const results = await runHarvester();
    res.json({ ok: true, results });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    req.log.warn({ err: msg }, "Harvester run failed");
    res.status(500).json({ ok: false, error: msg });
  }
});

// POST /defi/vaults/:id/harvest — harvest one vault
router.post("/defi/vaults/:id/harvest", async (req, res) => {
  const id = parseInt(req.params["id"] ?? "0", 10);
  const [vault] = await db.select().from(defiVaultsTable).where(eq(defiVaultsTable.id, id)).limit(1);
  if (!vault) { res.status(404).json({ error: "Vault not found" }); return; }

  // Temporarily enable to force run, then restore
  const wasEnabled = vault.enabled;
  if (!wasEnabled) {
    await db.update(defiVaultsTable).set({ enabled: true }).where(eq(defiVaultsTable.id, id));
  }
  try {
    const results = await runHarvester();
    const r = results.find(r => r.vaultId === id);
    res.json({ ok: true, result: r });
  } finally {
    if (!wasEnabled) {
      await db.update(defiVaultsTable).set({ enabled: wasEnabled }).where(eq(defiVaultsTable.id, id));
    }
  }
});

// GET /defi/pnl-history — daily P&L buckets for the last N days (default 30)
router.get("/defi/pnl-history", async (req, res) => {
  const days = Math.min(parseInt(String(req.query["days"] ?? "30"), 10) || 30, 90);
  const since = new Date(Date.now() - days * 86_400_000);

  const rows = await db
    .select({
      day:            sql<string>`to_char(harvested_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')`,
      earnedUsd:      sql<number>`COALESCE(SUM(actual_earned_usd::numeric), 0)::float`,
      harvestCount:   sql<number>`COUNT(*)::int`,
    })
    .from(defiHarvestHistoryTable)
    .where(gte(defiHarvestHistoryTable.harvestedAt, since))
    .groupBy(sql`to_char(harvested_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')`)
    .orderBy(sql`to_char(harvested_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')`);

  // Fill in zero-earning days so the chart always spans the full window
  const byDay = new Map(rows.map(r => [r.day, r]));
  const filled: Array<{ day: string; earnedUsd: number; harvestCount: number }> = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86_400_000);
    const key = d.toISOString().slice(0, 10);
    filled.push(byDay.get(key) ?? { day: key, earnedUsd: 0, harvestCount: 0 });
  }

  res.json(filled);
});

// GET /defi/audit — aggregated metrics for the live ticker
router.get("/defi/audit", async (_req, res) => {
  const result = await db.execute(sql`
    SELECT
      COALESCE(SUM(total_actual_earned_usd), 0)::float                                              AS "netPnl",
      COALESCE(SUM(CASE WHEN total_actual_earned_usd > 0 THEN total_actual_earned_usd END), 0)::float AS "grossInflows",
      ABS(COALESCE(SUM(CASE WHEN total_actual_earned_usd < 0 THEN total_actual_earned_usd END), 0))::float AS "gasSpent",
      COALESCE(SUM(run_count), 0)::int                                                               AS "totalHarvests",
      COUNT(CASE WHEN enabled THEN 1 END)::int                                                       AS "activeVaults",
      (
        SELECT name FROM defi_vaults
        WHERE run_count > 0
        ORDER BY total_actual_earned_usd::numeric DESC
        LIMIT 1
      )                                                                                              AS "bestVault",
      (SELECT MAX(last_harvested_at) FROM defi_vaults)::text                                         AS "lastHarvestAt",
      CASE WHEN COALESCE(SUM(run_count), 0) > 0
        THEN ROUND(
          100.0
          * COALESCE(SUM(CASE WHEN total_actual_earned_usd > 0 THEN run_count ELSE 0 END), 0)::numeric
          / SUM(run_count),
          1
        )::float
        ELSE 0
      END                                                                                            AS "winRate"
    FROM defi_vaults
  `);
  res.json(result[0]);
});

// requireInternalKey — simple guard for destructive reset operations.
// Callers must include the header x-shadow-internal: 1 to prove the request
// originates from the Shadow Engine frontend (not a stray browser navigation).
function requireInternalKey(req: import("express").Request, res: import("express").Response, next: import("express").NextFunction) {
  if (req.headers["x-shadow-internal"] !== "1") {
    res.status(403).json({ error: "Forbidden — internal key required" });
    return;
  }
  next();
}

// POST /defi/reset/calibrations — clear reward calibration factors for all vaults
router.post("/defi/reset/calibrations", requireInternalKey, async (req, res) => {
  const updated = await db.update(defiVaultsTable)
    .set({ rewardCalibration: null, lastActualProfitUsd: null })
    .returning({ id: defiVaultsTable.id });
  req.log.info({ affected: updated.length }, "Vault calibrations reset");
  res.json({ ok: true, affected: updated.length });
});

// POST /defi/reset/errors — zero error counts and clear last error message for all vaults
router.post("/defi/reset/errors", requireInternalKey, async (req, res) => {
  const updated = await db.update(defiVaultsTable)
    .set({ errorCount: 0, lastError: null })
    .returning({ id: defiVaultsTable.id });
  req.log.info({ affected: updated.length }, "Vault error logs cleared");
  res.json({ ok: true, affected: updated.length });
});

// POST /defi/reset/activity — wipe the harvest activity log
router.post("/defi/reset/activity", requireInternalKey, async (req, res) => {
  const deleted = await db.delete(activityTable).returning({ id: activityTable.id });
  req.log.info({ affected: deleted.length }, "Activity history wiped");
  res.json({ ok: true, affected: deleted.length });
});

// POST /defi/reset/runcounts — zero run counts and all earnings totals for all vaults
router.post("/defi/reset/runcounts", requireInternalKey, async (req, res) => {
  const updated = await db.update(defiVaultsTable)
    .set({ runCount: 0, totalBountyEarnedUsd: "0", totalActualEarnedUsd: "0" })
    .returning({ id: defiVaultsTable.id });
  req.log.info({ affected: updated.length }, "Vault run counts and earnings reset");
  res.json({ ok: true, affected: updated.length });
});

// GET /defi/notifications — recent profitable harvests for in-app toast notifications
// Returns vaults with a real tx hash and positive actual profit — deduplication by txHash on client.
router.get("/defi/notifications", async (_req, res) => {
  const vaults = await db
    .select({
      id:                defiVaultsTable.id,
      name:              defiVaultsTable.name,
      chain:             defiVaultsTable.chain,
      lastTxHash:        defiVaultsTable.lastTxHash,
      lastActualProfit:  defiVaultsTable.lastActualProfitUsd,
      lastHarvestedAt:   defiVaultsTable.lastHarvestedAt,
    })
    .from(defiVaultsTable)
    .orderBy(defiVaultsTable.lastHarvestedAt);

  const notifications = vaults
    .filter(v => v.lastTxHash && v.lastActualProfit && parseFloat(v.lastActualProfit) > 0)
    .map(v => ({
      vaultId:         v.id,
      vaultName:       v.name,
      chain:           v.chain,
      txHash:          v.lastTxHash!,
      actualProfitUsd: parseFloat(v.lastActualProfit!),
      harvestedAt:     v.lastHarvestedAt?.toISOString() ?? new Date().toISOString(),
    }));

  res.json(notifications);
});

// GET /defi/notifications/stream — SSE stream of harvest and error-streak events.
// Pushes a JSON event for every profitable harvest immediately after the tx confirms
// and for every vault that crosses the error-streak threshold.
// Falls back: the existing poll endpoint (/defi/notifications) remains for clients
// that do not support EventSource.
router.get("/defi/notifications/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // disable nginx buffering if behind a proxy
  res.flushHeaders();

  // Confirm stream is alive so the client can cancel its polling loop
  res.write("event: connected\ndata: {}\n\n");

  const unsub = subscribeToHarvestEvents((event, data) => {
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch { /* client disconnected between events */ }
  });

  // Keepalive comment every 25s — prevents proxies from closing idle connections
  const keepalive = setInterval(() => {
    try { res.write(": keepalive\n\n"); } catch { /* ignore */ }
  }, 25_000);

  req.on("close", () => {
    clearInterval(keepalive);
    unsub();
  });
});

// GET /defi/settings — retrieve app-level settings (webhook URL, error streak threshold, etc.)
router.get("/defi/settings", async (_req, res) => {
  try {
    const rows = await db
      .select({ key: appSettingsTable.key, value: appSettingsTable.value })
      .from(appSettingsTable);
    const settings: Record<string, string> = {};
    for (const row of rows) settings[row.key] = row.value;
    const rawThreshold = parseInt(settings["error_streak_threshold"] ?? "", 10);
    res.json({
      webhookUrl:           settings["harvest_webhook_url"] ?? null,
      errorStreakThreshold: Number.isFinite(rawThreshold) && rawThreshold > 0 ? rawThreshold : 5,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// GET /defi/error-streaks — vaults whose consecutive error count meets or exceeds the threshold
router.get("/defi/error-streaks", async (_req, res) => {
  try {
    const rows = await db
      .select({ key: appSettingsTable.key, value: appSettingsTable.value })
      .from(appSettingsTable)
      .where(eq(appSettingsTable.key, "error_streak_threshold"));
    const rawThreshold = parseInt(rows[0]?.value ?? "", 10);
    const threshold = Number.isFinite(rawThreshold) && rawThreshold > 0 ? rawThreshold : 5;

    const vaults = await db
      .select({
        id:         defiVaultsTable.id,
        name:       defiVaultsTable.name,
        chain:      defiVaultsTable.chain,
        errorCount: defiVaultsTable.errorCount,
        lastError:  defiVaultsTable.lastError,
      })
      .from(defiVaultsTable)
      .where(sql`${defiVaultsTable.errorCount} >= ${threshold}`);

    res.json(vaults.map(v => ({
      vaultId:    v.id,
      vaultName:  v.name,
      chain:      v.chain,
      errorCount: v.errorCount,
      lastError:  v.lastError ?? "unknown error",
      threshold,
    })));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ── Webhook URL safety validation (SSRF prevention) ───────────────────────────
// Requires HTTPS, blocks loopback/link-local/private CIDRs, and DNS-resolves
// the hostname to ensure all returned IPs are routable public addresses.

function isPrivateOrReservedIp(ip: string): boolean {
  if (!isIPv4(ip)) return true; // block IPv6 (metadata/link-local risk)
  const parts = ip.split(".").map(Number);
  const [a = 0, b = 0] = parts;
  if (a === 0)                           return true; // 0.0.0.0/8 — "this" network
  if (a === 10)                          return true; // 10.0.0.0/8 — private
  if (a === 100 && b >= 64 && b <= 127)  return true; // 100.64.0.0/10 — CGNAT
  if (a === 127)                         return true; // 127.0.0.0/8 — loopback
  if (a === 169 && b === 254)            return true; // 169.254.0.0/16 — link-local / metadata
  if (a === 172 && b >= 16 && b <= 31)   return true; // 172.16.0.0/12 — private
  if (a === 192 && b === 0 && parts[2] === 2) return true; // 192.0.2.0/24 — TEST-NET
  if (a === 192 && b === 168)            return true; // 192.168.0.0/16 — private
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 — benchmark
  if (a >= 224)                          return true; // 224+ — multicast & reserved
  return false;
}

const BLOCKED_HOSTNAMES = new Set(["localhost", "broadcasthost"]);

async function validateWebhookUrl(rawUrl: string): Promise<void> {
  let parsed: URL;
  try { parsed = new URL(rawUrl); } catch {
    throw new Error("Invalid URL format");
  }

  if (parsed.protocol !== "https:") {
    throw new Error("Webhook URL must use HTTPS (http:// is not allowed)");
  }

  const hostname = parsed.hostname.toLowerCase();

  if (BLOCKED_HOSTNAMES.has(hostname) || hostname.endsWith(".local") || hostname.endsWith(".internal")) {
    throw new Error("Webhook URL must not target local or internal hostnames");
  }

  // DNS-resolve and verify every returned address is public
  let addresses: string[];
  try {
    addresses = await dns.resolve4(hostname);
  } catch {
    throw new Error(`Webhook URL hostname "${hostname}" could not be resolved`);
  }

  if (addresses.length === 0) {
    throw new Error(`Webhook URL hostname "${hostname}" resolved to no addresses`);
  }

  for (const ip of addresses) {
    if (isPrivateOrReservedIp(ip)) {
      throw new Error("Webhook URL must not target private or reserved IP ranges");
    }
  }
}

// POST /defi/settings — save webhook URL and/or error streak threshold
router.post("/defi/settings", requireInternalKey, async (req, res) => {
  const { webhookUrl, errorStreakThreshold } = req.body as { webhookUrl?: string; errorStreakThreshold?: number };

  if (webhookUrl === undefined && errorStreakThreshold === undefined) {
    res.status(400).json({ error: "webhookUrl or errorStreakThreshold is required" });
    return;
  }

  let savedWebhookUrl: string | null = null;

  if (webhookUrl !== undefined) {
    const url = webhookUrl.trim();
    if (url === "") {
      await db.delete(appSettingsTable).where(eq(appSettingsTable.key, "harvest_webhook_url"));
      req.log.info("Harvest webhook URL cleared");
    } else {
      // SSRF-safe URL validation: requires HTTPS, blocks private/loopback/link-local ranges
      try {
        await validateWebhookUrl(url);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(400).json({ error: msg });
        return;
      }
      await db
        .insert(appSettingsTable)
        .values({ key: "harvest_webhook_url", value: url })
        .onConflictDoUpdate({ target: appSettingsTable.key, set: { value: url, updatedAt: new Date() } });
      req.log.info({ webhookHost: new URL(url).hostname }, "Harvest webhook URL saved");
      savedWebhookUrl = url;
    }
  }

  let savedThreshold: number | null = null;

  if (errorStreakThreshold !== undefined) {
    const threshold = Math.max(1, Math.floor(Number(errorStreakThreshold)));
    if (!Number.isFinite(threshold)) {
      res.status(400).json({ error: "errorStreakThreshold must be a positive integer" });
      return;
    }
    await db
      .insert(appSettingsTable)
      .values({ key: "error_streak_threshold", value: String(threshold) })
      .onConflictDoUpdate({ target: appSettingsTable.key, set: { value: String(threshold), updatedAt: new Date() } });
    req.log.info({ threshold }, "Error streak threshold saved");
    savedThreshold = threshold;
  }

  res.json({ ok: true, webhookUrl: savedWebhookUrl, errorStreakThreshold: savedThreshold });
});

// POST /defi/discover — pull active Beefy vaults from their public API
router.post("/defi/discover", async (req, res) => {
  const chain = (req.body as { chain?: string }).chain ?? "base";
  if (!["base", "arbitrum", "bsc", "polygon"].includes(chain)) {
    res.status(400).json({ error: "chain must be base, arbitrum, bsc, or polygon" }); return;
  }
  try {
    req.log.info({ chain }, "Beefy vault discovery triggered");
    const result = await discoverBeefyVaults(chain as "base" | "arbitrum" | "bsc" | "polygon");
    res.json({ ok: true, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    req.log.warn({ err: msg }, "Beefy discovery failed");
    res.status(500).json({ ok: false, error: msg });
  }
});

export default router;
