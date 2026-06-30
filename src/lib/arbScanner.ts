import { logger } from "./logger.js";
import { db } from "../db/index.js";
import { priceSnapshotsTable } from "../db/schema/wallets.js";

// ── Token pairs we track across chains ───────────────────────────────────────

const TRACKED_PAIRS = [
  { symbol: "USDC",  coingeckoId: "usd-coin" },
  { symbol: "USDT",  coingeckoId: "tether" },
  { symbol: "WETH",  coingeckoId: "weth" },
  { symbol: "DAI",   coingeckoId: "dai" },
];

const CHAINS = ["ethereum", "base", "arbitrum"] as const;
type Chain = (typeof CHAINS)[number];

// CoinGecko network slugs for the asset platforms endpoint
const GECKO_PLATFORM: Record<Chain, string> = {
  ethereum: "ethereum",
  base:     "base",
  arbitrum: "arbitrum-one",
};

// ── Fetch token price on a specific chain via CoinGecko free API ──────────────

async function fetchChainPrice(
  coingeckoId: string,
  chain: Chain
): Promise<number | null> {
  try {
    const url = `https://api.coingecko.com/api/v3/simple/token_price/${GECKO_PLATFORM[chain]}?contract_addresses=native&vs_currencies=usd&include_market_cap=false`;
    // For cross-chain prices use the coins endpoint which is chain-agnostic
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${coingeckoId}&vs_currencies=usd`,
      { signal: AbortSignal.timeout(8_000) }
    );
    if (!res.ok) return null;
    const data = (await res.json()) as Record<string, { usd?: number }>;
    return data[coingeckoId]?.usd ?? null;
  } catch {
    return null;
  }
}

// ── DefiLlama pool prices — better chain-specific data ───────────────────────

interface LlamaPool {
  chain: string;
  project: string;
  symbol: string;
  tvlUsd: number;
  apy: number;
  pool: string;
}

async function fetchLlamaPools(): Promise<LlamaPool[]> {
  try {
    const res = await fetch("https://yields.llama.fi/pools", {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { data?: LlamaPool[] };
    return data.data ?? [];
  } catch {
    return [];
  }
}

// ── Spread detection ──────────────────────────────────────────────────────────

interface SpreadResult {
  tokenSymbol: string;
  chainA: Chain;
  chainB: Chain;
  priceA: number;
  priceB: number;
  spreadPct: number;
  spreadUsd: number;
  poolAddressA?: string;
  poolAddressB?: string;
}

export async function scanArbitrageOpportunities(): Promise<SpreadResult[]> {
  const results: SpreadResult[] = [];

  // Use DefiLlama yield pools — they have chain-specific APY that encodes price diffs
  const pools = await fetchLlamaPools();

  for (const pair of TRACKED_PAIRS) {
    const relevant = pools
      .filter(
        (p) =>
          p.symbol.toUpperCase().includes(pair.symbol) &&
          p.tvlUsd > 100_000 &&
          CHAINS.includes(p.chain.toLowerCase() as Chain)
      )
      .slice(0, 20);

    // Group by chain
    const byChain: Partial<Record<Chain, LlamaPool[]>> = {};
    for (const p of relevant) {
      const c = p.chain.toLowerCase() as Chain;
      if (!byChain[c]) byChain[c] = [];
      byChain[c]!.push(p);
    }

    const chains = Object.keys(byChain) as Chain[];
    for (let i = 0; i < chains.length; i++) {
      for (let j = i + 1; j < chains.length; j++) {
        const cA = chains[i]!;
        const cB = chains[j]!;
        const poolA = byChain[cA]![0];
        const poolB = byChain[cB]![0];
        if (!poolA || !poolB) continue;

        // APY difference as a proxy for price pressure (simplified)
        const apyA = poolA.apy ?? 0;
        const apyB = poolB.apy ?? 0;
        const spreadPct = Math.abs(apyA - apyB) / 100;

        if (spreadPct < 0.005) continue; // filter sub-0.5%

        // Estimate USD spread per $10k position
        const spreadUsd = spreadPct * 10_000;

        results.push({
          tokenSymbol: pair.symbol,
          chainA: cA,
          chainB: cB,
          priceA: apyA,
          priceB: apyB,
          spreadPct: spreadPct * 100,
          spreadUsd,
          poolAddressA: poolA.pool,
          poolAddressB: poolB.pool,
        });
      }
    }
  }

  return results.sort((a, b) => b.spreadPct - a.spreadPct).slice(0, 20);
}

// ── Persist snapshots to DB ───────────────────────────────────────────────────

export async function runArbScan(): Promise<SpreadResult[]> {
  try {
    const spreads = await scanArbitrageOpportunities();
    if (spreads.length > 0) {
      await db.insert(priceSnapshotsTable).values(
        spreads.map((s) => ({
          tokenSymbol: s.tokenSymbol,
          chainA: s.chainA,
          chainB: s.chainB,
          priceA: s.priceA,
          priceB: s.priceB,
          spreadPct: s.spreadPct,
          spreadUsd: s.spreadUsd,
          poolAddressA: s.poolAddressA,
          poolAddressB: s.poolAddressB,
        }))
      );
      logger.info({ count: spreads.length }, "Arb scan complete");
    }
    return spreads;
  } catch (err) {
    logger.warn({ err }, "Arb scan failed");
    return [];
  }
}
