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
 * Public read-only partner API (issue #233):
 *
 *   GET /api/public/v1/vaults?limit={n}&cursor={c}
 *   → PublicVaultListResponse
 *
 *   GET /api/public/v1/vaults/{id}
 *   → PublicVaultDetail
 *
 *   GET /api/public/v1/vaults/{id}/epochs?limit={n}&cursor={c}
 *   → PublicEpochHistoryResponse
 *
 * The public surface is a projection over the same vault registry/epoch
 * ledger, served from a cache independent of the authenticated read path.
 * It never exposes per-depositor data (see `toPublicVaultSummary`).
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
// Public read-only partner API (issue #233)
// ---------------------------------------------------------------------------

/**
 * Public projection of a vault summary. Contains only non-sensitive fields
 * that are safe to expose to unauthenticated third parties. Notably it omits
 * `userPosition` and any per-depositor data.
 */
export interface PublicVaultSummary {
  id: string;
  name: string;
  underlying: string;
  strategy: VaultStrategy;
  apy: number;
  apyMethodology: string;
  tvl: number;
  capacity: number;
  currentStrike: number;
  currentExpiry: string;
  riskRating: RiskRating;
  description: string;
  /** Lifecycle status so embeds can degrade gracefully. */
  status: "active" | "paused" | "wind_down";
}

/** Public projection of a vault detail. */
export interface PublicVaultDetail extends PublicVaultSummary {
  currentEpoch: number;
  currentPhase: EpochPhase;
  phaseEndsAt: string;
  sharePrice: number;
  totalShares: number;
  feeStructure: { managementPct: number; performancePct: number };
  payoffExplanation: string;
}

/** Public projection of one epoch record. */
export type PublicEpochRecord = EpochRecord;

/** Cursor-paginated envelope used by all public list endpoints. */
export interface PublicPage<T> {
  data: T[];
  /** Opaque cursor for the next page; `null` when there are no more pages. */
  nextCursor: string | null;
}

export type PublicVaultListResponse = PublicPage<PublicVaultSummary>;
export type PublicEpochHistoryResponse = PublicPage<PublicEpochRecord>;

/**
 * Project an internal vault summary onto the public, non-sensitive shape.
 * This is the single chokepoint that guarantees the public API never leaks
 * private fields — contract tests assert the output keys match exactly.
 */
export function toPublicVaultSummary(
  vault: VaultSummary,
  status: PublicVaultSummary["status"] = "active",
): PublicVaultSummary {
  return {
    id: vault.id,
    name: vault.name,
    underlying: vault.underlying,
    strategy: vault.strategy,
    apy: vault.apy,
    apyMethodology: vault.apyMethodology,
    tvl: vault.tvl,
    capacity: vault.capacity,
    currentStrike: vault.currentStrike,
    currentExpiry: vault.currentExpiry,
    riskRating: vault.riskRating,
    description: vault.description,
    status,
  };
}

/**
 * Project an internal vault detail onto the public shape, dropping
 * `userPosition` and `historicalEpochs` (epochs are served by their own
 * paginated endpoint).
 */
export function toPublicVaultDetail(
  vault: VaultDetail,
  status: PublicVaultSummary["status"] = "active",
): PublicVaultDetail {
  return {
    ...toPublicVaultSummary(vault, status),
    currentEpoch: vault.currentEpoch,
    currentPhase: vault.currentPhase,
    phaseEndsAt: vault.phaseEndsAt,
    sharePrice: vault.sharePrice,
    totalShares: vault.totalShares,
    feeStructure: vault.feeStructure,
    payoffExplanation: vault.payoffExplanation,
  };
}

/**
 * Documented caching policy for the public API. Partners may cache responses
 * for the given TTL; the CDN serves stale-while-revalidate beyond it.
 */
export const PUBLIC_API_CACHE_POLICY = {
  list: { maxAge: 60, staleWhileRevalidate: 300 },
  detail: { maxAge: 60, staleWhileRevalidate: 300 },
  epochs: { maxAge: 300, staleWhileRevalidate: 600 },
} as const;

/** Documented rate limits for the public API (per IP unless keyed). */
export const PUBLIC_API_RATE_LIMITS = {
  anonymous: { requests: 60, windowSeconds: 60 },
  keyed: { requests: 600, windowSeconds: 60 },
} as const;

/** Default and maximum page sizes for public list endpoints. */
export const PUBLIC_API_PAGINATION = {
  defaultLimit: 20,
  maxLimit: 100,
} as const;

/**
 * Build the deep link into the app's deposit flow, preserving attribution
 * parameters so partners get credit for referred deposits.
 */
export function buildDepositDeepLink(
  vaultId: string,
  attribution: { partner?: string; utmSource?: string; utmCampaign?: string } = {},
  baseUrl = "https://app.zenith.finance",
): string {
  const params = new URLSearchParams();
  if (attribution.partner) params.set("partner", attribution.partner);
  if (attribution.utmSource) params.set("utm_source", attribution.utmSource);
  if (attribution.utmCampaign) params.set("utm_campaign", attribution.utmCampaign);
  const query = params.toString();
  return `${baseUrl}/vaults/${encodeURIComponent(vaultId)}/deposit${query ? `?${query}` : ""}`;
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
export interface DepositorData