/**
 * harvester.ts — DeFi Yield Harvest Compounder
 *
 * For each enabled vault in `defi_vaults`, this module:
 *   1. Resolves the strategy contract address
 *   2. Reads the pending caller bounty via callReward()
 *   3. Fetches ETH/USD price from a Chainlink on-chain oracle
 *   4. Estimates gas cost for harvest()
 *   5. Fires harvest(harvesterAddress) only when net profit > vault threshold
 *   6. Updates the DB with results
 *
 * Wallet: HARVESTER_PRIVATE_KEY env var (hex, with or without 0x prefix)
 * RPC:    HARVESTER_RPC_BASE / HARVESTER_RPC_ARBITRUM / HARVESTER_RPC_BSC / HARVESTER_RPC_POLYGON
 *         (optional per-chain overrides; falls back to bundled public RPCs)
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  formatEther,
  type Address,
  type PublicClient,
  type WalletClient,
  type Chain,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, arbitrum, mainnet, bsc, polygon } from "viem/chains";
import { db } from "../db/index.js";
import { defiVaultsTable, defiHarvestHistoryTable } from "../db/schema/defi.js";
import { appSettingsTable } from "../db/schema/appSettings.js";
import { eq, and } from "drizzle-orm";
import { logger } from "./logger.js";

// ── Chain config ──────────────────────────────────────────────────────────────

const CHAINS: Record<string, Chain> = { base, arbitrum, ethereum: mainnet, bsc, polygon };

const DEFAULT_RPCS: Record<string, string> = {
  base:      "https://mainnet.base.org",
  // arb1.arbitrum.io is the official Arbitrum Foundation RPC — no API key, supports all methods
  arbitrum:  "https://arb1.arbitrum.io/rpc",
  ethereum:  "https://ethereum.publicnode.com",
  bsc:       "https://bsc-dataseed.binance.org",
  polygon:   "https://polygon-rpc.com",
};

// Fallback RPCs tried in order if the primary fails
const FALLBACK_RPCS: Record<string, string[]> = {
  arbitrum: ["https://arbitrum-one.publicnode.com", "https://1rpc.io/arb"],
  base:     ["https://base.llamarpc.com", "https://base.publicnode.com", "https://1rpc.io/base"],
  bsc:      ["https://bsc-dataseed1.defibit.io", "https://1rpc.io/bnb"],
  polygon:  ["https://rpc.ankr.com/polygon", "https://1rpc.io/matic"],
};

// Chainlink native-token/USD price feed addresses (8-decimal feed)
const CHAINLINK_ETH_USD: Record<string, Address> = {
  base:      "0x71041dddad3595F9CEd3dCCFBe3D1F4b0a16Bb70",
  arbitrum:  "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612",
  ethereum:  "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419",
  bsc:       "0x0567F2323251f0Aab15c8dFb1967E4e8A9A93c5", // BNB/USD
  polygon:   "0xAB594600376Ec9fD91F8e885dADF0CE036862dE", // MATIC/USD
};

// ── ABIs ─────────────────────────────────────────────────────────────────────

const VAULT_ABI = parseAbi([
  "function strategy() external view returns (address)",
  "function want() external view returns (address)",
  "function token() external view returns (address)",
]);

const STRATEGY_ABI = parseAbi([
  "function callReward() external view returns (uint256)",
  "function paused() external view returns (bool)",
]);

// Used to detect which token the strategy pays call fees in
const REWARD_TOKEN_ABI = parseAbi([
  "function output() external view returns (address)",
  "function rewardToken() external view returns (address)",
]);

// Separate ABIs for each harvest variant (viem requires unambiguous function signatures)
const HARVEST_WITH_RECIPIENT_ABI = parseAbi([
  "function harvest(address callFeeRecipient) external",
]);

const HARVEST_NO_ARGS_ABI = parseAbi([
  "function harvest() external",
]);

const CHAINLINK_ABI = parseAbi([
  "function latestRoundData() external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
]);

// Wrapped native token addresses per chain — used to measure actual call fee received after harvest
const WETH_ADDRESSES: Record<string, Address> = {
  arbitrum: "0x82af49447d8a07e3bd95bd0d56f35241523fbab1",
  base:     "0x4200000000000000000000000000000000000006",
  ethereum: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  bsc:      "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", // WBNB
  polygon:  "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", // WMATIC
};
const ERC20_BALANCE_ABI = parseAbi([
  "function balanceOf(address owner) external view returns (uint256)",
]);

// ── In-memory state ───────────────────────────────────────────────────────────

export interface HarvestResult {
  vaultId: number;
  vaultName: string;
  chain: string;
  success: boolean;
  skipped: boolean;
  reason?: string;
  txHash?: string;
  bountyUsd?: number;      // calibrated estimate (callReward × calibration factor)
  gasUsd?: number;
  netProfitUsd?: number;   // calibrated net (bountyUsd - gasUsd)
  actualProfitUsd?: number; // real measured (WETH received - gasUsd), set after tx confirms
  error?: string;
  errorStreak?: boolean;   // true when this failure pushed errorCount to the alert threshold
}

interface HarvesterStatus {
  walletAddress: string | null;
  walletConfigured: boolean;
  lastRunAt: Date | null;
  lastRunResults: HarvestResult[];
  runCount: number;
  totalEarnedUsd: number;
}

const _status: HarvesterStatus = {
  walletAddress:   null,
  walletConfigured: false,
  lastRunAt:       null,
  lastRunResults:  [],
  runCount:        0,
  totalEarnedUsd:  0,
};

export function getHarvesterStatus(): HarvesterStatus {
  // Check wallet config eagerly on every call so the UI reflects the current key
  const account = getAccount();
  return {
    ..._status,
    walletAddress:    account?.address ?? _status.walletAddress,
    walletConfigured: !!account,
  };
}

// ── Wallet setup ──────────────────────────────────────────────────────────────

function getAccount() {
  const raw = process.env["HARVESTER_PRIVATE_KEY"];
  if (!raw) return null;
  const key = raw.startsWith("0x") ? raw : `0x${raw}`;
  try {
    return privateKeyToAccount(key as `0x${string}`);
  } catch {
    logger.warn("HARVESTER_PRIVATE_KEY is set but invalid");
    return null;
  }
}

function getRpcUrl(chain: string): string {
  return process.env[`HARVESTER_RPC_${chain.toUpperCase()}`]
    ?? DEFAULT_RPCS[chain]
    ?? DEFAULT_RPCS["base"]!;
}

function getPublicClient(chain: string): PublicClient {
  return createPublicClient({
    chain: CHAINS[chain] ?? base,
    transport: http(getRpcUrl(chain)),
  }) as PublicClient;
}

// Try a call on the primary client; on HTTP failure, retry each fallback RPC in order.
async function withFallback<T>(chain: string, fn: (client: PublicClient) => Promise<T>): Promise<T> {
  try {
    return await fn(getPublicClient(chain));
  } catch (primaryErr) {
    const fallbacks = FALLBACK_RPCS[chain] ?? [];
    for (const url of fallbacks) {
      try {
        const fb = createPublicClient({ chain: CHAINS[chain] ?? base, transport: http(url) }) as PublicClient;
        return await fn(fb);
      } catch { /* try next */ }
    }
    throw primaryErr; // all failed — rethrow original
  }
}

