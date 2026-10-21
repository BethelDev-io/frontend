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
| SEC-009 | signing | A challenge whose `Issued At` timestamp is more than a few minutes in the future must be rejected with `ISSUED_AT_FUTURE`. | `src/test/security/invariants.test.ts` | `SEC-009: issued-at far in the future is rejected (ISSUED_AT_FUTURE)` | SIWS §4.3; prevents clock-skew abuse |
| SEC-010 | input | An address that exactly matches a known address must not be flagged as poisoned. | `src/test/security/invariants.test.ts` | `SEC-010: exact address match is not flagged as poisoned` | CWE-20 (false-positive control) |
| SEC-011 | input | An address that matches the first N and last N characters of a known address but differs in the middle must be flagged as poisoned. | `src/test/security/invariants.test.ts` | `SEC-011: address matching first+last chars but differing in middle is flagged` | CWE-20; address-poisoning attack pattern |
| SEC-012 | input | A completely different address (no prefix/suffix match) must not be flagged as poisoned. | `src/test/security/invariants.test.ts` | `SEC-012: completely different address is not flagged` | CWE-20 (false-positive control) |
| SEC-013 | input | An empty string input must not be flagged as poisoned. | `src/test/security/invariants.test.ts` | `SEC-013: empty input is not flagged` | CWE-20; null/empty input safety |
| SEC-014 | session | After explicit logout, all `zenith.wallet.*` keys must be absent from `localStorage`. | `src/test/security/invariants.test.ts` | `SEC-014: after explicit logout, no wallet key remains in localStorage` | OWASP Session Mgmt §3.3; WCAG 2.2 SC 3.3.8 |
| SEC-015 | session | Bearer tokens must never appear as URL query parameters (detectable by scanning constructed URLs for `token=`, `auth=`, or `bearer=`). | `src/test/security/invariants.test.ts` | `SEC-015: bearer token must not appear as a URL query parameter` | OWASP ASVS V3.4.2; tokens in URLs leak via Referer/logs |
| SEC-016 | session | `sessionStorage` must be empty immediately after a fresh page load — wallet tokens are stored only in the zustand-persist `localStorage` store. | `src/test/security/invariants.test.ts` | `SEC-016: sessionStorage is empty after a fresh page load simulation` | OWASP Session Mgmt §2.1 |
| SEC-017 | isolation | Alert rules must be stored under a per-wallet key (`zenith.rules.<address>`) so that switching wallets does not expose another wallet's rules. | `src/test/security/invariants.test.ts` | `SEC-017: rules are stored per wallet address and cannot bleed across wallets` | CWE-359; data isolation |
| SEC-018 | isolation | Workspace layouts must be stored under a per-wallet key (`zenith.layout.<address>`); a different wallet must see no layout data. | `src/test/security/invariants.test.ts` | `SEC-018: workspace layouts are keyed per wallet` | CWE-359; data isolation |
| SEC-019 | isolation | Hotkeys configuration (`zenith.hotkeys.v1`) is intentionally global (non-sensitive preference) and is explicitly documented as such, not a violation. | `src/test/security/invariants.test.ts` | `SEC-019: hotkeys config is not wallet-specific (safe global preference)` | N/A — documented exception |
| SEC-020 | isolation | Anti-phishing phrases must be stored under a per-wallet key (`zenith.antiphishing.phrase.<address>`) and must not be visible to a different wallet. | `src/test/security/invariants.test.ts` | `SEC-020: anti-phishing phrase is wallet-scoped` | CWE-359; data isolation |
| SEC-021 | vault | Share issuance is priced from internal book value (`total_book_value`), never from the raw token balance at the vault contract address; a direct transfer does not change NAV per share. | `src/test/security/invariants.test.ts` | `SEC-021: NAV per share is derived from book value, not raw token balance` | Issue #290; donation-attack surface |
| SEC-022 | vault | A non-zero deposit always mints a non-zero number of shares (virtual offset + round-down guarantee), so honest depositors are never zeroed out. | `src/test/security/invariants.test.ts` | `SEC-022: non-zero deposit never mints zero shares` | Issue #290; rounding-to-zero |
| SEC-023 | vault | An attacker round-trip (deposit → donate → withdraw) never increases the attacker's proportion of vault NAV. | `src/test/security/invariants.test.ts` | `SEC-023: attacker round-trip never increases attacker NAV proportion` | Issue #290; inflation attack |
| SEC-024 | vault | The genesis (zero-supply) deposit below `min_first_deposit` reverts, and the first deposit's shares are minted to the dead/locked sink. | `src/test/security/invariants.test.ts` | `SEC-024: genesis deposit enforces min_first_deposit and locks initial shares` | Issue #290; first-depositor attack |
| SEC-025 | vault | A deposit whose computed shares fall below the caller-supplied `min_shares_out` reverts. | `src/test/security/invariants.test.ts` | `SEC-025: deposit reverts when shares fall below min_shares_out` | Issue #290; quote/execution drift |
| SEC-026 | vault | A NAV-per-share move exceeding `max_nav_jump_bps` between share-issuance events in the same ledger reverts the issuance. | `src/test/security/invariants.test.ts` | `SEC-026: NAV jump beyond max_nav_jump_bps reverts issuance` | Issue #290; NAV-jump guard |
