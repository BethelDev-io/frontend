/**
 * Typed data adapter interface for the Vaults feature.
 *
 * The vault smart contracts and backend API are not yet available.
 * When NEXT_PUBLIC_VAULTS=mock (or the env var is absent), the mock
 * implementation below is used. Swap in the real implementation by
 * setting NEXT_PUBLIC_VAULTS=live and implementing `fetchVaultsLive`.
 *
 * Backend contract (for when the real API lands):
 *
 *   GET /api/v1/vaults
 *   → VaultSummary[]
 *
 *   GET /api/v1/vaults/{id}
 *   → VaultDetail
 *
 *   POST /api/v1/vaults/{id}/deposit   { amount: number }  → { tx_id: string }
 *   POST /api/v1/vaults/{id}/withdraw  { shares: number }  → { tx_id: string; queued: boolean }
 *
 * Depositor privacy (issue #231):
 *
 *   GET  /api/v1/vaults/privacy/export?wallet={address}
 *   → DepositorDataExport
 *
 *   POST /api/v1/vaults/privacy/deletion-request  { wallet: string; reason?: string }
 *   → DeletionRequestReceipt
 *
 *   GET  /api/v1/vaults/privacy/deletion-request/{id}
 *   → DeletionRequestReceipt
 *
 * See docs/privacy/vault-data-inventory.md for the data inventory, retention
 * windows, and the deletion/export workflow this module mirrors.
 */

export type VaultStrategy = "covered_call" | "cash_secured_put" | "iron_condor" | "wheel";
export type RiskRating = "low" | "medium" | "high";
export type EpochPhase = "deposit" | "active" | "settlement";

/** Summary shown on the /vaults listing page. */
export interface VaultSummary {
  id: string;
  name: string;
  underlying: string;
  strategy: VaultStrategy;
  /** Trailing 12-month APY estimate (0–1, e.g. 0.18 = 18%). */
  apy: number;
  /** APY methodology note shown in tooltip. */
  apyMethodology: string;
  /** Total value locked in USD. */
  tvl: number;
  /** Maximum TVL before the vault is full. */
  capacity: number;
  currentStrike: number;
  currentExpiry: string; // ISO date
  riskRating: RiskRating;
  description: string;
}

/** One historical epoch record. */
export interface EpochRecord {
  epochNumber: number;
  depositStart: string; // ISO
  activeStart: string;
  settlementDate: string;
  strike: number;
  expiryDays: number;
  premiumCollected: number; // per share, in USD
  outcome: "expired_worthless" | "exercised" | "active";
  pnlPct: number; // epoch return, positive = profit for depositors
}

/** The user's position in a vault. */
export interface UserVaultPosition {
  shares: number;
  shareValue: number; // current USD value per share
  totalValue: number;
  accruedPremium: number;
  pendingWithdrawal: number; // shares queued for withdrawal at epoch end
}

/** Full detail for a single vault. */
export interface VaultDetail extends VaultSummary {
  currentEpoch: number;
  currentPhase: EpochPhase;
  phaseEndsAt: string; // ISO — when the current phase ends
  sharePrice: number; // current NAV per share in USD
  totalShares: number;
  feeStructure: { managementPct: number; performancePct: number };
  payoffExplanation: string;
  historicalEpochs: EpochRecord[];
  userPosition: UserVaultPosition | null;
}

// ---------------------------------------------------------------------------
// Depositor privacy: data inventory, retention, deletion & export
// ---------------------------------------------------------------------------

/**
 * Classification of a vault-related data field.
 *
 * - `on_chain`   — derived from immutable ledger state; cannot be deleted and
 *                  is retained indefinitely for reconciliation/audit.
 * - `off_chain`  — mutable personal data we control; subject to retention and
 *                  deletion/anonymization.
 */
export type DataClassification = "on_chain" | "off_chain";

/** One row of the depositor data inventory (mirrors docs/privacy/vault-data-inventory.md). */
export interface DataInventoryEntry {
  /** Stable field identifier, e.g. "alert_email". */
  field: string;
  /** Human-readable description of the field. */
  description: string;
  /** Why we collect it. */
  purpose: string;
  /** Lawful basis / justification for processing. */
  lawfulBasis: string;
  /** Where the data lives (service / table / store). */
  storageLocation: string;
  /** Retention window in days; `null` means retained indefinitely (immutable). */
  retentionDays: number | null;
  classification: DataClassification;
  /** True when the field is removed/anonymized on a verified deletion request. */
  deletable: boolean;
}

