# ChatGPT Handoff — Shadow Harvester 2.0

## Current state

- **Repository:** SHADOW-ENGINE
- **Branch:** `main`
- **Current base commit:** `87329b3d50273bd0a1095222f7a6a7ef5e6adb42`
- **Worktree before this documentation update:** clean. The handoff and audit below are now new, uncommitted documentation changes.

## Latest completed assignment

Completed a read-only wallet architecture investigation. The inspected project has no included user wallet connection UI or browser signing flow. Harvest and swap use one backend account derived from `HARVESTER_PRIVATE_KEY`; it is globally shared by the service rather than scoped to a user. No private-key database write or explicit key logging/API response was found. The status API returns the public wallet address. Webhook URLs are stored and returned, so embedded URL credentials could be exposed.

**Detailed report:** [Wallet architecture investigation](AUDIT/wallet-architecture-investigation-2026-11-02.md)

## Files changed in this handoff update

- `docs/CHATGPT_HANDOFF.md` — created; concise current status and report link.
- `docs/AUDIT/wallet-architecture-investigation-2026-11-02.md` — created; detailed findings and recommendations.

No source files were changed. No prior reports were overwritten. No commit, push, or merge was performed.

## Tests and verification

- Tests executed: **None** (read-only architecture investigation; no tests requested or run).
- Static inspection only; no wallet connection, transaction, installation, database, or RPC action.

## Remaining bugs and risks

- One globally shared backend EOA signs transactions; callers are not associated with per-user wallets.
- The inspected repo has no user authentication/tenant-scoped wallet architecture or frontend wallet implementation.
- Wallet address/configured state is returned by `/api/defi/status`.
- Webhook URLs are persisted and returned; embedded credentials may reach API responses and delivery logs.
- Deployment secret handling and any frontend outside this checkout remain unverified.

## Architectural decisions / recommendations recorded

- Default Shadow Harvester 2.0 to read-only operation without a signer.
- Prefer user-owned browser-wallet signing for interactive execution.
- Treat unattended execution as a separate opt-in, per-user, limited and revocable smart-account/delegation system; do not share an unrestricted backend EOA.
- Never request or expose raw private keys; scope identities, database access, jobs, and audit trails by user/tenant.

## Next recommended task

Review and approve the wallet architecture direction before starting an implementation assignment. No implementation is authorized by this handoff.
