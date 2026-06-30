// Public RPC endpoints — no key required. For production, swap in Alchemy/Infura.
export const RPC_URLS: Record<string, string> = {
  ethereum: process.env["ETH_RPC_URL"] ?? "https://ethereum.publicnode.com",
  base:     process.env["BASE_RPC_URL"] ?? "https://base.publicnode.com",
  arbitrum: process.env["ARB_RPC_URL"]  ?? "https://arbitrum-one.publicnode.com",
};

export const CHAIN_IDS: Record<string, number> = {
  ethereum: 1,
  base:     8453,
  arbitrum: 42161,
};

export const EXPLORER_BASE: Record<string, string> = {
  ethereum: "https://etherscan.io/tx",
  base:     "https://basescan.org/tx",
  arbitrum: "https://arbiscan.io/tx",
};