/**
 * The canonical inventory of vault-related data. Keep in sync with
 * docs/privacy/vault-data-inventory.md.
 */
export const VAULT_DATA_INVENTORY: readonly DataInventoryEntry[] = [
  {
    field: "wallet_address",
    description: "Opaque depositor wallet reference used to join positions.",
    purpose: "Link deposits/withdrawals to a depositor for position display and export.",
    lawfulBasis: "Contract performance (operating the vault).",
    storageLocation: "on-chain ledger + vault backend (opaque reference only)",
    retentionDays: null,
    classification: "on_chain",
    deletable: false,
  },
  {
    field: "position_and_epoch_ledger",
    description: "Shares, deposits, withdrawals, epoch P&L and premium records.",
    purpose: "Financial reconciliation, accounting and audit obligations.",
    lawfulBasis: "Legal obligation (financial records) / contract performance.",
    storageLocation: "on-chain ledger (immutable) + backend audit store",
    retentionDays: null,
    classification: "on_chain",
    deletable: false,
  },
  {
    field: "alert_email",
    description: "Email address for vault notifications.",
    purpose: "Deliver epoch, settlement and withdrawal notifications.",
    lawfulBasis: "Consent (opt-in at subscription).",
    storageLocation: "vault backend contact store (separate from ledger)",
    retentionDays: 365,
    classification: "off_chain",
    deletable: true,
  },
  {
    field: "disclosure_acknowledgement",
    description: "Signed eligibility/disclosure acknowledgement.",
    purpose: "Evidence that required disclosures were accepted before deposit.",
    lawfulBasis: "Legal obligation / legitimate interest (defensible record).",
    storageLocation: "vault backend acknowledgements store",
    retentionDays: 1825,
    classification: "off_chain",
    deletable: true,
  },
  {
    field: "support_interaction",
    description: "Support tickets and correspondence tied to a wallet.",
    purpose: "Resolve depositor issues and maintain service history.",
    lawfulBasis: "Legitimate interest (customer support).",
    storageLocation: "support tooling (linked by opaque wallet reference)",
    retentionDays: 730,
    classification: "off_chain",
    deletable: true,
  },
  {
    field: "notification_delivery_log",
    description: "Ephemeral delivery attempts/status for notifications.",
    purpose: "Debug delivery and confirm notifications were sent.",
    lawfulBasis: "Legitimate interest (service reliability).",
    storageLocation: "vault backend ephemeral log store",
    retentionDays: 30,
    classification: "off_chain",
    deletable: true,
  },
  {
    field: "analytics_event",
    description: "Product analytics events joinable to a wallet.",
    purpose: "Understand vault usage and improve the product.",
    lawfulBasis: "Legitimate interest (product analytics).",
    storageLocation: "analytics pipeline (pseudonymized wallet reference)",
    retentionDays: 90,
    classification: "off_chain",
    deletable: true,
  },
] as const;

/** A single retained record returned in a depositor data export. */
export interface DepositorDataRecord {
  field: string;
  classification: DataClassification;
  /** Present for off-chain records; omitted for immutable on-chain data. */
  value?: string | number | null;
  /** ISO timestamp the record was captured, when known. */
  capturedAt?: string;
  /** True when the record is retained under a legal hold / audit obligation. */
  legalHold?: boolean;
}

/** Depositor-facing export of the vault-related records we hold for a wallet. */
export interface DepositorDataExport {
  wallet: string;
  generatedAt: string; // ISO
  /** Inventory rows relevant to this depositor. */
  inventory: DataInventoryEntry[];
  /** The actual records held for this wallet. */
  records: DepositorDataRecord[];
  /** Human-readable note about immutable records that cannot be deleted. */
  retentionNote: string;
}

export type DeletionRequestStatus =
  | "received"
  | "verified"
  | "completed"
  | "partially_completed"
  | "rejected";

