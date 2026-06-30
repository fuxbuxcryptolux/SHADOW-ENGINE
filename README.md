# Shadow Harvester

Standalone DeFi yield harvester stripped from Shadow Engine.
Focuses exclusively on making money: harvest → swap → compound.

## What it does

**Harvester** (every 5 min)
- Checks all enabled Beefy vaults across Base, Arbitrum, BSC, Polygon
- Reads `callReward()` from each strategy contract
- Fires `harvest(walletAddress)` only when net profit > vault threshold
- Uses block-pinned balance deltas for accurate profit measurement
- Calibrates itself after each harvest to improve future estimates

**Auto-Swap** (after each profitable harvest)
- Converts earned WETH → USDC via Aerodrome on Base
- Only triggers when WETH balance > $0.50 (configurable)
- 1% slippage protection

**Arb Scanner** (every 6 hrs, read-only)
- Tracks price spreads across chains via DefiLlama
- Surfaces opportunities > 0.5% spread to dashboard
- No execution risk — data only

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/health | Server status |
| GET | /api/defi/status | Wallet + last run results |
| GET | /api/defi/vaults | All vaults |
| POST | /api/defi/vaults | Add vault |
| PATCH | /api/defi/vaults/:id | Update vault (enabled, minProfit) |
| DELETE | /api/defi/vaults/:id | Remove vault |
| POST | /api/defi/harvest | Trigger harvest now |
| GET | /api/defi/vaults/rewards | Live callReward() for enabled vaults |
| GET | /api/defi/pnl-history | Daily P&L chart data |
| GET | /api/defi/audit | Ticker metrics |
| POST | /api/defi/discover | Discover Beefy vaults (chain param) |
| GET | /api/stats | Unified P&L + swap + arb summary |
| GET | /api/stats/pnl-history | Daily P&L with gas breakdown |
| POST | /api/swap/trigger | Manual WETH → USDC swap |
| GET | /api/swap/last | Last swap result |
| GET | /api/arb | Arb snapshots from DB |
| POST | /api/arb/scan | Trigger arb scan now |

## Setup

```bash
# 1. Install
npm install

# 2. Configure
cp .env.example .env
# Edit .env with your DATABASE_URL and HARVESTER_PRIVATE_KEY

# 3. Push DB schema
npm run db:push

# 4. Dev
npm run dev

# 5. Production
npm run build && npm start
```

## Deploy to Railway (free)

1. Push this folder to GitHub
2. Connect repo to Railway (railway.app)
3. Add env vars from .env.example in Railway dashboard
4. Deploy — Railway auto-detects Node and runs `npm run build && npm start`

## Vault discovery

```bash
# Find profitable Base vaults
curl -X POST http://localhost:3000/api/defi/discover \
  -H "Content-Type: application/json" \
  -d '{"chain":"base"}'

# Find profitable BSC vaults (higher call fees)
curl -X POST http://localhost:3000/api/defi/discover \
  -H "Content-Type: application/json" \
  -d '{"chain":"bsc"}'
```

## Profit pipeline

```
Beefy Vault callReward() accumulates
        ↓ (every 5 min check)
Harvester fires harvest(walletAddress)
        ↓ (WETH lands in wallet)
Auto-swap converts WETH → USDC on Aerodrome
        ↓ (USDC accumulates)
Manual: deploy USDC into Morpho/Aave for yield
```
