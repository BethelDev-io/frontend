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
 * NAV / share-price source of truth (issue #290):
 *
 *   Share issuance is priced from the vault's internal book value
 *   (`bookValue`), NOT from the raw token balance held at the vault
 *   contract address. Direct token transfers to the contract are
 *   classified as `ignored` — they do not move NAV and cannot be used
 *   to inflate the share price. This classification is identical across
 *   the contract, the backend indexer/registry, and this adapter.
 *
 *   Inflation / donation-attack mitigations are per-vault config
 *   (`inflationDefense`) and are changeable only through the timelocked
 *   operator path. The adapter surfaces them so the UI can enforce the
 *   same `minSharesOut` bound the contract enforces on deposit.
 *
 * Shadow mode (issue #292):
 *
 *   A strategy may run in `shadow` mode — the identical strategy module
 *   and keeper path execute against live oracle/engine data, but no
 *   option orders are submitted and no depositor collateral is
 *   committed. Shadow state lives in its own namespace (`shadow` on the
 *   detail payload) with its own hypothetical NAV-per-share series and
 *   epoch record stream. It is NEVER merged into `bookValue`,
 *   `sharePrice`, `tvl`, or `historicalEpochs`, and shadow runs are
 *   labeled `mode: "shadow"` everywhere they surface so paper results
 *   cannot be mistaken for realized performance.
 */

export type VaultStrategy = "covered_call" | "cash_secured_put" | "iron_condor" | "wheel";
export type RiskRating = "low" | "medium" | "high";
export type EpochPhase = "deposit" | "active" | "settlement";

/**
 * Execution mode of a vault strategy.
 *
 * - `live`: real capital is committed and real option orders are submitted.
 * - `shadow`: paper trading — the same decision path runs, but no orders
 *   are submitted and no depositor collateral is committed. Shadow state
 *   is tracked in a separate namespace and must never be conflated with
 *   live balances.
 */
export type VaultMode = "live" | "shadow";

/**
 * How a direct token transfer to the vault contract address is treated.
 * Must match the contract and backend indexer/registry exactly.
 *
 * - `ignored`: transfer does not affect NAV (default; donation-resistant).
 * - `swept`: transfer is moved to a defined sink address.
 * - `windfall`: transfer is absorbed into book value (opt-in only).
 */
export type DirectTransferPolicy = "ignored" | "swept" | "windfall";

/**
 * Per-vault inflation / donation-attack defense parameters.
 * Stored with the rest of the vault parameters and mutable only via the
 * timelocked operator path — never hardcoded constants.
 */
export interface InflationDefenseConfig {
  /** Virtual shares added to total supply in the pricing formula. */
  virtualShares: number;
  /** Virtual assets added to book value in the pricing formula. */
  virtualAssets: number;
  /** Minimum assets required for the first (genesis) deposit. */
  minFirstDeposit: number;
  /** Shares minted to the dead/locked address on the first deposit. */
  deadShares: number;
  /** Max fractional NAV-per-share move between issuance events in one ledger (0–1). */
  navJumpGuardPct: number;
  /** Classification of direct token transfers to the contract. */
  directTransferPolicy: DirectTransferPolicy;
}

/** Summary shown on the /vaults listing page. */
export interface VaultSummary {
  id: string;
  name: string;
  underlying: string;
  strategy: VaultStrategy;
  /** Execution mode; `shadow` results are paper trading, not realized. */
  mode: VaultMode;
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

/**
 * One point in a hypothetical NAV-per-share series produced by a shadow
 * run. Kept in its own namespace so it can never be read as live NAV.
 */
export interface ShadowNavPoint {
  epochNumber: number;
  /** Hypothetical NAV per share in USD (paper trading only). */
  navPerShare: number;
  /** NAV per share the strategy model expected for this epoch. */
  expectedNavPerShare: number;
  /** ISO timestamp the shadow epoch settled. */
  recordedAt: string;
}

/**
 * Side-by-side comparison of a shadow run against live and expected
 * performance. All shadow figures are paper trading and must be labeled
 * as such in the UI.
 */
export interface ShadowComparison {
  /** Latest hypothetical NAV per share from the shadow run. */
  shadowNavPerShare: number;
  /** Latest realized NAV per share of the live vault (null if none). */
  liveNavPerShare: number | null;
  /** NAV per share the strategy model expected for the latest epoch. */
  expectedNavPerShare: number;
  /** Shadow minus live NAV per share (null when no live history). */
  shadowVsLiveDelta: number | null;
  /** Shadow minus expected NAV per share. */
  shadowVsExpectedDelta: number;
  /** Number of complete shadow epochs recorded so far. */
  completedEpochs: number;
}

/**
 * Shadow (paper-trading) state for a vault strategy. Tracked in its own
 * namespace, with its own hypothetical NAV series and epoch stream, so
 * the registry, indexer, and this read model never conflate it with real
 * balances.
 */
export interface ShadowState {
  /** Always `shadow` — makes the paper-trading label explicit in payloads. */
  mode: "shadow";
  /** Hypothetical NAV-per-share series, one point per complete epoch. */
  navSeries: ShadowNavPoint[];
  /** Shadow epoch record stream (never merged into `historicalEpochs`). */
  epochs: EpochRecord[];
  /** Side-by-side comparison data for the operator console/analytics. */
  comparison: ShadowComparison;
}

/**
 * Promotion criteria that must be met before a shadow strategy can be
 * moved to live allocation. Evaluated by the backend promotion gate; the
 * adapter surfaces the thresholds so the operator console can display
 * progress and block promotion when unmet.
 */
export interface PromotionCriteria {
  /** Minimum number of complete shadow epochs required. */
  minCompleteEpochs: number;
  /** Max allowed |shadow − expected| NAV deviation per share (USD). */
  maxNavDeviation: number;
  /** Whether any invariant violations were recorded during the run. */
  invariantViolations: number;
}

/** Full detail for a single vault. */
export interface VaultDetail extends VaultSummary {
  currentEpoch: number;
  currentPhase: EpochPhase;
  phaseEndsAt: string; // ISO — when the current phase ends
  sharePrice: number; // current NAV per share in USD
  totalShares: number;
  /** Internal book value backing shares (source of truth for NAV). */
  bookValue: number;
  feeStructure: { managementPct: number; performancePct: number };
  /** Per-vault inflation / donation-attack defense parameters. */
  inflationDefense: InflationDefenseConfig;
  payoffExplanation: string;
  historicalEpochs: EpochRecord[];
  userPosition: UserVaultPosition | null;
  /**
   * Shadow (paper-trading) state. Present only when `mode === "shadow"`.
   * Never merged into live fields above.
   */
  shadow?: ShadowState;
  /** Promotion gate thresholds; present for shadow runs. */
  promotionCriteria?: PromotionCriteria;
}

/**
 * Compute the number of shares minted for a deposit, using the same
 * virtual-offset integer formula as the contract. NAV is derived from
 * internal book value only — never from the raw token balance.
 *
 * shares = amount * (totalShares + virtualShares) / (bookValue + virtualAssets)
 *
 * Returns 0 when the deposit would round to zero shares, so callers can
 * reject it rather than silently forfeiting the depositor's assets.
 */
export function quoteSharesOut(
  amount: number,
  bookValue: number,
  totalShares: number,
  defense: Pick<InflationDefenseConfig, "virtualShares" | "virtualAssets">,
): number {
  if (amount <= 0) return 0;
  const denom = bookValue + defense.virtualAssets;
  if (denom <= 0) return 0;
  return Math.floor((amount * (totalShares + defense.virtualShares)) / denom);
}

/**
 * Enforce the per-deposit `minSharesOut` bound in the deposit path.
 * Throws if the quoted shares fall below the caller's bound or round to
 * zero, guaranteeing honest depositors never receive zero shares for a
 * non-zero deposit.
 */
export function assertMinSharesOut(quotedShares: number, minSharesOut: number): void {
  if (quotedShares <= 0) {
    throw new Error("Deposit would mint zero shares; increase amount or lower NAV impact");
  }
  if (quotedShares < minSharesOut) {
    throw new Error(`Slippage: quoted ${quotedShares} shares < minSharesOut ${minSharesOut}`);
  }
}

/**
 * Evaluate the promotion gate for a shadow run. Returns the list of
 * unmet criteria; an empty list means the strategy may be promoted to
 * live allocation. Mirrors the backend gate so the operator console can
 * block promotion when criteria are unmet.
 */
export function evaluatePromotionGate(
  shadow: ShadowState,
  criteria: PromotionCriteria,
): string[] {
  const unmet: string[] = [];
  if (shadow.comparison.completedEpochs < criteria.minCompleteEpochs) {
    unmet.push(
      `Only ${shadow.comparison.completedEpochs}/${criteria.minCompleteEpochs} complete epochs`,
    );
  }
  if (Math.abs(shadow.comparison.shadowVsExpectedDelta) > criteria.maxNavDeviation) {
    unmet.push(
      `NAV deviation ${shadow.comparison.shadowVsExpectedDelta} exceeds bound ${criteria.maxNavDeviation}`,
    );
  }
  if (criteria.invariantViolations > 0) {
    unmet.push(`${criteria.invariantViolations} invariant violation(s) recorded`);
  }
  return unmet;
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
    mode: "live",
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
    bookValue: 284000,
    feeStructure: { managementPct: 0, performancePct: 10 },
    inflationDefense: {
      virtualShares: 1e6,
      virtualAssets: 1,
      minFirstDeposit: 100,
      deadShares: 1000,
      navJumpGuardPct: 0.05,
      directTransferPolicy: "ignored",
    },
    payoffExplanation: "Each week the vault sells a call option at a strike ~10% above the current XLM price. If XLM stays below the strike, depositors keep the full premium. If XLM rallies above the strike, the position is exercised and depositors participate in the upside up to the strike, giving up gains beyond it.",
    historicalEpochs: [
      { epochNumber: 46, depositStart: "2026-09-19", activeStart: "2026-09-20", settlementDate: "2026-09-27", strike: 0.125, expiryDays: 7, premiumCollected: 0.0018, outcome: "expired_worthless", pnlPct: 0.021 },
      { epochNumber: 45, depositStart: "2026-09-12", activeStart: "2026-09-13", settlementDate: "2026-09-20", strike: 