/** Receipt/confirmation returned to the requester after a deletion request. */
export interface DeletionRequestReceipt {
  requestId: string;
  wallet: string;
  status: DeletionRequestStatus;
  requestedAt: string; // ISO
  completedAt?: string; // ISO
  /** Off-chain fields that were deleted or anonymized. */
  deletedFields: string[];
  /** Fields retained under a documented legal/audit obligation. */
  retainedFields: string[];
  /** Explanation of what was preserved and why. */
  retentionNote: string;
}

/**
 * Compute the retention cutoff for an ephemeral field: records captured before
 * this ISO timestamp are eligible for purge/anonymization.
 *
 * Returns `null` for immutable fields (retentionDays === null).
 */
export function retentionCutoff(field: string, now: Date = new Date()): string | null {
  const entry = VAULT_DATA_INVENTORY.find((e) => e.field === field);
  if (!entry || entry.retentionDays === null) return null;
  const cutoff = new Date(now.getTime() - entry.retentionDays * 24 * 60 * 60 * 1000);
  return cutoff.toISOString();
}

/**
 * Determine whether a record is past its retention window and should be
 * purged/anonymized. Immutable (on-chain) records are never expired.
 */
export function isExpired(
  field: string,
  capturedAt: string,
  now: Date = new Date(),
): boolean {
  const cutoff = retentionCutoff(field, now);
  if (cutoff === null) return false;
  return new Date(capturedAt).getTime() < new Date(cutoff).getTime();
}

/**
 * Partition a depositor's records into deletable (off-chain) and retained
 * (immutable / legal-hold) sets. Used by the deletion workflow to guarantee
 * financial/audit records survive intact.
 */
export function partitionForDeletion(records: DepositorDataRecord[]): {
  deletable: DepositorDataRecord[];
  retained: DepositorDataRecord[];
} {
  const deletable: DepositorDataRecord[] = [];
  const retained: DepositorDataRecord[] = [];
  for (const record of records) {
    const entry = VAULT_DATA_INVENTORY.find((e) => e.field === record.field);
    const canDelete =
      record.classification === "off_chain" &&
      !record.legalHold &&
      entry?.deletable === true;
    (canDelete ? deletable : retained).push(record);
  }
  return { deletable, retained };
}

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

