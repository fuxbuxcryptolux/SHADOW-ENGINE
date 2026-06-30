/**
 * Shadow Harvester — standalone DeFi yield harvester + auto-compounder
 *
 * Stripped from Shadow Engine. Keeps only:
 *   - DeFi vault harvester (Beefy, multi-chain)
 *   - Auto-swap WETH → USDC after profitable harvests
 *   - Arb scanner (price spread detection, no execution risk)
 *   - REST API + dashboard UI
 */

import express from "express";
import cors from "cors";
import { pinoHttp } from "pino-http";
import { logger } from "./lib/logger.js";
import defiRouter from "./routes/defi.js";
import swapRouter from "./routes/swap.js";
import arbRouter from "./routes/arb.js";
import statsRouter from "./routes/stats.js";
import { startScheduler } from "./lib/scheduler.js";
import { runStartupReset } from "./lib/startup.js";

const app = express();
const PORT = parseInt(process.env["PORT"] ?? "3000", 10);

app.use(cors());
app.use(express.json());
app.use(pinoHttp({ logger: logger as any }));

// ── Routes ────────────────────────────────────────────────────────────────────
app.use("/api", defiRouter);
app.use("/api", swapRouter);
app.use("/api", arbRouter);
app.use("/api", statsRouter);

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "shadow-harvester", ts: new Date().toISOString() });
});

// ── Startup ───────────────────────────────────────────────────────────────────
async function main() {
  // Clean corrupted calibration data on restart
  await runStartupReset();

  // Start background scheduler (harvest every 5 min, arb scan every 6 hrs)
  startScheduler();

  app.listen(PORT, () => {
    logger.info({ port: PORT }, "Shadow Harvester running");
  });
}

main().catch((err) => {
  logger.error({ err }, "Fatal startup error");
  process.exit(1);
});
