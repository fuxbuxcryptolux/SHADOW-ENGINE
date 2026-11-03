# Shadow Harvester 2.0 — Staged Implementation Plan

- **Status:** Planning only; no implementation authorized
- **Date:** 2026-11-03
- **Basis:** [ADR 0001: Single-operator, two-wallet architecture](0001-single-operator-two-wallet-architecture.md)
- **Repository inspected:** `chatgpt-handoff` at `6cb17b9b46d8feb8d49907c0d871591179a35ff0`

## Goal and boundaries

Deliver a personal, one-operator system whose default operation is read-only, retaining multi-chain and multi-protocol intelligence. Use two dedicated wallets: the Operating Wallet for explicitly authorized execution and the Treasury Wallet for received, accumulated realized proceeds. Neither wallet is a primary personal wallet. Do not add multi-user authentication, tenant separation, subscription, or commercialization infrastructure before sustainable personal profitability is demonstrated.

This document is a plan, not authorization to change code, schemas, wallet configuration, or runtime behavior. No wallet creation or key handling, RPC calls, or transactions were performed for this investigation. Any future testnet or mainnet interaction requires its own explicit safety approval.

## Prioritized task sequence and dependencies

1. **Stage 1 — Read-only intelligence.** Establish a scanner boundary with no signer or transaction capability. This is the foundation for all later stages.
2. **Stage 2 — Economic accuracy.** Make token identity, decimals, reward valuation, gas, fees, slippage, and historical net profit traceable and internally consistent. Depends on Stage 1's stable opportunity and observation model.
3. **Stage 3 — Operating Wallet.** Design and then implement an isolated transaction authorization boundary for harvest, approval, and swap. Depends on Stages 1 and 2, plus resolved authorization, custody, and API exposure questions.
4. **Stage 4 — Treasury.** Design verified realized-profit accounting and safe transfers to the separate Treasury Wallet. Depends on Stage 2's accounting and an explicit decision about who authorizes/signs transfers.
5. **Stage 5 — Validation.** Backtest, test, testnet-verify, exercise recovery, and decide readiness. Validation criteria apply across all stages; any mainnet readiness decision depends on all prior gates and separate approval.

Each stage is a release gate: acceptance criteria must be met and evidence reviewed before the next stage begins. Multi-chain and multi-protocol breadth must grow through verified adapters and data coverage, not by weakening source, valuation, or authorization checks.

## Code map and investigation

### 1. Vault discovery and opportunity scanning

**Existing implementation:** `src/lib/harvester.ts` (`discoverBeefyVaults`) fetches Beefy vault, TVL, APY, and fee data and inserts up to 50 ranked candidates for Base, Arbitrum, BSC, or Polygon, initially disabled. `src/lib/arbScanner.ts` fetches DefiLlama yield pools, filters symbols and three chains, and persists apparent cross-chain spreads. `src/routes/defi.ts` exposes a Beefy discovery route; `src/routes/arb.ts` exposes scan and snapshot routes. The harvest chain config also includes Ethereum.

**Verified limitations:** Discovery is Beefy-specific, while the stored `protocol` field is not an implemented adapter system. Chain coverage differs by feature. The arbitrage scanner labels APY differences as price spreads and USD opportunity size, despite not comparing token prices; its CoinGecko helper constructs a chain-token URL but does not use it. Symbol substring matching and taking the first 20 candidates can conflate assets or produce order-dependent selection. Scanner/API errors can collapse into empty results, making “no opportunity” hard to distinguish from “data unavailable.”

**Required changes and dependencies:** Define canonical chain, protocol, vault, token, and market identifiers; build read-only data-source adapters with explicit provenance, timestamps, freshness, and failure states. Separate yield discovery from actual price/spread analysis. Require matching token contract identities (or a documented bridge/representation relationship), comparable quote units, executable-size depth, and route cost before calling something an opportunity. Validate discovery input and persisted addresses. Depends on Stage 1 data contracts and a documented supported-chain/protocol registry.

