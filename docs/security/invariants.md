# Security Invariants

This document enumerates the invariants the vault stack must uphold. Each invariant
is stated as a property that must hold across every transaction, and is annotated
with the enforcement point(s) and the tests that guard it.

## Collateral custody

- **INV-1 — Single custodian.** Only the vault core holds collateral custody. Strategy
  modules never receive raw transfer rights; they may only invoke the scoped callbacks
  declared in their capability set (see *Strategy module plugin interface* below).
- **INV-2 — No arbitrary movement.** A module cannot move collateral outside the
  operations it declared at registration time. Any attempt to reach an undeclared
  operation must revert.

## Strategy module plugin interface

A strategy module is a contract that implements the following interface. Conformance
is validated at registration time; a module that fails conformance cannot be enabled.

### Declared parameter schema and defaults

- `parameterSchema() returns (bytes schema)` — ABI-encoded schema describing every
  configurable parameter (name, type, bounds).
- `defaultParameters() returns (bytes defaults)` — ABI-encoded default values that
  must validate against `parameterSchema()`.

### Per-vault capacity / risk-limit hooks

- `capacityLimit(VaultContext ctx) returns (uint256 maxNotional)` — the maximum
  notional the module may deploy for the given vault.
- `riskLimits(VaultContext ctx) returns (RiskLimits limits)` — per-epoch exposure,
  delta, and concentration bounds the vault enforces before dispatching any action.

### Epoch lifecycle responsibilities

- `onEpochOpen(EpochContext ctx)` — allocate within declared capacity; must be
  idempotent and must not exceed `capacityLimit`.
- `onEpochRollover(EpochContext ctx)` — roll expiring positions; must leave the
  vault in a consistent state if it reverts (see failure semantics).
- `onEpochClose(EpochContext ctx)` — settle and report realized PnL; must be
  callable even when the module has been disabled so open positions can be wound down.

### Permitted callbacks on collateral and settlement layers

The module may only invoke the following vault callbacks, and only if the
corresponding capability was declared:

| Capability            | Permitted callback                          |
|-----------------------|---------------------------------------------|
| `HOLD_COLLATERAL`     | `vault.holdCollateral(amount)`              |
| `OPEN_COVERED_CALL`   | `vault.openCoveredCall(strike, expiry, qty)`|
| `OPEN_CASH_SECURED_PUT`| `vault.openCashSecuredPut(strike, expiry, qty)` |
| `OPEN_IRON_CONDOR`    | `vault.openIronCondor(legs)`                |
| `SETTLE_POSITION`     | `settlement.settle(positionId)`             |

Any callback not backed by a declared capability must revert with
`CapabilityNotDeclared`.

### Failure semantics

- **INV-3 — Atomic epochs.** If a module reverts mid-epoch, the vault must roll back
  to the pre-epoch state; no partial allocation may persist.
- **INV-4 — Wind-down after disable.** Disabling a module for a vault must not strand
  open positions: `onEpochClose` remains reachable for wind-down even after disable.
- **INV-5 — Immutable enabled entries.** A registry entry is versioned and immutable
  once enabled. An enabled module cannot be swapped for a different implementation via
  upgrade; a new version must be registered and enabled through the operator workflow.

## Capability model

- **INV-6 — Declared-only reachability.** A module declares the operations it needs
  (e.g. `OPEN_COVERED_CALL`, `HOLD_COLLATERAL`). The vault enforces that only declared
  operations are reachable; undeclared operations revert.

## Registry and operator workflow

- **INV-7 — Governed enablement.** Enabling or disabling a module for a vault is an
  operator action gated by the existing authorization and timelock workflow. There is
  no permissionless module enabling.
- **INV-8 — Sandbox before real deposits.** A candidate module must pass the
  interface-conformance suite and a backtest in the sandbox harness before it can be
  enabled for any vault holding real deposits.

## Testing

- Interface-conformance suite: every module must pass before registration.
- Adversarial tests: a module exceeding its declared capabilities must revert.
- Integration test: enabling a new module on a live-ish vault testnet scenario.
