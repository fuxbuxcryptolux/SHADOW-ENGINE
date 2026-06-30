/**
 * autoSwap.ts — post-harvest WETH → USDC compounder
 *
 * After a profitable harvest lands WETH in the harvester wallet,
 * swaps it to USDC on Aerodrome (Base) when balance > AUTO_SWAP_MIN_USD.
 *
 * Aerodrome Router: 0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43
 * WETH (Base):      0x4200000000000000000000000000000000000006
 * USDC (Base):      0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  formatUnits,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { logger } from "./logger.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const AERODROME_ROUTER: Address = "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43";
const AERODROME_FACTORY: Address = "0x420DD381b31aEf6683db6B902084cB0FFECe40D";
const WETH_BASE: Address        = "0x4200000000000000000000000000000000000006";
const USDC_BASE: Address        = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const CHAINLINK_ETH_USD: Address = "0x71041dddad3595F9CEd3dCCFBe3D1F4b0a16Bb70";

const MIN_SWAP_USD  = parseFloat(process.env["AUTO_SWAP_MIN_USD"] ?? "0.50");
const SLIPPAGE_BPS  = 100n; // 1%

// ── ABIs ──────────────────────────────────────────────────────────────────────

const ERC20_ABI = parseAbi([
  "function balanceOf(address owner) external view returns (uint256)",
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) external view returns (uint256)",
]);

const ROUTER_ABI = parseAbi([
  "function getAmountsOut(uint256 amountIn, (address from, address to, bool stable, address factory)[] routes) external view returns (uint256[] amounts)",
  "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, (address from, address to, bool stable, address factory)[] routes, address to, uint256 deadline) external returns (uint256[] amounts)",
]);

const CHAINLINK_ABI = parseAbi([
  "function latestRoundData() external view returns (uint80, int256 answer, uint256, uint256, uint80)",
]);

// ── Helpers ───────────────────────────────────────────────────────────────────

function getAccount() {
  const raw = process.env["HARVESTER_PRIVATE_KEY"];
  if (!raw) return null;
  try { return privateKeyToAccount((raw.startsWith("0x") ? raw : `0x${raw}`) as `0x${string}`); }
  catch { return null; }
}

function getClients() {
  const account = getAccount();
  if (!account) return null;
  const rpc = process.env["HARVESTER_RPC_BASE"] ?? "https://mainnet.base.org";
  return {
    pub: createPublicClient({ chain: base, transport: http(rpc) }),
    wal: createWalletClient({ account, chain: base, transport: http(rpc) }),
    account,
  };
}

async function getEthUsd(pub: ReturnType<typeof createPublicClient>): Promise<number> {
  try {
    const [, answer] = await pub.readContract({
      address: CHAINLINK_ETH_USD, abi: CHAINLINK_ABI, functionName: "latestRoundData",
    }) as [bigint, bigint, bigint, bigint, bigint];
    return Number(answer) / 1e8;
  } catch { return 1580; }
}

// ── Swap result type ──────────────────────────────────────────────────────────

export interface SwapResult {
  swapped: boolean;
  reason?: string;
  wethIn?: string;
  usdcOut?: string;
  txHash?: string;
  error?: string;
  timestamp: string;
}

let _lastSwap: SwapResult | null = null;
export function getLastSwap(): SwapResult | null { return _lastSwap; }

// ── Main export ───────────────────────────────────────────────────────────────

export async function autoSwapWethToUsdc(): Promise<SwapResult> {
  const timestamp = new Date().toISOString();

  if (process.env["AUTO_SWAP_ENABLED"] !== "true") {
    return { swapped: false, reason: "AUTO_SWAP_ENABLED not set to true", timestamp };
  }

  const clients = getClients();
  if (!clients) return { swapped: false, reason: "No wallet configured", timestamp };
  const { pub, wal, account } = clients;

  try {
    const wethBal = await pub.readContract({
      address: WETH_BASE, abi: ERC20_ABI,
      functionName: "balanceOf", args: [account.address],
    }) as bigint;

    const ethUsd = await getEthUsd(pub);
    const wethUsd = parseFloat(formatUnits(wethBal, 18)) * ethUsd;

    if (wethUsd < MIN_SWAP_USD) {
      const result = { swapped: false, reason: `WETH $${wethUsd.toFixed(4)} < threshold $${MIN_SWAP_USD}`, timestamp };
      _lastSwap = result;
      return result;
    }

    const route = [{ from: WETH_BASE, to: USDC_BASE, stable: false, factory: AERODROME_FACTORY }];

    const amounts = await pub.readContract({
      address: AERODROME_ROUTER, abi: ROUTER_ABI,
      functionName: "getAmountsOut", args: [wethBal, route],
    }) as bigint[];

    const expectedUsdc = amounts[amounts.length - 1]!;
    const minUsdc = expectedUsdc * (10000n - SLIPPAGE_BPS) / 10000n;

    // Approve if needed
    const allowance = await pub.readContract({
      address: WETH_BASE, abi: ERC20_ABI,
      functionName: "allowance", args: [account.address, AERODROME_ROUTER],
    }) as bigint;

    if (allowance < wethBal) {
      const approveTx = await wal.writeContract({
        address: WETH_BASE, abi: ERC20_ABI,
        functionName: "approve", args: [AERODROME_ROUTER, wethBal],
      });
      await pub.waitForTransactionReceipt({ hash: approveTx });
    }

    const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
    const swapTx = await wal.writeContract({
      address: AERODROME_ROUTER, abi: ROUTER_ABI,
      functionName: "swapExactTokensForTokens",
      args: [wethBal, minUsdc, route, account.address, deadline],
    });
    await pub.waitForTransactionReceipt({ hash: swapTx });

    const result: SwapResult = {
      swapped: true,
      wethIn: formatUnits(wethBal, 18),
      usdcOut: formatUnits(expectedUsdc, 6),
      txHash: swapTx,
      timestamp,
    };
    _lastSwap = result;
    logger.info(result, "Auto-swap complete");
    return result;

  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const result = { swapped: false, error, timestamp };
    _lastSwap = result;
    logger.warn({ err }, "Auto-swap failed");
    return result;
  }
}