**Tests and acceptance:** Fixture tests cover supported/unsupported chains, duplicate vaults, malformed API payloads, case normalization, symbol collisions, stale/partial feeds, and timeouts. Scanner tests prove APY changes alone never create a price-arbitrage signal. Acceptance: at least one verified adapter per declared launch chain/protocol; every emitted opportunity carries source, observation time, canonical asset identity, and confidence/freshness state; unavailable data is visibly distinct from zero opportunity; scanner import graph has no signer or transaction-writing capability.

### 2. Reward token identification and valuation

**Existing implementation:** `detectRewardToken` tries `output()` and `rewardToken()` and otherwise assumes wrapped native token. `callReward()` is converted with `formatEther`; reward balance deltas are also converted with 18 decimals. `getEthUsd` reads a Chainlink feed and falls back to a cached value or `$2500`. `fetchCallRewards` repeats the `formatEther` assumption. The swap path separately assumes WETH has 18 decimals and USDC has 6.

**Verified limitations:** A strategy's reported token identity is not enough to establish which asset/units `callReward()` returns. Non-18-decimal tokens are misvalued. Arbitrary reward tokens are priced as native ETH, rather than by their own verified market price. Oracle decimals and update freshness/round validity are not checked. Hard-coded price fallbacks can make stale or unavailable quotes look valid. The fallback token may be wrong for a protocol/chain.

**Required changes and dependencies:** Establish a token metadata registry/cache keyed by chain ID and contract address; verify decimals, symbol as display-only metadata, quote source, and observation block/time. Define supported reward semantics per protocol adapter and reject unsupported/ambiguous units. Add oracle freshness, answer, round, and fallback policy; represent unknown valuation explicitly. Use integer/base-unit arithmetic through calculations and round only for display. Depends on adapter identities from Stage 1 and price-source policy for Stage 2.

**Tests and acceptance:** Unit tests cover 6/8/18-decimal tokens, large integer precision, negative/zero/stale oracle answers, malformed metadata, unsupported reward methods, and unavailable prices. Acceptance: every reward amount resolves to a chain/address/decimals/unit and auditable price source; no guessed fallback can qualify an opportunity for execution; all unresolved amounts are shown as unvalued.

### 3. Gas estimation and profitability calculations

**Existing implementation:** `harvestVault` estimates gas with a 20% buffer, then falls back to `400,000` gas and `0.1 gwei`; it converts using native-token USD. The no-key read-only branch uses a fixed 400,000 gas estimate. `autoSwap.ts` has a fixed 1% slippage tolerance and a configurable minimum swap USD value.

**Verified limitations:** Gas estimation passes `STRATEGY_ABI`, which declares `callReward` and `paused` but not either `harvest` signature, so the intended estimate path is inconsistent with the ABI and can fall through to the fallback. Gas-price and native-price fallbacks can understate cost or present stale data as current. Profitability omits protocol/DEX fees, price impact, route costs, and explicit uncertainty bounds. Estimated gas is used for the stored realized-profit calculation even though receipt gas usage/effective price is available. Swap output is valued from a router quote and configured slippage but has no independent post-trade reconciliation.

**Required changes and dependencies:** Build a shared, versioned economic calculation using correct call ABI, gas limit and fee model per chain, current native-token price, reward valuation, protocol fees, DEX fees, price impact, and slippage bounds. Distinguish estimate from realized receipt cost and expose missing/stale inputs. Define minimum net-profit and uncertainty margins per operation. Depends on verified metadata/valuation in Stage 2 and route simulation/quotes for swaps.

**Tests and acceptance:** Deterministic tests for fee arithmetic, chain fee models, buffers, decimal conversion, fee/slippage aggregation, unavailable inputs, and threshold boundaries. Compare estimator outputs to recorded historical receipts without sending transactions. Acceptance: an opportunity is never marked profitable with missing required inputs; estimated and realized costs are distinct; net return is calculated once and includes all modeled costs and stated uncertainty.

### 4. Harvest transaction preparation and execution

**Existing implementation:** `runHarvester` loads enabled vaults and reads strategy, pause, reward, price, and gas data when no key is configured. With `HARVESTER_PRIVATE_KEY`, it creates a wallet client and `harvestVault` writes either `harvest(address)` or `harvest()`, then waits for a receipt. It snapshots reward/native balances and updates vault state/history. `/api/defi/harvest` and `/api/defi/vaults/:id/harvest` call this path.

