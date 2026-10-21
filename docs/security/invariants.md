# Security Invariants — Zenith Frontend

## Issue #130: Security Regression Test Suite

---

## Introduction

Security invariants are properties of the system that must hold unconditionally, regardless of feature changes, refactors, or dependency upgrades. Encoding them as automated tests rather than prose documentation serves three purposes:

1. **Regression prevention.** A future commit that accidentally removes HTTPS enforcement, weakens nonce validation, or leaks tokens across wallet namespaces will fail CI immediately, with a named invariant ID pointing to the exact contract that was broken.

2. **Living specification.** The test file is the authoritative source of truth for each invariant. The table below cross-references it so reviewers can jump from requirement to implementation and back.

3. **Audit trail.** Each invariant has a stable ID (`SEC-NNN`). Security audits, vulnerability reports, and pull requests can reference these IDs without ambiguity. When an invariant is tightened or relaxed, the history of that change is visible in `git log` on both this file and the test.

All 23 invariants live in a single file so the entire suite can be run in isolation, with no dependency on a running backend or browser extension:

```bash
npm test src/test/security/invariants.test.ts
```

---

## Domain Definitions

| Domain | Abbreviation | Scope |
|---|---|---|
| **signing** | `signing` | Challenge/response authentication: parsing, field validation, expiry, origin binding, nonce entropy, version gating. Covers the Freighter sign-in flow (`src/lib/auth/challengeValidator.ts`). |
| **input** | `input` | User-supplied address validation. Specifically the address-poisoning heuristic that detects look-alike wallet addresses designed to fool copy-paste. |
| **session** | `session` | Bearer token lifecycle: where tokens are stored, that logout clears them completely, and that tokens never appear in URLs. |
| **isolation** | `isolation` | Per-wallet namespacing in `localStorage`. Alert rules, workspace layouts, and anti-phishing phrases must not bleed between wallet accounts. Hotkeys (non-sensitive) are explicitly documented as intentionally global. |
| **headers** | `headers` | Structural HTTP and subresource security: `X-Frame-Options`, SRI hash format correctness, and the HTTPS-only policy for external resources. |
| **vault** | `vault` | Vault share accounting: NAV source of truth, direct-transfer classification, and inflation/donation-attack mitigations (virtual offset, minimum first deposit, `minSharesOut`, NAV-jump guard). |
| **cross-contract** | `cross-contract` | Vault cross-contract call safety: single external-call wrapper, reentrancy lock, call allowlists, and failure containment for calls to the options engine, oracle, and SEP-41 assets. |

---

## Vault Share Accounting — NAV Source of Truth (Issue #290)

Share issuance in the Phase 2 vault is priced **exclusively from internal book-value accounting** (`total_book_value`), never from the raw token balance held at the vault contract address. The raw token balance is treated as an untrusted input that may drift from book value due to direct transfers, returned collateral, or slashed collateral.

**Direct-transfer classification (identical across contract, backend indexer/registry, and `src/lib/api/vaults.ts`):**

> Direct token transfers to the vault contract address are **IGNORED** for NAV/share-price purposes. They do not increase `total_book_value`, do not change NAV per share, and do not mint shares. They remain in the contract balance as an unaccounted surplus and are **not** swept or absorbed as a windfall by any share-issuance path.

This single choice must be mirrored in:
- the vault contract share-accounting module (pricing reads `total_book_value`, not `token.balance_of(vault)`),
- the backend share-accounting service / registry indexer (NAV derived from book value events, not balance snapshots),
- the `src/lib/api/vaults.ts` adapter (share-price and NAV fields sourced from book value, never from a raw balance read).

**Rounding direction:** all NAV/share math is integer arithmetic with a single documented rounding direction — shares minted round **down** (depositor-favoring on issuance is avoided; the vault never mints more shares than the exact rational value), and assets returned on withdrawal round **down**. This guarantees the vault cannot be drained by rounding.

---

## Vault Share Accounting — Inflation / Donation Attack Mitigations (Issue #290)

All four mitigations below are **per-vault configuration** stored with the rest of the vault parameters and changeable **only through the timelocked operator path** — never hardcoded constants.

| Parameter | Purpose |
|---|---|
| `virtual_shares` / `virtual_assets` | Virtual offset added to both numerator and denominator of the share-price formula so the first-depositor / donation attack cannot move NAV per share by a meaningful ratio. |
| `min_first_deposit` | Minimum assets required for the genesis (zero-supply) deposit; the corresponding shares are minted to a dead/locked sink so the attacker cannot own the entire initial supply. |
| `min_shares_out` (per-deposit) | Caller-supplied lower bound on shares minted; the deposit path reverts if the computed shares fall below it, defeating read-time-quote vs execution NAV drift. |
| `max_nav_jump_bps` | Bounds how far NAV per share may move between share-issuance events in the same ledger; a larger jump reverts the issuance. |

**Share-price formula (integer, round-down):**

```
shares_out = floor( assets_in * (total_shares + virtual_shares)
                    / (total_book_value + virtual_assets) )
```

Because `virtual_shares` and `virtual_assets` are non-zero, a donation that inflates `total_book_value` cannot zero out a subsequent depositor's shares, and a 1-unit first deposit cannot capture the whole supply.

---

