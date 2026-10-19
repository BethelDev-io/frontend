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
 *   GET /api/v1/vaults/positions
 *   → VaultPositionWire[]  (one row per vault the wallet holds; `error` set when that vault failed)
 */

import { bffFetch } from "./client";

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
      { epochNumber: 10, depositStart: "2026-08-25", activeStart: "2026-08-29", settlementDate: "2026-09-28", strike: 3100, expiryDays: 30, premiumCollected: 28, outcome: "expired_worthless", pnlPct: 0.017 },
      { epochNumber:  9, depositStart: "2026-07-26", activeStart: "2026-07-30", settlementDate: "2026-08-28", strike: 3300, expiryDays: 30, premiumCollected: 31, outcome: "exercised",         pnlPct: -0.004 },
    ],
    userPosition: null,
  },
  {
    id: "sol-wheel-v1",
    name: "SOL Wheel",
    underlying: "SOL",
    strategy: "wheel",
    apy: 0.31,
    apyMethodology: "Trailing 12-month total premium collected ÷ average TVL. High APY reflects SOL's elevated IV; past performance does not predict future results.",
    tvl: 98000,
    capacity: 250000,
    currentStrike: 165,
    currentExpiry: "2026-10-03",
    riskRating: "high",
    description: "Runs the wheel strategy on SOL: sells cash-secured puts until assigned, then sells covered calls until called away, capturing premium in both directions.",
    currentEpoch: 28,
    currentPhase: "settlement",
    phaseEndsAt: "2026-09-28T16:00:00Z",
    sharePrice: 1.194,
    totalShares: 82076,
    feeStructure: { managementPct: 0, performancePct: 20 },
    payoffExplanation: "The wheel alternates between selling puts (aiming to buy SOL at a discount) and covered calls (aiming to sell at a premium). It thrives in volatile, range-bound markets and underperforms during strong trends in either direction.",
    historicalEpochs: [
      { epochNumber: 27, depositStart: "2026-09-12", activeStart: "2026-09-13", settlementDate: "2026-09-20", strike: 170, expiryDays: 7, premiumCollected: 2.8, outcome: "expired_worthless", pnlPct: 0.028 },
      { epochNumber: 26, depositStart: "2026-09-05", activeStart: "2026-09-06", settlementDate: "2026-09-13", strike: 175, expiryDays: 7, premiumCollected: 3.2, outcome: "exercised",         pnlPct: 0.011 },
    ],
    userPosition: null,
  },
];

// ---------------------------------------------------------------------------
// Public adapter
// ---------------------------------------------------------------------------

export async function fetchVaults(): Promise<VaultSummary[]> {
  if (process.env.NEXT_PUBLIC_VAULTS === "live") {
    // TODO: return apiGet<VaultSummary[]>("/api/v1/vaults");
    throw new Error("Live vaults API not yet implemented");
  }
  return Promise.resolve(MOCK_VAULTS.map(({ historicalEpochs, userPosition, ...summary }) => summary));
}

export async function fetchVaultDetail(id: string, _token?: string | null): Promise<VaultDetail | null> {
  if (process.env.NEXT_PUBLIC_VAULTS === "live") {
    // TODO: return apiGet<VaultDetail>(`/api/v1/vaults/${id}`, token);
    throw new Error("Live vaults API not yet implemented");
  }
  return Promise.resolve(MOCK_VAULTS.find(v => v.id === id) ?? null);
}

// ---------------------------------------------------------------------------
// Wallet vault positions (portfolio / account surfaces)
// ---------------------------------------------------------------------------

/** NAV older than this is flagged as stale instead of being presented as current. */
export const NAV_STALE_AFTER_MS = 15 * 60 * 1000;

/** Wire shape of one vault position from GET /api/v1/vaults/positions. */
export interface VaultPositionWire {
  vault_id: string;
  name: string;
  strategy: VaultStrategy;
  /** Shares held, including any queued for redemption. */
  shares: number;
  pending_withdrawal_shares: number;
  /** USD deposits queued for the next epoch, not yet minted into shares. */
  pending_deposit_usd: number;
  nav_per_share: number;
  /** Total USD paid in for all shares held. */
  cost_basis_usd: number;
  nav_as_of: string; // ISO
  /** Set instead of the position fields when this vault's data failed to load. */
  error?: string;
}

/** A wallet's position in one vault, normalised for display and aggregation. */
export interface VaultPositionRow {
  vaultId: string;
  name: string;
  strategy: VaultStrategy;
  /** Settled shares only — queued redemptions are excluded. */
  shares: number;
  navPerShare: number;
  /** Settled shares × NAV per share. */
  currentValue: number;
  /** Cost basis of the settled shares. */
  costBasis: number;
  unrealisedPnl: number;
  /** Queued redemptions (at NAV) plus queued deposits, shown as pending. */
  pendingValue: number;
  navAsOf: string; // ISO
  navStale: boolean;
}