**Verified limitations:** A configured environment key automatically enables scheduled harvesting; a manual route can trigger it as well. The harvest path explicitly skips transaction simulation. The no-key read-only behavior exists inside the same module as the signer and is not a capability boundary. The single-vault route temporarily enables the vault and calls the all-enabled-vault runner, so it may process other enabled vaults too. Routes that can trigger execution have no visible authentication/authorization middleware; global CORS is open. A failed first write attempt is caught and followed by another signature variant, with no explicit transaction intent/approval record.

**Required changes and dependencies:** Keep Stage 1 scanner process/module free of account derivation, wallet clients, write actions, and transaction RPC methods. Later create a separate Operating Wallet service boundary that accepts a fully specified, policy-checked intent only after operator confirmation. Prepare and simulate exact target/calldata/value/chain, show the resulting transaction and costs, enforce allowlists/limits, expire and consume approvals once, and record idempotency/receipt state. Resolve whether execution uses a separately managed signer or a user-approved signing device without collecting raw keys in app code. Restrict execution endpoints to the sole operator and private deployment boundary. Depends on Stages 1–2, API security design, and explicit signing/custody decision.

**Tests and acceptance:** Tests prove read-only configurations cannot instantiate or reach signer/write code; reject wrong chain/target/calldata/value, expired/replayed approvals, disabled vaults, and stale profitability data; simulate reverts and uncertain submission outcomes. Acceptance: default deployment has no signer capability; every transaction has one explicit operator authorization tied to an immutable intent; no automatic retry can produce a second transaction; no public/unauthorized route can execute.

### 5. Approval and swap logic

**Existing implementation:** `src/lib/autoSwap.ts` reads the Operating-key-derived account's Base WETH balance, requests an Aerodrome quote, approves the router for the full balance when allowance is insufficient, and swaps with a five-minute deadline and 1% minimum-output haircut. `/api/swap/trigger` exposes it. `AUTO_SWAP_ENABLED` gates the function, but no call site from `harvester.ts` was found despite scheduler comments describing post-harvest swaps.

**Verified limitations:** Approval and swap are transaction-capable through the same environment key and trigger endpoint. Approval is unlimited only to the current balance but lacks an explicit operator approval step, allowance expiry/revocation policy, or operator-facing intent review. A single hard-coded Base route/token pair does not cover retained multi-chain/protocol scope. The response reports quoted `expectedUsdc`, not receipt-measured output. Price fallback is hard-coded. No automatic post-harvest invocation was found; current implementation and comments disagree.

**Required changes and dependencies:** Stage 2 first establishes trustworthy token metadata, executable quote, impact, and total cost. Stage 3 routes each approval and swap through the same isolated Operating Wallet authorization boundary, with explicit spender/token/amount and exact output floor; use least allowance and provide a revocation plan. Make swap proposal and execution separate actions, and reconcile receipt/events and balance changes after execution. Decide whether swaps are ever automatic; ADR 0001 requires explicit authorization for swap transactions. Depends on Stages 2–3 and approved transaction policy.

**Tests and acceptance:** Tests cover quote expiry, route/chain/token mismatches, exact allowance amount, failed/reverted approval, insufficient output, balance changes, duplicate trigger, and receipt reconciliation. Acceptance: no approval or swap can occur without a specific authorization; the user sees spender, assets, amounts, minimum output, fees, and deadline; recorded output comes from verified execution evidence.

### 6. Scheduler and concurrent execution

**Existing implementation:** `src/lib/scheduler.ts` schedules harvest every five minutes only when the key exists and an arb scan every six hours regardless. `safeRun` logs and catches failures. Each harvester invocation walks enabled vaults sequentially and locally tracks nonces by chain. Manual API calls can start additional runs.

