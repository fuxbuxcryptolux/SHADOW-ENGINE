# ADR 0001: Single-operator, two-wallet architecture

- **Status:** Approved
- **Date:** 2026-11-03
- **Scope:** Shadow Harvester 2.0 product and wallet architecture

## Context

The existing inspected service uses a backend account for harvest and swap execution. Shadow Harvester 2.0 needs a clear initial operating model that limits custody and signing exposure while preserving the project's multi-chain and multi-protocol intelligence scope. The first release is for the project owner alone; proving sustainable personal profitability comes before adding multi-user or commercial product infrastructure.

## Decision

### Operator and default mode

1. The initial product is exclusively for one operator: the project owner.
2. The system operates read-only by default. A transaction is not signed or submitted unless explicitly authorized under the applicable execution policy.
3. Multi-chain and multi-protocol intelligence remains part of the original scope.

### Dedicated wallet roles

Use two dedicated wallets, neither of which is one of the owner's primary personal wallets:

- **Operating Wallet:** Holds limited gas and execution funds. It signs explicitly authorized harvest, approval, and swap transactions.
- **Treasury Wallet:** Receives verified realized profits and stores accumulated funds. It must not participate in routine automated signing.

### Profit transfers

Transfer profits only after proceeds are verified as realized. Before any transfer, account for gas, fees, slippage, outstanding obligations, and the verified amount available to transfer. The system must not classify estimates, unrealized gains, or funds reserved for obligations as transferable profit.

### Key handling

Private keys must never be stored in frontend code, database records, GitHub, logs, or prompts. Wallet creation and key custody are outside this architecture decision; the implementation must not require users to disclose private keys to the application.

### Deferred capabilities

Multi-user authentication, tenant separation, subscriptions, and commercialization are deferred until the personal system demonstrates sustainable profitability. Unattended execution is a separate future capability that requires explicit authorization and narrowly scoped permissions. It is not implied by the Operating Wallet's role or by read-only intelligence.

## Consequences

- Product and authorization flows can be designed around one operator without introducing tenant boundaries or subscription logic in the first version.
- Read-only intelligence can run without a signing wallet. Transaction execution must be separately gated and authorized.
- Operating Wallet and Treasury Wallet responsibilities must remain distinct in application behavior, configuration, monitoring, and accounting.
- Profit transfer logic needs verified realized proceeds and a calculation that reserves transaction costs and obligations before determining the transferable amount.
- Future unattended execution requires a separate design and explicit authorization; it cannot be inferred from this ADR.
- Existing forensic and wallet investigation reports remain historical evidence. The wallet investigation's exploratory product recommendations are superseded by this approved decision, while its implementation observations remain intact.

## Out of scope

This ADR does not authorize implementation, create or configure wallets, select a custody provider or signing mechanism, define chain-specific transaction policy, or enable unattended execution. It does not specify future multi-user or commercialization architecture.

## Open design questions for a later implementation plan

- What explicit operator action and confirmation flow authorizes each harvest, approval, and swap?
- Which limits and checks bound Operating Wallet balances, transaction amounts, tokens, protocols, and chains?
- How will realized proceeds, outstanding obligations, gas, fees, and slippage be verified and reserved before treasury transfers?
- What evidence and independent checks are required before marking proceeds realized and transferable?
- How will Treasury Wallet destinations be configured and verified without involving the treasury in routine automated signing?
- What narrowly scoped permission model would be acceptable if unattended execution is proposed later?
