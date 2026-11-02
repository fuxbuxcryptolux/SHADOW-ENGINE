# Shadow Harvester 2.0 — Wallet Architecture Investigation

**Date:** 2026-11-02  
**Repository:** SHADOW-ENGINE  
**Branch / inspected commit:** `main` / `87329b3d50273bd0a1095222f7a6a7ef5e6adb42`  
**Method:** Read-only static inspection of tracked source/configuration and archive member names. No credentials were printed or requested. No wallet was connected; no transaction, install, database, or RPC action was performed.

## Executive conclusion

The checked-in project does not implement end-user wallet connection. It uses a single backend EOA derived from the `HARVESTER_PRIVATE_KEY` environment variable. The harvester and swap modules use that same account to sign transactions. The status API returns the account's public address and whether the backend key is configured. There is no user identity, wallet ownership record, tenant separation, or browser-wallet signing in the inspected repository.

The private key is read by backend code and is not explicitly written to the database, API responses, or logs in the inspected paths. This does not assess deployment secret handling. The code does return the wallet address. Separately, webhook URLs are stored in the generic settings table and returned by an API route; URLs containing embedded credentials could be exposed through responses and delivery logs.

## Scope and evidence boundary

The tracked tree contains backend TypeScript, database schemas, configuration, and a README. It contains no tracked frontend source. The `shadow_harvester.tar.gz` member listing also contains no frontend source; its `.env.example` contains the variable name `HARVESTER_PRIVATE_KEY` (values were not displayed). The README describes a dashboard, but that UI is not present in this checkout/archive. A separately hosted or untracked frontend cannot be assessed here.

All “verified” statements below describe source/configuration behavior. Deployment settings, actual production reachability, database contents, log retention, and any external frontend remain unverified.

## Findings

### 1. User wallet connection/configuration

- **Files:** No frontend files appear in the tracked repository or archive. `README.md:47-64` documents operator setup; `README.md:53-56` instructs configuring `DATABASE_URL` and `HARVESTER_PRIVATE_KEY`.
- **Behavior:** There is no in-app wallet connection flow in the inspected project. Wallet configuration is an environment/deployment operation.
- **Status:** **Verified** for the inspected checkout/archive. A separate frontend outside this scope is unknown.

### 2. Wallet addresses in the database

- **Files:** `src/db/schema/wallets.ts:1-19`; `src/db/schema/defi.ts:8-34,43-54`; `src/lib/harvester.ts:637-667`.
- **Behavior:** `wallets.ts` defines `price_snapshots`, and its comment says wallet/airdrop-claim tables were dropped (`:3-5`). The DeFi schema holds vault records and harvest history. Harvest persistence records vault identifiers, chain, transaction hash, and accounting values; it does not persist the signing wallet address. No user-wallet schema was found.
- **Status:** **Verified** for checked-in schema/persistence code.

### 3. Private key request, storage, and transmission

- **Files:** `src/lib/harvester.ts:158-166`; `src/lib/autoSwap.ts:54-59`; `README.md:53-56`; archive member `harvester/.env.example` (variable names inspected only).
- **Behavior:** The backend reads `HARVESTER_PRIVATE_KEY` and passes it to viem's `privateKeyToAccount`. No inspected frontend/API handler requests the key. No code was found writing it to the database, returning it in an API response, or sending the key itself over HTTP. Backend signing produces signed transactions which are submitted via RPC.
- **Status:** **Verified** in inspected code paths. Runtime/deployment secret handling and third-party infrastructure are **not assessed**.

### 4. Backend environment key and scheduling

- **Files/functions:** `src/lib/harvester.ts:158-168` (`getAccount`); `src/lib/autoSwap.ts:54-69` (`getAccount`, `getClients`); `src/lib/scheduler.ts:29-38` (`startScheduler`).
- **Behavior:** Both execution modules read the same process environment variable. The scheduler starts harvest jobs when it is set. Auto-swap also derives an account from it.
- **Status:** **Verified**.

### 5. Frontend signing capability

- **Files:** No frontend source or browser-wallet integration appears in tracked files or the archive. `package.json:14-21` lists server project dependencies, including viem.
- **Behavior:** No browser wallet connection/signing code is present in the inspected project. The signing capability is in the backend.
- **Status:** **Verified** for inspected files; an external frontend is unknown.

### 6. Browser versus backend signing