**Verified limitations:** `setInterval` does not prevent a prior run from overlapping the next scheduled run. Manual and scheduled calls can overlap, contend for the same vault/account/nonce, or duplicate work. The scheduler disables harvest scanning when no key is configured, despite the harvester's read-only branch. Scheduler comments say swaps run after harvest, but no such invocation is present. There is no durable job/intent lock or per-chain transaction queue.

**Required changes and dependencies:** Stage 1 schedules only read-only scans independent of any signer variable. Use single-flight scheduling, bounded per-chain/per-vault concurrency, cancellation/timeouts, and durable idempotency/locks where needed. In Stage 3, execution queueing and nonce management must be isolated per Operating Wallet and chain, with reconciliation before retry. Depends on scanner boundary, then transaction lifecycle state.

**Tests and acceptance:** Fake-timer tests cover missed/overlapping intervals, simultaneous manual requests, lock expiry, cancellation, partial failures, and restart recovery. Acceptance: duplicate invocations cannot create duplicate opportunities or execution intents; read-only schedules always run without a signer; signing remains impossible from a scheduler job without a separately approved intent.

### 7. Harvest history and P&L accounting

**Existing implementation:** The history table stores one row with `actualEarnedUsd`, `gasUsd`, tx hash, chain, vault, and time. `harvestVault` sets `actualProfitUsd = rewardReceivedUsd - estimated gasUsd`, stores that as `actualEarnedUsd`, and also stores gas separately. `/api/stats` computes `netPnl = sum(actualEarnedUsd) - sum(gasUsd)`. `/api/defi/pnl-history` sums `actual_earned_usd` alone. `/api/defi/audit` uses vault aggregate totals for P&L labels.

**Verified limitations:** Because `actualEarnedUsd` receives a value already net of gas and stats subtracts `gasUsd` again, aggregate `/api/stats` appears to deduct gas twice. The daily DeFi P&L endpoint does not subtract its separately stored gas. The value named “actual” is based on estimated gas instead of receipt gas, and the token-to-USD mark methodology is not persisted. Current history stores neither raw token deltas/decimals nor price source/block and fee detail. The history FK uses `ON DELETE CASCADE`, so deleting a vault deletes its history despite the schema comment saying history is preserved after vault edits/resets. Vault aggregate update and history insert are separate writes and are not one transaction; uniqueness/idempotency for `(chain, txHash)` is absent.

**Required changes and dependencies:** Define a canonical event ledger: gross realized token proceeds and valuation metadata, actual receipt gas, protocol/DEX fees, other costs, net realized P&L, chain, tx hash/status, block, and timestamps. Name each field by gross/net semantics and calculate totals in one shared query/service. Make persistence idempotent by chain+tx hash and atomic across event and aggregates; choose retention/deletion semantics that preserve audit history. Depends on Stage 2 valuation and execution receipt lifecycle.

**Tests and acceptance:** Fixture ledger tests reconcile raw token amounts and receipt costs to per-event and aggregate net values; verify duplicate receipt handling, reverted/unconfirmed transactions, vault deletion, UTC daily buckets, and rounding. Acceptance: gross proceeds minus each modeled realized cost equals net exactly once; all API P&L endpoints agree for the same interval; every figure traces to its event and valuation inputs.

### 8. Database persistence and API exposure

**Existing implementation:** Drizzle schemas define vaults, harvest history, settings, price snapshots, and activity. `src/db/index.ts` connects at import time and configures a pool of ten. Express mounts the DeFi, swap, arb, and stats routes with global CORS and no visible authentication middleware. Several GET routes return vault/configuration data; POST routes trigger scans, discovery, harvest, swaps, updates, and resets. Settings include a webhook URL; the GET settings endpoint returns it. Some reset/settings routes check only the static `x-shadow-internal: 1` header.

**Verified limitations:** The inspected app has no visible single-operator authentication or authorization layer; a static header is not operator identity. Trigger routes are exposed without the internal-header check. The public status endpoint returns wallet address/configured state. The webhook URL is returned through an API and can contain credentials; the prior audit also notes full URL logging on delivery. API input validation for addresses, protocol/chain combinations, numeric values, and query bounds is uneven. Discovery and writes can happen from HTTP handlers. Existing schema lacks token metadata, source provenance, transaction intents/approvals, detailed realized event evidence, and robust uniqueness for receipts.