export interface VaultPositionFailure {
  vaultId: string;
  name: string;
  message: string;
}

export interface VaultPositionsResult {
  rows: VaultPositionRow[];
  /** Vaults whose data failed to load. They are excluded from every total. */
  failed: VaultPositionFailure[];
}

export interface VaultPortfolioTotals {
  currentValue: number;
  pendingValue: number;
  costBasis: number;
  unrealisedPnl: number;
  staleCount: number;
}

function toPositionRow(w: VaultPositionWire, now: number): VaultPositionRow {
  const settledShares = Math.max(0, w.shares - w.pending_withdrawal_shares);
  const currentValue = settledShares * w.nav_per_share;
  const costBasis = w.shares > 0 ? (w.cost_basis_usd * settledShares) / w.shares : 0;
  return {
    vaultId: w.vault_id,
    name: w.name,
    strategy: w.strategy,
    shares: settledShares,
    navPerShare: w.nav_per_share,
    currentValue,
    costBasis,
    unrealisedPnl: currentValue - costBasis,
    pendingValue: w.pending_withdrawal_shares * w.nav_per_share + w.pending_deposit_usd,
    navAsOf: w.nav_as_of,
    navStale: now - Date.parse(w.nav_as_of) > NAV_STALE_AFTER_MS,
  };
}

/**
 * Wallet vault positions. Live reads the BFF (bearer token stays server-side);
 * otherwise the mock vault data is the only source.
 */
export async function fetchVaultPositions(): Promise<VaultPositionsResult> {
  const now = Date.now();
  let wire: VaultPositionWire[];

  if (process.env.NEXT_PUBLIC_VAULTS === "live") {
    const res = await bffFetch("/api/v1/vaults/positions");
    if (!res.ok) throw new Error(`Vault positions request failed (${res.status})`);
    wire = (await res.json()) as VaultPositionWire[];
  } else {
    wire = MOCK_VAULTS.flatMap(v => {
      const p = v.userPosition;
      if (!p) return [];
      return [{
        vault_id: v.id,
        name: v.name,
        strategy: v.strategy,
        shares: p.shares,
        pending_withdrawal_shares: p.pendingWithdrawal,
        pending_deposit_usd: 0,
        nav_per_share: v.sharePrice,
        // Mock cost basis is the principal: total value less accrued premium.
        cost_basis_usd: p.totalValue - p.accruedPremium,
        nav_as_of: new Date(now).toISOString(),
      }];
    });
  }

  const rows: VaultPositionRow[] = [];
  const failed: VaultPositionFailure[] = [];
  for (const w of wire) {
    if (w.error) failed.push({ vaultId: w.vault_id, name: w.name, message: w.error });
    else rows.push(toPositionRow(w, now));
  }
  return { rows, failed };
}

/** Totals across settled rows. Stale rows are counted but flagged via `staleCount`. */
export function aggregateVaultPositions(rows: VaultPositionRow[]): VaultPortfolioTotals {
  return rows.reduce<VaultPortfolioTotals>(
    (t, r) => ({
      currentValue: t.currentValue + r.currentValue,
      pendingValue: t.pendingValue + r.pendingValue,
      costBasis: t.costBasis + r.costBasis,
      unrealisedPnl: t.unrealisedPnl + r.unrealisedPnl,
      staleCount: t.staleCount + (r.navStale ? 1 : 0),
    }),
    { currentValue: 0, pendingValue: 0, costBasis: 0, unrealisedPnl: 0, staleCount: 0 },
  );
}

export async function depositToVault(
  id: string,
  amount: number,
  _token: string
): Promise<{ tx_id: string }> {
  if (process.env.NEXT_PUBLIC_VAULTS === "live") {
    // TODO: return apiPost<{tx_id:string}>(`/api/v1/vaults/${id}/deposit`, { amount }, token);
    throw new Error("Live vaults API not yet implemented");
  }
  // Mock: simulate a 600ms network round-trip
  await new Promise(r => setTimeout(r, 600));
  return { tx_id: `mock-tx-deposit-${id}-${amount.toFixed(0)}-${Date.now()}` };
}

export async function withdrawFromVault(
  id: string,
  shares: number,
  _token: string
): Promise<{ tx_id: string; queued: boolean }> {
  if (process.env.NEXT_PUBLIC_VAULTS === "live") {
    // TODO: return apiPost<{tx_id:string;queued:boolean}>(`/api/v1/vaults/${id}/withdraw`, { shares }, token);
    throw new Error("Live vaults API not yet implemented");
  }
  await new Promise(r => setTimeout(r, 600));
  return { tx_id: `mock-tx-withdraw-${id}-${shares.toFixed(0)}-${Date.now()}`, queued: true };
}