## Vault Cross-Contract Call Safety (Issue #291)

Vaults custody depositor collateral across epochs and call out to the options engine (sale, settlement, assignment), the oracle, and SEP-41 asset contracts. A single ordering or containment bug in that call graph is a total-loss class of defect, so the following policy is enforced in code and recorded here.

### Single external-call wrapper

Every external call in the vault suite (core vault + strategy modules) is funneled through **one internal wrapper**. The wrapper is the only place that invokes another contract; direct cross-contract invocations elsewhere are a review-blocking defect. The wrapper enforces:

1. **State-write ordering (checks-effects-interactions).** All vault accounting state (`total_book_value`, `total_shares`, per-account balances, pending epoch transition) is written **before** the external call is issued. No accounting mutation may occur after an external call returns within the same entry point.
2. **Validated return-value handling.** Return values from the engine and oracle are treated as untrusted. Accounting state is **never** derived from an unvalidated external return value; the wrapper validates shape/range and reverts on anything unexpected rather than coercing it.
3. **Allowlist enforcement.** The wrapper rejects any call whose target is not on the vault's explicit contract allowlist (options engine, oracle, configured SEP-41 assets). A dependency address changed by an upgrade must be re-registered through the timelocked operator path before it is callable.

### Reentrancy lock

An **explicit** reentrancy lock (not implicit in ordering) covers all accounting-mutating entry points: deposit, withdraw, redeem, settlement, assignment, and epoch transition. The lock is acquired on entry and released on exit; a re-entrant call into any locked entry point reverts. The vault's callback entry points additionally enforce an **explicit caller allowlist** — only the registered options engine may invoke settlement/assignment callbacks, and an auth-entry mismatch reverts.

### Failure containment

For each external call it is documented and enforced whether failure **aborts the transaction** (the default) or is **deferred for keeper retry**. No entry point may leave a partially applied epoch transition or a partial deposit/withdrawal: either the full state transition commits or the transaction reverts with vault state byte-identical to before the call. Calls attempted while an emergency pause is active revert. Resource-budget exhaustion mid-call reverts the whole transaction rather than leaving a half-applied transition.

### Pull-based settlement

Where the engine interface allows, settlement is **pull-based** (the vault reads settled results) rather than callback-driven, keeping the engine interface narrow and version-pinned. Callback-driven settlement is used only where the engine interface requires it, and only behind the caller allowlist above.

### Adversarial test contracts

The contract test crate includes adversarial mocks — a malicious SEP-41 token, a re-entrant options engine, an oracle returning garbage, a call that panics, and a call that exhausts the resource budget — each asserting vault state is byte-identical after any failure.

---

## Invariants Table

| ID | Domain | Invariant Description | Test File | Test Name | Security / WCAG Ref |
|---|---|---|---|---|---|
| SEC-001 | signing | A well-formed, unexpired challenge for the correct address and domain parses and validates without throwing. | `src/test/security/invariants.test.ts` | `SEC-001: valid challenge parses and validates without error` | SIWS §3 (happy path) |
| SEC-002 | signing | A challenge issued to address A must be rejected with `WRONG_ADDRESS` when validated against address B. | `src/test/security/invariants.test.ts` | `SEC-002: challenge for wrong address is rejected (WRONG_ADDRESS)` | SIWS §4.2; prevents session fixation |
| SEC-003 | signing | A challenge whose `Expiration Time` field is in the past must be rejected with `EXPIRED`. | `src/test/security/invariants.test.ts` | `SEC-003: expired challenge is rejected (EXPIRED)` | SIWS §4.3; prevents replay attacks |
| SEC-004 | signing | A challenge whose `URI` field does not match the expected domain must be rejected with `WRONG_DOMAIN`. | `src/test/security/invariants.test.ts` | `SEC-004: challenge with mismatched domain is rejected (WRONG_DOMAIN)` | SIWS §4.4; prevents phishing relay |
| SEC-005 | signing | A challenge with a nonce shorter than the minimum entropy threshold must be rejected with `NONCE_MALFORMED`. | `src/test/security/invariants.test.ts` | `SEC-005: malformed nonce is rejected (NONCE_MALFORMED)` | OWASP Auth §3; prevents brute-force nonce guessing |
| SEC-006 | signing | A challenge whose `URI` field is not a valid HTTPS URL must not parse (returns `null`). | `src/test/security/invariants.test.ts` | `SEC-006: challenge URI must be a valid HTTPS URL` | SIWS §4.1; OWASP Transport Layer |
| SEC-007 | signing | A challenge with a `Version` field other than `"1"` must be rejected with `VERSION_UNSUPPORTED`. | `src/test/security/invariants.test.ts` | `SEC-007: challenge version other than '1' is rejected` | SIWS §4.5; prevents downgrade attacks |
| SEC-008 | signing | A challenge whose `Issued At` timestamp is more than 10 minutes in the past must be rejected with `ISSUED_AT_TOO_OLD`. | `src/test/security/invariants.test.ts` | `SEC-008: challenge issued too far in the past is rejected (ISSUED_AT_TOO_OLD)` | SIWS §4.3; limits replay window |
| SEC-009 | signing | A challenge whose `Issued At` 

/* … truncated 5126 chars — edit only what you need near the top … */