**Required changes and dependencies:** Before Stage 3, place all mutation and execution routes behind a sole-operator access control appropriate to the deployment; enforce server-side authorization per action, strict validation, safe error responses, and rate/concurrency controls. Return secret-free settings, redact secret-bearing URL components in logs, and avoid exposing wallet configuration details unnecessarily. Add persistence only after the data/event contracts are approved; use transactions and idempotency. No tenant or subscription layer is needed. Depends on explicit deployment/access-control decision, then Stages 1–4 data models.

**Tests and acceptance:** Route tests prove unauthenticated callers cannot mutate settings, vaults, execute actions, or read secrets; validation tests cover invalid chain/address/amount/body; serialization tests ensure no private credential or webhook credential appears. Database tests cover atomic event persistence, idempotency, and retention. Acceptance: the single operator is the only principal capable of authorizing changes/execution; no raw private key is accepted or stored; API and logs expose no secrets; all state transitions have an audit record.

## Stage gates and exit criteria

### Stage 1 — Read-only intelligence

Build the multi-chain, multi-protocol scanner as a read-only capability with no signer or transaction capability. Remove signing from its import/runtime boundary; scanner jobs must run whether or not any wallet is configured. Opportunity outputs must identify source, chain, protocol, canonical assets, observation time, and data quality. This stage can persist scan observations to the database, but must never sign or submit blockchain transactions.

**Gate:** Static dependency audit and tests prove scanner modules cannot construct accounts, wallet clients, or invoke transaction-writing methods. Any future transaction route is unavailable in the Stage 1 deployment. Opportunity labels pass the source/identity/freshness criteria above.

### Stage 2 — Economic accuracy

Implement tested token metadata, supported reward semantics, valuation/oracle freshness, chain gas models, fees, slippage, and shared profitability calculations. Reconcile historical events against source receipts where evidence exists; identify records that cannot be corrected reliably and label them accordingly rather than silently restating them.

**Gate:** Independent fixtures reproduce every calculation; stale or missing inputs fail closed; all P&L views agree and separate estimates from realized values. No transaction capability is enabled by this stage.

### Stage 3 — Operating Wallet

Design the isolated boundary first. The Operating Wallet is dedicated, holds limited execution/gas funds, and is used only for individually authorized harvest, approval, and swap transactions. Require authenticated single-operator access, transaction preview, simulation, limits, expiry, idempotency, receipt reconciliation, and recovery procedures. The application must not store or request private keys in frontend code, database records, GitHub, logs, or prompts.

**Gate:** Written signing/custody and authorization decisions approved; negative tests show all missing/invalid/replayed approvals fail closed; no transaction is sent before an operator reviews the exact chain, target, method, amounts, limits, and expected costs. Any testnet send requires separate explicit authorization.

### Stage 4 — Treasury

Design a verified realized-profit ledger and transfer eligibility rule. Before a transfer, subtract/reserve gas, fees, slippage, and outstanding obligations from verified realized proceeds. Treasury is a separate dedicated receiving/storage wallet and never participates in routine automated signing. Define reconciliation, failed-transfer, duplicate-transfer, and destination verification behavior.

**Gate:** Decide which component/wallet can authorize and sign a transfer; ADR 0001 does not explicitly assign a transfer signer. Prove the transferable amount cannot exceed verified net available proceeds and cannot include estimates or reserved obligations. A transfer testnet send requires separate explicit authorization.

### Stage 5 — Validation and readiness

