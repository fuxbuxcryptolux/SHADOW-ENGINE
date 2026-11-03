# ChatGPT Handoff — Shadow Harvester 2.0

## Repository state

- **Repository:** `/root/SHADOW-ENGINE`
- **Branch:** `chatgpt-handoff` (tracking `origin/chatgpt-handoff`)
- **Verified before this documentation update:** Branch `chatgpt-handoff`; local commit `6cb17b9b46d8feb8d49907c0d871591179a35ff0`; remote `origin/chatgpt-handoff` resolved to the same commit; working tree clean. ADR 0001 and the handoff correction were committed and pushed in that commit.
- **This assignment:** The staged implementation plan and this handoff update are documentation-only changes and remain uncommitted/unpushed pending separate authorization.

## Current implementation and investigation

The checked-in project is a backend service. The wallet investigation found that harvest and swap paths use one backend account derived from `HARVESTER_PRIVATE_KEY`; it found no included user wallet connection UI or browser signing flow. The investigation is a read-only snapshot of the inspected repository and its stated evidence boundaries.

**Preserved report:** [Wallet architecture investigation](AUDIT/wallet-architecture-investigation-2026-11-02.md)

## Approved 2.0 architecture

Shadow Harvester 2.0 starts as a personal system for one operator: the project owner. Its normal/default mode is read-only. Multi-chain and multi-protocol intelligence remains in scope.

The approved design uses two dedicated wallets:

- **Operating Wallet:** Holds limited gas and execution funds. It signs only explicitly authorized harvest, approval, and swap transactions.
- **Treasury Wallet:** Receives verified realized profits and stores accumulated funds. It does not participate in routine automated signing.

The application's operational wallets must be dedicated wallets, never the owner's primary personal wallets. Private keys must never be stored in frontend code, database records, GitHub, logs, or prompts. Any profit transfer must account for gas, fees, slippage, outstanding obligations, and verified realized proceeds.

Unattended execution is a separate future capability. It requires explicit authorization and narrowly scoped permissions; it is not part of default/read-only operation. Multi-user authentication, tenant separation, subscriptions, and commercialization are deferred until the personal system demonstrates sustainable profitability.

**Decision record:** [ADR: Single-operator, two-wallet architecture](ARCHITECTURE/0001-single-operator-two-wallet-architecture.md)

**Staged implementation plan:** [Shadow Harvester 2.0 staged implementation plan](ARCHITECTURE/0002-staged-implementation-plan.md)

## Prior documents and decision status

The wallet investigation report is preserved unchanged. No separate forensic audit report was present in this checkout. The wallet investigation's multi-user/browser-wallet recommendations were exploratory recommendations made before this approval; the approved ADR supersedes them as the product direction. The investigation's observations about the checked-in implementation remain useful evidence and are not rewritten by the ADR.

## Next recommended assignment

Review and approve the staged implementation plan and resolve its open design questions, especially signing/custody, single-operator API authorization, and who may authorize/sign Treasury transfers. Authorize any implementation as a separate assignment. Keep multi-chain/multi-protocol intelligence in scope and multi-user/commercial features deferred.

## Activity and verification

- This assignment updates documentation only; no application source or database schema is changed.
- No tests, wallet setup, private-key inspection, transaction, RPC call, branch merge, commit, or push was performed.
- The existing wallet investigation remains unchanged. No tests, RPC calls, or transactions were performed for the plan.
