import { Router } from "express";
import { autoSwapWethToUsdc, getLastSwap } from "../lib/autoSwap.js";

const router = Router();

// GET /api/swap/last — last swap result
router.get("/swap/last", (_req, res) => {
  res.json(getLastSwap() ?? { swapped: false, reason: "No swap attempted yet" });
});

// POST /api/swap/trigger — manually trigger a WETH → USDC swap
router.post("/swap/trigger", async (_req, res) => {
  try {
    const result = await autoSwapWethToUsdc();
    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

export default router;
