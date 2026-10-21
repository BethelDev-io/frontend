# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in this project, please report it responsibly by emailing the maintainers rather than opening a public issue. We will acknowledge receipt and work with you on a coordinated disclosure.

## Scope

This policy covers the on-chain vault contracts, the vault backend services, and the depositor-facing vault UI in `src/`.

## Depositor Data Retention, Deletion, and Privacy

Vaults accumulate off-chain records that are not purely on-chain: notification addresses, eligibility acknowledgements, support interactions, and analytical event streams that can be joined back to a wallet. This section defines how that data is classified, retained, deleted, and exported. The authoritative field-level inventory lives in [`docs/data-inventory.md`](docs/data-inventory.md).

### Data classification

- **On-chain (immutable) ledger data** — deposits, withdrawals, balances, strategy allocations, and the events derived from them. This is public, immutable, and required for reconciliation and audit. It is **never** deleted or anonymized by a deletion request.
- **Off-chain personal data** — alert/notification email addresses, signed disclosure acknowledgements, support interactions, and analytics events that can be joined back to a wallet. This is mutable and is the target of retention and deletion workflows.

Personal data is stored as an **opaque wallet reference** plus a separately-stored, deletable contact record, rather than denormalized PII embedded in ledger rows. This lets deletion target the contact record without corrupting reconciliations.

### Retention windows

Ephemeral off-chain data is purged or anonymized automatically on a schedule:

| Data | Retention | Action |
| --- | --- | --- |
| Notification delivery logs | 30 days | Purge |
| Analytics events | 90 days | Anonymize (strip wallet reference) |
| Support interactions | 24 months | Purge |
| Signed disclosure acknowledgements | Life of account + 24 months | Retain (audit) |
| Contact / alert email records | Until deletion request or account closure | Delete on request |

Purges are observable (logged with counts and window) and are reversible only via backup restores. A purge job must never touch on-chain-derived ledger or accounting data; the retention job operates only on the ephemeral tables listed above.

### Deletion request workflow

1. **Verified request** — the requester proves control of the wallet (signature over a challenge).
2. **Delete or anonymize** — deletable off-chain fields (contact records, notification logs, analytics joins, support interactions) are deleted or anonymized. Cascading references across services are handled gracefully; missing references do not abort the workflow.
3. **Preserve required records** — financial and audit records are retained in a documented, minimized form. Records under legal hold are **flagged** rather than silently dropped.
4. **Receipt** — a confirmation is returned to the requester summarizing what was deleted, anonymized, and retained (and why).

### Data export

A depositor can request an export of the vault-related records held for their wallet. The export includes off-chain personal data we hold plus a reference to the on-chain ledger data (which is already public). Exports are scoped to the requesting wallet only.

### Privacy notice

The depositor-facing privacy notice on the vault surfaces is consistent with this policy and is linked from the vault pages.

### Out of scope

This policy does not define a KYC/AML identity program and does not constitute jurisdictional legal advice.