function getWalletClient(chain: string) {
  const account = getAccount();
  if (!account) return null;
  return createWalletClient({
    account,
    chain: CHAINS[chain] ?? base,
    transport: http(getRpcUrl(chain)),
  });
}

// ── Price oracle ──────────────────────────────────────────────────────────────

const _priceCache: Record<string, { usd: number; ts: number }> = {};

async function getEthUsd(chain: string): Promise<number> {
  const cached = _priceCache[chain];
  if (cached && Date.now() - cached.ts < 5 * 60 * 1000) return cached.usd;

  const feedAddress = CHAINLINK_ETH_USD[chain];
  if (!feedAddress) return 2500; // fallback

  try {
    const data = await withFallback(chain, (c) => c.readContract({
      address: feedAddress,
      abi: CHAINLINK_ABI,
      functionName: "latestRoundData",
    })) as [bigint, bigint, bigint, bigint, bigint];

    const price = Number(data[1]) / 1e8;
    _priceCache[chain] = { usd: price, ts: Date.now() };
    return price;
  } catch {
    return _priceCache[chain]?.usd ?? 2500;
  }
}

// ── Strategy resolution ───────────────────────────────────────────────────────

async function resolveStrategy(
  client: PublicClient,
  vaultAddress: Address,
  cachedStrategy: string | null
): Promise<Address | null> {
  if (cachedStrategy) return cachedStrategy as Address;

  try {
    const strategy = await client.readContract({
      address: vaultAddress,
      abi: VAULT_ABI,
      functionName: "strategy",
    }) as Address;
    return strategy;
  } catch {
    return null;
  }
}

// Detect which ERC-20 token the strategy pays call fees in.
// Tries output() (Beefy v6/v7 convention) then rewardToken(). Falls back to WETH.
async function detectRewardToken(client: PublicClient, strategy: Address, chain: string): Promise<Address> {
  const zero = "0x0000000000000000000000000000000000000000";
  for (const fn of ["output", "rewardToken"] as const) {
    try {
      const tok = await client.readContract({
        address: strategy, abi: REWARD_TOKEN_ABI, functionName: fn,
      }) as Address;
      if (tok && tok.toLowerCase() !== zero) return tok;
    } catch { /* method not supported on this strategy */ }
  }
  return (WETH_ADDRESSES[chain] ?? WETH_ADDRESSES["base"]) as Address;
}

// ── Single vault harvest ──────────────────────────────────────────────────────