const MOCK_VAULTS: VaultDetail[] = [
  {
    id: "xlm-cc-v1",
    name: "XLM Covered Call",
    underlying: "XLM",
    strategy: "covered_call",
    apy: 0.22,
    apyMethodology: "Trailing 12-month annualized premium income ÷ average TVL. Does not include spot price change of the underlying.",
    tvl: 284000,
    capacity: 500000,
    currentStrike: 0.13,
    currentExpiry: "2026-10-03",
    riskRating: "medium",
    description: "Writes weekly out-of-the-money covered calls on XLM. Collects premium each epoch; the vault holds XLM as collateral.",
    currentEpoch: 47,
    currentPhase: "active",
    phaseEndsAt: "2026-10-03T16:00:00Z",
    sharePrice: 1.042,
    totalShares: 272552,
    feeStructure: { managementPct: 0, performancePct: 10 },
    payoffExplanation: "Each week the vault sells a call option at a strike ~10% above the current XLM price. If XLM stays below the strike, depositors keep the full premium. If XLM rallies above the strike, the position is exercised and depositors participate in the upside up to the strike, giving up gains beyond it.",
    historicalEpochs: [
      { epochNumber: 46, depositStart: "2026-09-19", activeStart: "2026-09-20", settlementDate: "2026-09-27", strike: 0.125, expiryDays: 7, premiumCollected: 0.0018, outcome: "expired_worthless", pnlPct: 0.021 },
      { epochNumber: 45, depositStart: "2026-09-12", activeStart: "2026-09-13", settlementDate: "2026-09-20", strike: 0.122, expiryDays: 7, premiumCollected: 0.0015, outcome: "expired_worthless", pnlPct: 0.018 },
      { epochNumber: 44, depositStart: "2026-09-05", activeStart: "2026-09-06", settlementDate: "2026-09-13", strike: 0.118, expiryDays: 7, premiumCollected: 0.0021, outcome: "exercised",         pnlPct: 0.009 },
      { epochNumber: 43, depositStart: "2026-08-29", activeStart: "2026-08-30", settlementDate: "2026-09-06", strike: 0.115, expiryDays: 7, premiumCollected: 0.0019, outcome: "expired_worthless", pnlPct: 0.022 },
      { epochNumber: 42, depositStart: "2026-08-22", activeStart: "2026-08-23", settlementDate: "2026-08-30", strike: 0.120, expiryDays: 7, premiumCollected: 0.0016, outcome: "expired_worthless", pnlPct: 0.019 },
    ],
    userPosition: { shares: 950, shareValue: 1.042, totalValue: 989.9, accruedPremium: 18.46, pendingWithdrawal: 0 },
  },
  {
    id: "btc-csp-v1",
    name: "BTC Cash-Secured Put",
    underlying: "BTC",
    strategy: "cash_secured_put",
    apy: 0.15,
    apyMethodology: "Trailing 12-month annualized premium income ÷ average USDC TVL. Excludes BTC spot risk — depositors are exposed to assignment at the strike price.",
    tvl: 1850000,
    capacity: 3000000,
    currentStrike: 60000,
    currentExpiry: "2026-10-17",
    riskRating: "high",
    description: "Writes monthly cash-secured puts on BTC. The vault holds USDC as collateral; assignment means acquiring BTC at the strike.",
    currentEpoch: 18,
    currentPhase: "active",
    phaseEndsAt: "2026-10-17T20:00:00Z",
    sharePrice: 1.088,
    totalShares: 1700368,
    feeStructure: { managementPct: 0.5, performancePct: 15 },
    payoffExplanation: "Each month the vault sells a put option at a strike ~10% below the current BTC price, backed by USDC. If BTC stays above the strike, depositors keep the premium. If BTC falls below the strike, the vault is assigned and acquires BTC at the strike — a risk equivalent to a limit buy order.",
    historicalEpochs: [
      { epochNumber: 17, depositStart: "2026-08-15", activeStart: "2026-08-19", settlementDate: "2026-09-20", strike: 59000, expiryDays: 30, premiumCollected: 420, outcome: "expired_worthless", pnlPct: 0.013 },
      { epochNumber: 16, depositStart: "2026-07-18", activeStart: "2026-07-22", settlementDate: "2026-08-16", strike: 55000, expiryDays: 30, premiumCollected: 380, outcome: "expired_worthless", pnlPct: 0.011 },
      { epochNumber: 15, depositStart: "2026-06-21", activeStart: "2026-06-24", settlementDate: "2026-07-19", strike: 57000, expiryDays: 30, premiumCollected: 440, outcome: "expired_worthless", pnlPct: 0.014 },
    ],
    userPosition: null,
  },
  {
    id: "eth-ic-v1",
    name: "ETH Iron Condor",
    underlying: "ETH",
    strategy: "iron_condor",
    apy: 0.18,
    apyMethodology: "Trailing 12-month net premium income (both spreads) ÷ average USDC collateral deployed.",
    tvl: 620000,
    capacity: 1000000,
    currentStrike: 3200,
    currentExpiry: "2026-10-10",
    riskRating: "low",
    description: "Sells 30-day iron condors on ETH, targeting a range-bound market. Limited loss profile; wins when ETH stays between the two breakevens.",
    currentEpoch: 11,
    currentPhase: "deposit",
    phaseEndsAt: "2026-09-28T12:00:00Z",
    sharePrice: 1.021,
    totalShares: 607247,
    feeStructure: { managementPct: 0, performancePct: 10 },
    payoffExplanation: "The vault simultaneously sells an out-of-the-money call spread and a put spread on ETH. Maximum profit is the combined net premium, achieved if ETH expires between the two short strikes. Maximum loss is limited to the spread width minus the premium.",
    historicalEpochs: [
      { epochNumber: 10, depositStart: "2026-08-25", activeStart: "2026-08-29", settlementDate: "2026-09-28", strike: 3100, expiryDays: 30, premiumCollected: 28, outcome: "expired_worthless", pnlPct: 0.016 },
    ],
    userPosition: null,
  },
];