- **Historical backtesting:** Replay timestamped historical observations with contemporaneous prices, gas, fees, liquidity, and protocol rules; model data gaps, failed calls, slippage, and chain conditions. Prevent look-ahead bias; compare simulated and realized outcomes and report uncertainty, drawdown, failure rate, and net profitability by chain/protocol.
- **Test coverage:** Unit tests for arithmetic, token metadata, source adapters, authorization policies, and ledger math; integration tests with mocked chain/data providers and database; API authorization/secret-exposure tests; concurrency, retries, idempotency, and recovery tests. No test should require a live secret or default to a live network.
- **Testnet verification:** Only after Stages 1–4 gates and separate approval, use dedicated test-only configuration and funds; verify preparation, authorization, signing boundary, receipt accounting, failure/retry, and treasury reconciliation. Testnet success is not mainnet authorization.
- **Failure recovery:** Document and exercise provider outages, stale/malformed data, nonce conflict, uncertain submission, reorg/reverted receipt, database outage after receipt, duplicate event, signer outage, and emergency disable/revoke procedures. Recovery must never retry an uncertain transaction blindly.
- **Mainnet readiness:** Require sustained backtest and paper-mode profitability under conservative costs; independent review of wallet separation, endpoint access, limits, logs, database recovery, and all safety gates; operational monitoring and incident/disable procedures; explicit owner approval for deployment and separately for any unattended capability. Readiness criteria do not themselves authorize a mainnet transaction.

## Prioritized task sequence

1. Freeze a read-only inventory of supported chains, protocols, assets, sources, and current data quality; agree on canonical opportunity and valuation fields.
2. Replace the APY-based “arbitrage” signal with identity-matched price and executable-size analysis; separate yield opportunities from cross-chain spreads.
3. Add adapter fixtures and read-only scanner tests; prove scanner import graph has no signer/write capability and schedule it without wallet configuration.
4. Specify token metadata, oracle freshness, reward-unit, gas/fee, and slippage policies; implement a deterministic economic model with failure-closed unknowns.
5. Define event-ledger gross/net semantics and reconcile current P&L endpoints; specify idempotent receipt persistence and history-retention policy.
6. Complete single-operator API access control and secret-free API/log behavior before enabling any execution path.
7. Write Operating Wallet authorization/custody and transaction lifecycle design; test a disabled-by-default boundary before considering testnet.
8. Resolve transfer signer/authorization and Treasury reconciliation design; implement only after separate approval.
9. Execute Stage 5 historical, test, recovery, and explicitly approved testnet validation; submit a separate readiness decision before any mainnet use.

## Unresolved design questions

1. Which chain/protocol adapters are the initial supported set, and what evidence qualifies an adapter as verified?
2. What price sources and fallback policy are acceptable per asset/chain, and what maximum observation age is allowed?
3. What is the canonical definition of realized proceeds and net profit, including treatment of taxes, protocol fees, failed transactions, and valuation time?
4. What explicit operator confirmation UX and server-side identity/access mechanism will gate each action in a one-operator deployment?
5. What signing/custody mechanism can satisfy key-handling constraints without placing raw private keys in the application?
6. What per-chain/token/protocol allowlists, balance caps, gas caps, slippage caps, and transaction limits apply to the Operating Wallet?
7. Are swaps always individually authorized, or is any narrowly bounded conditional execution intended? ADR 0001 currently requires explicit authorization for swaps.
8. Who authorizes/signs a transfer to Treasury, from which wallet, and under what transfer limit? ADR 0001 defines receipt/storage but does not assign this role.
9. What retention policy preserves the forensic transaction ledger if a vault is removed or renamed?
10. What minimum historical sample size and duration demonstrate sustainable personal profitability before deferred product capabilities are reconsidered?

## Safety gates

- Read-only remains the default at every stage; Stage 1 has no signer or transaction code path.
- One operator only; no tenant, multi-user, subscription, or commercialization work in this plan.
- Use two dedicated wallets only; never use primary personal wallets for application operations.
- No private keys in frontend code, database records, GitHub, logs, or prompts. Do not request keys or create/configure wallets as part of this plan.
- No unattended execution unless separately designed, narrowly permissioned, and explicitly authorized.
- No testnet or mainnet transaction without separate explicit approval. No mainnet readiness decision implies transaction authorization.
- Do not advance a stage with missing/stale valuation inputs, unverified realized proceeds, unresolved transaction status, or incomplete operator authorization.
- Any later source/schema implementation, commit, push, or merge requires separate authorization.

## Investigation record

Static source/schema/API inspection only. No application or database changes, tests, wallet creation/configuration, key handling, RPC calls, or transactions were performed for this plan.