- **Files/functions:** `src/lib/harvester.ts:199-207` (`getWalletClient`), `:471-500` (harvest writes); `src/lib/autoSwap.ts:61-69` (`getClients`), `:140-154` (approval and swap writes).
- **Behavior:** The backend constructs viem wallet clients with the environment-derived account and calls `writeContract()` to sign/send harvest, approval, and swap transactions. Browser signing was not found.
- **Status:** Backend signing **verified**; browser signing absent from inspected code.

### 7. Per-user versus globally shared configuration

- **Files/functions:** `src/lib/harvester.ts:158-168,887-915` (`getAccount`, `runHarvester`); `src/lib/autoSwap.ts:54-69`.
- **Behavior:** Calls derive an account from the same process environment. `runHarvester()` uses it while iterating enabled database vaults. No user, tenant, or per-wallet lookup is involved.
- **Status:** **Verified**.

### 8. Shared execution wallet across callers

- **Files/functions:** `src/lib/harvester.ts:887-915`; `src/routes/defi.ts:110-143`; `src/routes/swap.ts:11-19`; `src/lib/scheduler.ts:29-38`.
- **Behavior:** Manual harvest and swap routes do not select a wallet by user identity; scheduled execution uses the same configured account. There is no code-level per-user separation.
- **Consequence:** If multiple callers can reach the shared service, they may trigger activity against the same execution wallet. Actual callers and production reachability are unknown.
- **Status:** Shared-wallet behavior **verified**; deployment exposure **conditional/unverified**.

### 9. API, log, and database exposure

- **Wallet address in API:** `src/lib/harvester.ts:146-153` returns `walletAddress` and `walletConfigured`; `src/routes/defi.ts:14-19` returns that status from `/api/defi/status`. The address is public chain data, not a private credential.
- **Private-key logging:** `src/lib/harvester.ts:163-166` logs only a generic invalid-key message. No inspected call explicitly passes the key to a logger. `src/lib/logger.ts:5-11` redacts authorization/cookie headers. This does not prove deployed logs or all runtime exception content are secret-free.
- **Database:** No private-key or wallet-address fields were found in the inspected schemas. Harvest history stores transaction hashes and financial values (`src/db/schema/defi.ts:43-54`).
- **Potential webhook secret exposure:** `src/routes/defi.ts:446-451` stores the webhook URL in `app_settings` and `:471-472` returns it in JSON. The URL is logged by hostname in this route (`:450`); delivery code logs the full URL at `src/lib/harvester.ts:823-847`. If the URL embeds a credential, it may be exposed by the API response/logs. This is conditional on URL contents.
- **Status:** These code paths are **verified**; whether production settings contain embedded credentials is **unknown**.

### 10. Changes needed for secure multi-user wallets

This is a recommendation, not implemented behavior:

1. Make read-only operation the default and remove the global signer from the ordinary API process.
2. Add authenticated identities and tenant-scoped wallet records/authorization. Verify wallet ownership with a nonce challenge signed by the wallet; never accept a raw private key as a connection mechanism.
3. For interactive execution, have the backend prepare and simulate a transaction while the user's browser wallet displays and signs it. Enforce authorization and transaction policy server-side.
4. If unattended execution is required, use a separately isolated smart-account/delegation design with narrowly scoped permissions, limits, expiry, revocation, per-user queues, and audit history. Do not share one unrestricted backend EOA among users.
5. Scope database access and background jobs by authenticated user/tenant. Add per-user transaction lifecycle, idempotency, and nonce controls.
6. Keep provider credentials and secret-bearing settings in managed secret storage. Do not return webhook URLs containing tokens; redact credentials from logs and protect stored settings.

## Recommended Shadow Harvester 2.0 design

The current architecture is a single backend-controlled execution account: a server environment key is used by both harvest and swap code, and the status API reports its public address/configured state. No user-specific or browser wallet signing exists in the inspected repository.

For 2.0, default to read-only operation with no signer configured. Add authenticated users and signed wallet ownership verification. For user-triggered actions, prepare/simulate on the server and require explicit browser-wallet signing. Treat unattended execution as a separate opt-in system based on limited, revocable smart-account delegation rather than a shared raw-key EOA.

## Verification record

- Static source/configuration inspection only.
- Tests executed: **None**.
- Wallet connections, transactions, installations, database access, and RPC calls: **None**.
- Source implementation changes: **None**.