async function harvestVault(
  vault: {
    id: number; name: string; chain: string; vaultAddress: string;
    strategyAddress: string | null; minProfitUsd: string | null;
    lastHarvestedAt: Date | null;
    rewardCalibration: string | null;
    runCount: number; errorCount: number;
    totalBountyEarnedUsd: string | null;
    totalActualEarnedUsd: string | null;
  },
  walletClient: WalletClient,
  account: ReturnType<typeof getAccount>,
  nonce?: number,
  errorStreakThreshold = 5
): Promise<HarvestResult> {
  const chain = vault.chain;
  const client = getPublicClient(chain);
  const harvesterAddr = account!.address;

  // 1. Resolve strategy
  const strategy = await resolveStrategy(client, vault.vaultAddress as Address, vault.strategyAddress);
  if (!strategy) {
    return { vaultId: vault.id, vaultName: vault.name, chain, success: false, skipped: true,
      reason: "Could not resolve strategy address" };
  }

  // Cache strategy address in DB if newly resolved
  if (!vault.strategyAddress) {
    db.update(defiVaultsTable)
      .set({ strategyAddress: strategy })
      .where(eq(defiVaultsTable.id, vault.id))
      .catch(() => {});
  }

  // 2. Check if strategy is paused
  try {
    const paused = await client.readContract({ address: strategy, abi: STRATEGY_ABI, functionName: "paused" }) as boolean;
    if (paused) {
      return { vaultId: vault.id, vaultName: vault.name, chain, success: false, skipped: true,
        reason: "Strategy is paused" };
    }
  } catch { /* not all strategies expose paused() */ }

  // 3. Read pending bounty (optional — some strategies expose callReward; others don't)
  let bountyWei = 0n;
  try {
    bountyWei = await client.readContract({ address: strategy, abi: STRATEGY_ABI, functionName: "callReward" }) as bigint;
  } catch { /* no callReward() method — will use no-bounty mode */ }
  const hasBounty = bountyWei > 0n;

  // 4. Get ETH price; raw bounty in USD from callReward() units
  const ethUsd       = await getEthUsd(chain);
  const rawBountyUsd = Number(formatEther(bountyWei)) * ethUsd;

  // Apply per-vault calibration: callReward() returns yield-pool units, not caller's ETH fee.
  // Calibration factor = actual_weth_received / callReward_usd (measured from previous harvests).
  // Without calibration we take one "learning run" at a cost of one tx worth of gas.
  const rewardCalibration = parseFloat(vault.rewardCalibration ?? "0");
  const calibratedBountyUsd = (hasBounty && rewardCalibration > 0)
    ? rawBountyUsd * rewardCalibration
    : rawBountyUsd; // uncalibrated: use raw for first learning run

  // 5. Estimate gas
  let estimatedGas = 400_000n; // safe fallback for Beefy strategies
  try {
    estimatedGas = await client.estimateContractGas({
      address: strategy,
      abi: STRATEGY_ABI,
      functionName: "harvest",
      args: [harvesterAddr],
      account: harvesterAddr,
    });
    estimatedGas = (estimatedGas * 120n) / 100n; // 20% buffer
  } catch {
    try {
      estimatedGas = await client.estimateContractGas({
        address: strategy,
        abi: STRATEGY_ABI,
        functionName: "harvest",
        args: [],
        account: harvesterAddr,
      });
      estimatedGas = (estimatedGas * 120n) / 100n;
    } catch { /* use fallback */ }
  }

  let gasPrice: bigint;
  try {
    gasPrice = await withFallback(chain, (c) => c.getGasPrice());
  } catch {
    gasPrice = 100_000_000n; // 0.1 gwei fallback
  }
  const gasCostWei       = gasPrice * estimatedGas;
  const gasUsd           = Number(formatEther(gasCostWei)) * ethUsd;
  const netProfitUsd     = calibratedBountyUsd - gasUsd;
  const minProfit        = parseFloat(vault.minProfitUsd ?? "0.10");

  logger.info(
    {
      vault: vault.name, chain, hasBounty,
      rawBountyUsd: rawBountyUsd.toFixed(4),
      calibration: rewardCalibration.toFixed(6),
      calibratedBountyUsd: calibratedBountyUsd.toFixed(6),
      gasUsd: gasUsd.toFixed(6), netProfitUsd: netProfitUsd.toFixed(6),
    },
    "Harvest profitability check"
  );

  // Detect the reward token the strategy pays call fees in, then snapshot balances.
  // Some Beefy strategies pay in WETH; others pay in a protocol-specific token.
  // We snapshot: (1) the detected reward token, (2) WETH as a separate fallback if
  // the reward token differs, and (3) native ETH (adjusted for gas) as a last resort.
  const wethAddr = WETH_ADDRESSES[chain] as Address | undefined;

  let rewardTokenAddr: Address = wethAddr ?? ("0x4200000000000000000000000000000000000006" as Address);
  try {
    rewardTokenAddr = await detectRewardToken(client, strategy, chain);
  } catch { /* use WETH */ }
  const rewardIsWeth = wethAddr != null && rewardTokenAddr.toLowerCase() === wethAddr.toLowerCase();

  let rewardBeforeWei    = 0n;
  let rewardBeforeReadOk = false;
  let wethBeforeWei      = 0n; // only used when reward token != WETH
  let nativeBeforeWei    = 0n;
  let nativeBeforeReadOk = false;

  // Pin pre-tx reads to the current block so the post-tx delta is not contaminated
  // by unrelated WETH transfers that arrive in blocks between the pre-read and the tx.
  let preBlock: bigint | undefined;
  try {
    preBlock = await withFallback(chain, (c) => c.getBlockNumber());
  } catch { /* fall through — reads will use "latest" if this fails */ }

  try {
    rewardBeforeWei = await withFallback(chain, (c) => c.readContract({
      address: rewardTokenAddr, abi: ERC20_BALANCE_ABI,
      functionName: "balanceOf", args: [harvesterAddr],
      ...(preBlock !== undefined ? { blockNumber: preBlock } : {}),
    }) as Promise<bigint>);
    rewardBeforeReadOk = true;
  } catch { /* pre-tx read failed — calibration will be skipped this run */ }

  if (!rewardIsWeth && wethAddr) {
    try {
      wethBeforeWei = await withFallback(chain, (c) => c.readContract({
        address: wethAddr, abi: ERC20_BALANCE_ABI,
        functionName: "balanceOf", args: [harvesterAddr],
        ...(preBlock !== undefined ? { blockNumber: preBlock } : {}),
      }) as Promise<bigint>);
    } catch { /* ignore */ }
  }

  try {
    nativeBeforeWei    = await withFallback(chain, (c) => c.getBalance({
      address: harvesterAddr,
      ...(preBlock !== undefined ? { blockNumber: preBlock } : {}),
    }));
    nativeBeforeReadOk = true;
  } catch { /* ignore */ }

  if (hasBounty) {
    if (netProfitUsd < minProfit) {
      const tag = rewardCalibration > 0
        ? ` [calibrated; raw callReward=$${rawBountyUsd.toFixed(2)}]`
        : " [uncalibrated — run once to calibrate]";
      return {
        vaultId: vault.id, vaultName: vault.name, chain,
        success: false, skipped: true,
        reason: `Net profit $${netProfitUsd.toFixed(4)} below $${minProfit.toFixed(2)}${tag}`,
        bountyUsd: calibratedBountyUsd, gasUsd, netProfitUsd,
      };
    }
  } else {
    // No-bounty mode: only harvest if gas is ultra-cheap AND vault has a 4-hour cooldown.
    const maxNoBountyGas    = 0.005;
    const noBountyCooldownMs = 4 * 60 * 60 * 1000;
    const lastHarvested      = vault.lastHarvestedAt?.getTime() ?? 0;
    const cooldownRemainMs   = noBountyCooldownMs - (Date.now() - lastHarvested);

    if (gasUsd > maxNoBountyGas) {
      return {
        vaultId: vault.id, vaultName: vault.name, chain,
        success: false, skipped: true,
        reason: `No call reward; gas $${gasUsd.toFixed(4)} > $${maxNoBountyGas.toFixed(3)} limit`,
        bountyUsd: 0, gasUsd, netProfitUsd: -gasUsd,
      };
    }
    if (cooldownRemainMs > 0) {
      const remainMins = Math.ceil(cooldownRemainMs / 60_000);
      return {
        vaultId: vault.id, vaultName: vault.name, chain,
        success: false, skipped: true,
        reason: `No call reward; cooldown ${remainMins}m remaining (harvests every 4h max)`,
        bountyUsd: 0, gasUsd, netProfitUsd: -gasUsd,
      };
    }
  }

  // 6. Fire harvest()
  logger.info({ vault: vault.name, chain, netProfitUsd: netProfitUsd.toFixed(4) }, "Firing harvest transaction");

  // Skip simulation — eth_call via public RPCs returns -32602 on some requests.
  // Go straight to writeContract with the local account (signs via eth_sendRawTransaction).
  // Try harvest(address callFeeRecipient) first (Beefy v7+), fall back to harvest().
  const chainObj = CHAINS[chain] ?? base;

  let txHash: string;
  try {
    try {
      txHash = await walletClient.writeContract({
        address: strategy,
        abi: HARVEST_WITH_RECIPIENT_ABI,
        functionName: "harvest",
        args: [harvesterAddr],
        account: account!,
        chain: chainObj,
        ...(nonce !== undefined ? { nonce } : {}),
      });
    } catch {
      txHash = await walletClient.writeContract({
        address: strategy,
        abi: HARVEST_NO_ARGS_ABI,
        functionName: "harvest",
        account: account!,
        chain: chainObj,
        ...(nonce !== undefined ? { nonce } : {}),
      });
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const errLower = errMsg.toLowerCase();
    // Detect permanently dead strategies and auto-disable them to stop wasting gas.
    const isShutdown = errLower.includes("shutdown") || errLower.includes("paused");
    logger.warn({ vault: vault.name, chain, isShutdown, nonce }, "Harvest tx failed");
    const newErrorCount = vault.errorCount + 1;
    await db.update(defiVaultsTable).set({
      errorCount: newErrorCount,
      lastError: errMsg,
      lastBountyUsd: String(calibratedBountyUsd),
      lastGasUsd: String(gasUsd),
      ...(isShutdown ? { enabled: false } : {}),
    }).where(eq(defiVaultsTable.id, vault.id));

    // Detect when errorCount crosses the threshold for the first time this streak.
    const crossedThreshold = newErrorCount >= errorStreakThreshold && vault.errorCount < errorStreakThreshold;
    if (crossedThreshold) {
      logger.warn({ vault: vault.name, chain, errorCount: newErrorCount, threshold: errorStreakThreshold }, "Vault error streak threshold crossed");
    }

    return { vaultId: vault.id, vaultName: vault.name, chain, success: false, skipped: false,
      error: errMsg, bountyUsd: calibratedBountyUsd, gasUsd, netProfitUsd,
      errorStreak: crossedThreshold };
  }

  // 7. Wait for confirmation, measure actual reward received across all token types,
  //    then update calibration only when a positive delta is confirmed.
  let rewardReceivedUsd = 0;
  let actualProfitUsd   = -gasUsd; // worst case: gas spent, nothing received
  let newCalibration    = vault.rewardCalibration; // preserve unless measured

  try {
    const receipt = await withFallback(chain, (c) =>
      c.waitForTransactionReceipt({ hash: txHash as `0x${string}`, timeout: 45_000 })
    );
    const gasSpentWei = receipt.gasUsed * (receipt.effectiveGasPrice ?? gasPrice);

    if (!rewardBeforeReadOk) {
      // Pre-tx read failed — can't produce a reliable delta, skip calibration.
      logger.warn({ vault: vault.name, txHash },
        "Pre-tx balance read failed — calibration skipped this run");
    } else {
      // 7a. Reward token delta (primary measurement)
      // Pin post-tx reads to receipt.blockNumber so the delta only reflects state changes
      // from our specific harvest tx — not any unrelated transfers in later blocks.
      const postBlock = receipt.blockNumber;
      let rewardDeltaUsd   = 0;
      let postRewardReadOk = false;
      try {
        const rewardAfterWei = await withFallback(chain, (c) => c.readContract({
          address: rewardTokenAddr, abi: ERC20_BALANCE_ABI,
          functionName: "balanceOf", args: [harvesterAddr],
          blockNumber: postBlock,
        }) as Promise<bigint>);
        const rewardDelta = rewardAfterWei > rewardBeforeWei ? rewardAfterWei - rewardBeforeWei : 0n;
        rewardDeltaUsd    = Number(formatEther(rewardDelta)) * ethUsd;
        postRewardReadOk  = true;
      } catch (e) {
        logger.warn({ vault: vault.name, txHash, err: e instanceof Error ? e.message : String(e) },
          "Post-tx reward token balance read failed — calibration skipped this run");
      }

      if (postRewardReadOk) {
        // 7b. WETH delta (only when reward token differs from WETH)
        let wethDeltaUsd = 0;
        if (!rewardIsWeth && wethAddr) {
          try {
            const wethAfterWei = await withFallback(chain, (c) => c.readContract({
              address: wethAddr, abi: ERC20_BALANCE_ABI,
              functionName: "balanceOf", args: [harvesterAddr],
              blockNumber: postBlock,
            }) as Promise<bigint>);
            const wethDelta = wethAfterWei > wethBeforeWei ? wethAfterWei - wethBeforeWei : 0n;
            wethDeltaUsd    = Number(formatEther(wethDelta)) * ethUsd;
          } catch { /* non-critical */ }
        }

        // 7c. Native ETH delta net of gas (last-resort fallback)
        let nativeDeltaUsd = 0;
        if (nativeBeforeReadOk) {
          try {
            const nativeAfterWei = await withFallback(chain, (c) => c.getBalance({
              address: harvesterAddr,
              blockNumber: postBlock,
            }));
            // Add back gas spent to isolate the reward portion from the gas deduction.
            const nativeRewardWei = (nativeAfterWei + gasSpentWei) > nativeBeforeWei
              ? (nativeAfterWei + gasSpentWei) - nativeBeforeWei : 0n;
            nativeDeltaUsd = Number(formatEther(nativeRewardWei)) * ethUsd;
          } catch { /* non-critical */ }
        }

        // 7d. Best positive measurement wins
        rewardReceivedUsd = Math.max(rewardDeltaUsd, wethDeltaUsd, nativeDeltaUsd);
        actualProfitUsd   = rewardReceivedUsd - gasUsd;

        // 7e. Calibration update — rolling EMA (70% old / 30% new).
        // Guard: only update when a positive reward was actually measured.
        // If all deltas are 0 (e.g. vault doesn't pay caller, or wrong token detected),
        // preserve the existing calibration rather than writing a zero that kills the vault.
        if (rewardReceivedUsd > 0 && rawBountyUsd >= 0.001) {
          const measuredFactor = rewardReceivedUsd / rawBountyUsd;
          const existingFactor = parseFloat(vault.rewardCalibration ?? "0");
          const updatedFactor  = existingFactor > 0
            ? existingFactor * 0.7 + measuredFactor * 0.3
            : measuredFactor;
          newCalibration = updatedFactor.toFixed(10);
          logger.info(
            { vault: vault.name, rewardReceivedUsd: rewardReceivedUsd.toFixed(6),
              rawBountyUsd: rawBountyUsd.toFixed(4), measuredFactor: measuredFactor.toFixed(8),
              updatedFactor: updatedFactor.toFixed(8), actualProfitUsd: actualProfitUsd.toFixed(6) },
            "Calibration updated"
          );
        } else if (rewardReceivedUsd === 0) {
          logger.warn(
            { vault: vault.name, txHash, rewardTokenAddr, rewardDeltaUsd, wethDeltaUsd, nativeDeltaUsd },
            "Harvest confirmed on-chain but no reward token delta detected — calibration unchanged"
          );
        }
      }
    }
  } catch (receiptErr) {
    logger.warn({ vault: vault.name, txHash, err: receiptErr instanceof Error ? receiptErr.message : String(receiptErr) },
      "Could not confirm tx or measure balance — calibration not updated");
  }

  // Auto-disable if calibration proves vault can never break even:
  // break-even callReward = gasUsd / calibration. If that exceeds $500, harvesting is futile.
  const finalCalibration    = parseFloat(newCalibration ?? "0");
  const breakEvenCallReward = finalCalibration > 0 ? gasUsd / finalCalibration : 0;
  const isStructurallyDead  = finalCalibration > 0
    && rawBountyUsd >= 0.001   // callReward was real, not zero
    && breakEvenCallReward > 500  // would need $500 callReward to break even — never happening
    && vault.runCount >= 1;       // at least 2 runs before auto-disabling

  // 8. Persist success + actual profit + updated calibration
  const harvestedAt = new Date();
  await db.update(defiVaultsTable).set({
    lastHarvestedAt: harvestedAt,
    lastTxHash: txHash,
    runCount: vault.runCount + 1,
    lastBountyUsd: String(calibratedBountyUsd),
    lastGasUsd:    String(gasUsd),
    lastActualProfitUsd:  String(actualProfitUsd),
    rewardCalibration:    newCalibration,
    totalBountyEarnedUsd: String(
      parseFloat(vault.totalBountyEarnedUsd ?? "0") + calibratedBountyUsd
    ),
    totalActualEarnedUsd: String(
      parseFloat(vault.totalActualEarnedUsd ?? "0") + actualProfitUsd
    ),
    lastError:  null,
    errorCount: 0,
    ...(isStructurallyDead ? { enabled: false } : {}),
  }).where(eq(defiVaultsTable.id, vault.id));

  // Record harvest event for P&L history chart
  await db.insert(defiHarvestHistoryTable).values({
    vaultId:         vault.id,
    vaultName:       vault.name,
    chain,
    txHash,
    actualEarnedUsd: String(actualProfitUsd),
    gasUsd:          String(gasUsd),
    harvestedAt,
  });

  if (isStructurallyDead) {
    logger.warn({ vault: vault.name, breakEvenCallReward: breakEvenCallReward.toFixed(2) },
      "Vault auto-disabled: structurally unprofitable");
  }

  logger.info(
    { vault: vault.name, chain, txHash, rewardReceivedUsd: rewardReceivedUsd.toFixed(6),
      actualProfitUsd: actualProfitUsd.toFixed(6), calibration: newCalibration },
    "Harvest complete"
  );

  return {
    vaultId: vault.id, vaultName: vault.name, chain,
    success: true, skipped: false,
    txHash, bountyUsd: calibratedBountyUsd, gasUsd, netProfitUsd, actualProfitUsd,
  };
}

// ── Discover Beefy vaults from public API ────────────────────────────────────

export async function discoverBeefyVaults(chain: "base" | "arbitrum" | "bsc" | "polygon" = "base"): Promise<{ inserted: number; skipped: number }> {
  type BeefyVault = {
    id: string; name: string; status: string;
    earnContractAddress: string; strategy: string;
    tokenDecimals?: number; earnedToken?: string;
    chain: string;
  };
  type NestedTvl  = Record<string, Record<string, number>>;
  type ApyMap     = Record<string, number>;
  type FeeEntry   = { performance?: { call?: number; strategist?: number; treasury?: number; total?: number } };
  type FeeMap     = Record<string, FeeEntry>;

  const res = await fetch(`https://api.beefy.finance/vaults?chain=${chain}`, {
    headers: { "User-Agent": "ShadowEngine/1.0 (+https://github.com/shadow)" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Beefy API returned HTTP ${res.status}`);

  const vaults = await res.json() as BeefyVault[];
  const active = vaults.filter(v => v.status === "active" && v.chain === chain);

  // Fetch TVL, APY, and per-vault fees from the Beefy public API in parallel.
  // Expected daily call fee = TVL × APY/365 × callFeeRate (per vault from /fees).
  // The /tvl response is nested: { chainId: { vaultId: tvlUsd } }
  const CHAIN_IDS: Record<string, string> = {
    arbitrum: "42161", base: "8453", bsc: "56", polygon: "137",
  };
  const chainId = CHAIN_IDS[chain] ?? "8453";

  let tvlByChain: Record<string, number> = {};
  let apyMap: ApyMap  = {};
  let feeMap: FeeMap  = {};
  try {
    const [tvlRes, apyRes, feeRes] = await Promise.all([
      fetch("https://api.beefy.finance/tvl",  { signal: AbortSignal.timeout(10_000), headers: { "User-Agent": "ShadowEngine/1.0" } }),
      fetch("https://api.beefy.finance/apy",  { signal: AbortSignal.timeout(10_000), headers: { "User-Agent": "ShadowEngine/1.0" } }),
      fetch("https://api.beefy.finance/fees", { signal: AbortSignal.timeout(10_000), headers: { "User-Agent": "ShadowEngine/1.0" } }),
    ]);
    if (tvlRes.ok) {
      const nested = await tvlRes.json() as NestedTvl;
      tvlByChain = nested[chainId] ?? {};
    }
    if (apyRes.ok) apyMap = await apyRes.json() as ApyMap;
    if (feeRes.ok) feeMap = await feeRes.json() as FeeMap;
  } catch { /* proceed without TVL/APY/fees — insert all active vaults */ }

  // Rank by expected daily call fee (per-vault rate from /fees, fallback 0.0001).
  // MIN_CALL_FEE_RATE: 0.00005 (0.005%) keeps any vault actually paying harvesters;
  // the standard Beefy call fee is 0.010% (0.0001) across all chains — 0.0003 was too high.
  // MIN_DAILY_FEE: $0.10/day requires TVL×APY ≥ ~$365k/year at 0.01% fee — high-volume only.
  const MIN_CALL_FEE_RATE = 0.00005; // 0.005% — excludes only truly zero-fee vaults
  const MIN_DAILY_FEE     = 0.10;    // $0.10/day expected gross call fee
  const hasTvlData = Object.keys(tvlByChain).length > 0;
  const ranked = active
    .map(v => {
      const tvl         = tvlByChain[v.id] ?? 0;
      const apy         = apyMap[v.id] ?? 0;
      const callFeeRate = feeMap[v.id]?.performance?.call ?? 0.0001;
      const expectedDailyFee = tvl * apy / 365 * callFeeRate;
      return { ...v, tvl, expectedDailyFee, callFeeRate };
    })
    .filter(v => v.callFeeRate >= MIN_CALL_FEE_RATE)
    .filter(v => !hasTvlData || v.tvl === 0 || v.expectedDailyFee >= MIN_DAILY_FEE)
    .sort((a, b) => b.expectedDailyFee - a.expectedDailyFee)
    .slice(0, 50);

  logger.info(
    { chain, chainId, total: active.length, afterFeeFilter: ranked.length,
      minCallFeeRate: MIN_CALL_FEE_RATE, minDailyFee: MIN_DAILY_FEE,
      feeMapLoaded: Object.keys(feeMap).length > 0 },
    "Beefy vault candidates ranked",
  );

  let inserted = 0, skipped = 0;
  for (const v of ranked) {
    try {
      const addr = v.earnContractAddress.toLowerCase();
      const existing = await db
        .select({ id: defiVaultsTable.id })
        .from(defiVaultsTable)
        .where(and(eq(defiVaultsTable.vaultAddress, addr), eq(defiVaultsTable.chain, chain)))
        .limit(1);
      if (existing.length > 0) { skipped++; continue; }
      await db.insert(defiVaultsTable).values({
        name:            v.name,
        protocol:        "beefy",
        chain,
        vaultAddress:    addr,
        strategyAddress: v.strategy?.toLowerCase() ?? null,
        wantToken:       v.earnedToken ?? null,
        enabled:         false, // discovered vaults start disabled — user opts in
        minProfitUsd:    "0.005", // $0.005 — net profit threshold after gas
      });
      inserted++;
    } catch { skipped++; }
  }

  logger.info({ chain, inserted, skipped }, "Beefy vault discovery complete");
  return { inserted, skipped };
}

// ── Webhook delivery ─────────────────────────────────────────────────────────

export interface HarvestNotification {
  vaultId: number;
  vaultName: string;
  chain: string;
  txHash: string;
  actualProfitUsd: number;
  harvestedAt: string;
}

export interface ErrorStreakNotification {
  vaultId: number;
  vaultName: string;
  chain: string;
  errorCount: number;
  lastError: string;
  detectedAt: string;
}

async function getWebhookUrl(): Promise<string | null> {
  try {
    const rows = await db
      .select({ value: appSettingsTable.value })
      .from(appSettingsTable)
      .where(eq(appSettingsTable.key, "harvest_webhook_url"))
      .limit(1);
    return rows[0]?.value ?? null;
  } catch {
    return null;
  }
}

async function fireWebhook(url: string, notifications: HarvestNotification[]): Promise<void> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "ShadowEngine/1.0" },
      body: JSON.stringify({ event: "harvest_profit", harvests: notifications }),
      signal: AbortSignal.timeout(10_000),
    });
    logger.info({ url, status: res.status, count: notifications.length }, "Harvest webhook delivered");
  } catch (err) {
    logger.warn({ url, err: err instanceof Error ? err.message : String(err) }, "Harvest webhook delivery failed");
  }
}

async function fireErrorStreakWebhook(url: string, streaks: ErrorStreakNotification[]): Promise<void> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "ShadowEngine/1.0" },
      body: JSON.stringify({ event: "vault_error_streak", streaks }),
      signal: AbortSignal.timeout(10_000),
    });
    logger.info({ url, status: res.status, count: streaks.length }, "Error streak webhook delivered");
  } catch (err) {
    logger.warn({ url, err: err instanceof Error ? err.message : String(err) }, "Error streak webhook delivery failed");
  }
}

async function getErrorStreakThreshold(): Promise<number> {
  try {
    const rows = await db
      .select({ value: appSettingsTable.value })
      .from(appSettingsTable)
      .where(eq(appSettingsTable.key, "error_streak_threshold"))
      .limit(1);
    const val = parseInt(rows[0]?.value ?? "", 10);
    return Number.isFinite(val) && val > 0 ? val : 5;
  } catch {
    return 5;
  }
}

// ── SSE broadcast system ──────────────────────────────────────────────────────
// Clients subscribe with a callback; runHarvester() pushes events immediately
// after each profitable tx confirms — no polling gap.

type SseEventCallback = (event: string, data: unknown) => void;
const _sseSubscribers = new Set<SseEventCallback>();

/** Register a callback that receives (eventName, payload) for every harvest SSE event.
 *  Returns an unsubscribe function — call it when the SSE connection closes. */
export function subscribeToHarvestEvents(cb: SseEventCallback): () => void {
  _sseSubscribers.add(cb);
  return () => { _sseSubscribers.delete(cb); };
}

function broadcastSseEvent(event: string, data: unknown): void {
  for (const cb of _sseSubscribers) {
    try { cb(event, data); } catch { /* closed connection — ignore */ }
  }
}

// ── Main harvest run ──────────────────────────────────────────────────────────

export async function runHarvester(): Promise<HarvestResult[]> {
  const account = getAccount();

  _status.walletConfigured = !!account;
  _status.walletAddress    = account?.address ?? null;

  if (!account) {
    logger.warn("HARVESTER_PRIVATE_KEY not set — harvester in read-only mode");
    // Still do the profitability scans so the UI can show data
  }

  const [vaults, errorStreakThreshold] = await Promise.all([
    db.select().from(defiVaultsTable).where(and(eq(defiVaultsTable.enabled, true))),
    getErrorStreakThreshold(),
  ]);

  if (vaults.length === 0) {
    return [];
  }

  const results: HarvestResult[] = [];
  // Track pending nonce per chain so sequential txs in one run don't collide.
  // We fetch once on first use and increment locally after each broadcast.
  const nonceMap = new Map<string, number>();

  for (const vault of vaults) {
    const chain = vault.chain;
    const walletCli = account ? getWalletClient(chain) : null;

    if (!walletCli || !account) {
      // Read-only scan — check profitability but don't execute
      try {
        const client = getPublicClient(chain);
        const strategy = await resolveStrategy(client, vault.vaultAddress as Address, vault.strategyAddress);
        if (!strategy) { results.push({ vaultId: vault.id, vaultName: vault.name, chain, success: false, skipped: true, reason: "No strategy" }); continue; }

        let bountyWei = 0n;
        try { bountyWei = await client.readContract({ address: strategy, abi: STRATEGY_ABI, functionName: "callReward" }) as bigint; } catch { /* skip */ }

        const ethUsd    = await getEthUsd(chain);
        const bountyUsd = Number(formatEther(bountyWei)) * ethUsd;
        const gasPrice  = await client.getGasPrice();
        const gasUsd    = Number(formatEther(gasPrice * 400_000n)) * ethUsd;

        results.push({
          vaultId: vault.id, vaultName: vault.name, chain,
          success: false, skipped: true,
          reason: "Wallet not configured (read-only scan)",
          bountyUsd, gasUsd, netProfitUsd: bountyUsd - gasUsd,
        });
      } catch (err) {
        results.push({ vaultId: vault.id, vaultName: vault.name, chain, success: false, skipped: true,
          error: err instanceof Error ? err.message : String(err) });
      }
      continue;
    }

    // Fetch nonce for this chain on first vault (or after a nonce error), then
    // manage locally.  We use "latest" rather than "pending" because on Arbitrum
    // the sequencer can pre-flight-reject reverted txs without including them in
    // a block, so the pending nonce can be stale / ahead of on-chain state.
    if (!nonceMap.has(chain)) {
      try {
        const client = getPublicClient(chain);
        const latest = await client.getTransactionCount({ address: account.address, blockTag: "latest" });
        nonceMap.set(chain, latest);
      } catch {
        // nonce fetch failed — let viem manage nonces automatically this run
      }
    }
    const currentNonce = nonceMap.get(chain);

    try {
      const result = await harvestVault(vault, walletCli, account, currentNonce, errorStreakThreshold);
      results.push(result);
      if (currentNonce !== undefined) {
        const errLow = (result.error ?? "").toLowerCase();
        const isNonceError = errLow.includes("nonce") && (errLow.includes("too high") || errLow.includes("too low") || errLow.includes("higher than") || errLow.includes("lower than"));
        if (isNonceError) {
          // Clear so the next vault re-fetches a fresh nonce from the RPC.
          nonceMap.delete(chain);
        } else if (result.success) {
          // Only a confirmed on-chain success definitively consumed a nonce.
          // Pre-flight-rejected reverts (shutdown, paused) are NOT included in
          // a block on Arbitrum, so their nonce is NOT consumed.
          nonceMap.set(chain, currentNonce + 1);
        }
        // All other errors (pre-flight revert, insufficient funds, etc.):
        // leave nonce unchanged so the next vault reuses it.
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.warn({ vault: vault.name, err: errMsg }, "Vault harvest threw");
      results.push({ vaultId: vault.id, vaultName: vault.name, chain, success: false, skipped: false, error: errMsg });
    }
  }

  // Accumulate actual (WETH-measured) profit, not the inflated callReward estimate.
  const successfulResults = results.filter(r => r.success);
  const totalActual = successfulResults.reduce((s, r) => s + (r.actualProfitUsd ?? 0), 0);
  _status.lastRunAt      = new Date();
  _status.lastRunResults = results;
  _status.runCount++;
  _status.totalEarnedUsd += totalActual;

  logger.info(
    {
      vaultsChecked: vaults.length,
      harvested: successfulResults.length,
      totalActualProfit: totalActual.toFixed(6),
    },
    "Harvester run complete"
  );

  const webhookUrl = await getWebhookUrl();

  // Fire webhook + SSE for profitable harvests (actualProfitUsd > 0, have a tx hash)
  const profitable = successfulResults.filter(r => (r.actualProfitUsd ?? 0) > 0 && r.txHash);
  if (profitable.length > 0) {
    const notifications: HarvestNotification[] = profitable.map(r => ({
      vaultId:         r.vaultId,
      vaultName:       r.vaultName,
      chain:           r.chain,
      txHash:          r.txHash!,
      actualProfitUsd: r.actualProfitUsd!,
      harvestedAt:     new Date().toISOString(),
    }));
    // Push each harvest immediately over SSE so no tab-closed gap
    for (const n of notifications) {
      broadcastSseEvent("harvest", n);
    }
    if (webhookUrl) {
      void fireWebhook(webhookUrl, notifications);
    }
  }

  // Fire webhook + SSE for vaults that just crossed the error-streak threshold
  const streakResults = results.filter(r => r.errorStreak);
  if (streakResults.length > 0) {
    const streakNotifications: ErrorStreakNotification[] = streakResults.map(r => ({
      vaultId:    r.vaultId,
      vaultName:  r.vaultName,
      chain:      r.chain,
      errorCount: errorStreakThreshold,
      lastError:  r.error ?? "unknown error",
      detectedAt: new Date().toISOString(),
    }));
    // Push each error streak immediately over SSE
    for (const s of streakNotifications) {
      broadcastSseEvent("error_streak", s);
    }
    if (webhookUrl) {
      void fireErrorStreakWebhook(webhookUrl, streakNotifications);
    }
  }

  return results;
}

// ── Live callReward query ─────────────────────────────────────────────────────

export interface VaultCallReward {
  id: number;
  name: string;
  chain: string;
  callRewardRaw: string;   // uint256 as decimal string
  callRewardUsd: number;   // raw (uncalibrated) USD estimate
  error?: string;
}

/** Read callReward() on-chain for every enabled vault simultaneously. */
export async function fetchCallRewards(): Promise<VaultCallReward[]> {
  const vaults = await db.select().from(defiVaultsTable).where(eq(defiVaultsTable.enabled, true));
  if (vaults.length === 0) return [];

  // Fetch native-token USD price for every chain that appears (5-min cached inside getEthUsd)
  const chains = [...new Set(vaults.map(v => v.chain))];
  const priceEntries = await Promise.all(chains.map(async c => [c, await getEthUsd(c)] as const));
  const prices = Object.fromEntries(priceEntries);

  const settled = await Promise.allSettled(
    vaults.map(async (vault): Promise<VaultCallReward> => {
      try {
        const strategy = await withFallback(vault.chain, c =>
          resolveStrategy(c, vault.vaultAddress as Address, vault.strategyAddress)
        );
        if (!strategy) {
          return { id: vault.id, name: vault.name, chain: vault.chain,
            callRewardRaw: "0", callRewardUsd: 0, error: "strategy not resolved" };
        }
        const bountyWei = await withFallback(vault.chain, c =>
          c.readContract({ address: strategy, abi: STRATEGY_ABI, functionName: "callReward" })
        ) as bigint;
        const ethPrice  = prices[vault.chain] ?? 2500;
        const callRewardUsd = parseFloat(formatEther(bountyWei)) * ethPrice;
        return { id: vault.id, name: vault.name, chain: vault.chain,
          callRewardRaw: bountyWei.toString(), callRewardUsd };
      } catch (e) {
        return { id: vault.id, name: vault.name, chain: vault.chain,
          callRewardRaw: "0", callRewardUsd: 0,
          error: e instanceof Error ? e.message : String(e) };
      }
    })
  );

  return settled.map((r, i) =>
    r.status === "fulfilled"
      ? r.value
      : { id: vaults[i]!.id, name: vaults[i]!.name, chain: vaults[i]!.chain,
          callRewardRaw: "0", callRewardUsd: 0, error: String(r.reason) }
  );
}
