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
 *   POST /api/v1/vaults/{id}/withdraw  { shares: number }  → { tx_id: string; queued: boolean; request_id: string }
 *   POST /api/v1/vaults/{id}/withdrawals/{request_id}/cancel → { returned_shares: number }
 *
 * Withdrawal queue semantics (mock implements these; the live contract must match):
 *
 *   - Request: shares are escrowed on request. Escrowed shares stay in totalShares
 *     (so NAV per share is unaffected by the queue) but cannot be requested again.
 *   - Ordering: requests are served by (request epoch, then seq). Requests from an
 *     earlier epoch are always served first. `seq` is a monotonic tie-break assigned
 *     at request time. Unfilled requests keep their epoch, seq and requestedAt.
 *   - Fill: each epoch cohort is valued at the processing NAV. If the remaining
 *     liquidity covers the cohort, every request fills 100%. If it does not, every
 *     request in that cohort fills the same pro-rata fraction, and later cohorts get
 *     nothing this pass. `fillFraction` is recorded per request.
 *   - Processing: a keeper calls `processWithdrawalQueue` at an epoch boundary with the
 *     NAV per share and liquidity at that point. At most MAX_COHORTS_PER_PASS cohorts
 *     are examined per call. Filled shares leave totalShares and the user's shares.
 *   - Settlement NAV: a processed request pays out at the NAV passed to the keeper,
 *     not the NAV at request time.
 *   - Cancellation: only requests still in the queue can be cancelled. The escrow that
 *     remains is returned in full. Any part already filled stays paid out.
 *   - Pause: not modeled in the mock. The intended rule is that a paused vault blocks new
 *     requests but still processes queued ones.
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
  pendingWithdrawal: number; // shares escrowed in unprocessed withdrawal requests
}

export type WithdrawalStatus = "queued" | "processed" | "cancelled";

/** One redemption request in a vault's withdrawal queue. */
export interface WithdrawalRequest {
  id: string;
  vaultId: string;
  /** Epoch the request was made in. Earlier epochs are served first. */
  requestEpoch: number;
  /** Monotonic tie-break within an epoch, assigned at request time. */
  seq: number;
  /** ISO time of the original request. Kept when unfilled requests carry forward. */
  requestedAt: string;
  requestedShares: number;
  /** Shares still escrowed and not yet redeemed. */
  escrowedShares: number;
  filledShares: number;
  /** filledShares / requestedShares, 0–1. Updated on every processing pass. */
  fillFraction: number;
  /** USD paid out, summed over every pass at that pass's processing NAV. */
  payoutUsd: number;
  status: WithdrawalStatus;
}

/** State of the vault at the point where the withdrawal queue is processed. */
export interface ProcessingPoint {
  /** NAV per share at processing. Requests settle at this price. */
  navPerShare: number;
  /** USD of liquid capital available to pay out. */
  liquidityUsd: number;
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
// Withdrawal queue (mock state)
// ---------------------------------------------------------------------------

/** Append-only. Status changes in place; entries are never removed. */
const WITHDRAWAL_QUEUE: WithdrawalRequest[] = [];
let nextWithdrawalSeq = 1;

/** Max epoch cohorts examined per keeper call, so a large queue cannot block. */
const MAX_COHORTS_PER_PASS = 10;

function escrowedShares(vaultId: string): number {
  return WITHDRAWAL_QUEUE
    .filter(r => r.vaultId === vaultId && r.status === "queued")
    .reduce((sum, r) => sum + r.escrowedShares, 0);
}

/**
 * Keeper entry point. Call at an epoch boundary with the NAV and liquidity at that point.
 * Serves queued requests by (requestEpoch, seq). Each epoch cohort is filled whole
 * when liquidity covers it. Otherwise every request in that cohort gets the same
 * pro-rata fraction and later cohorts wait for the next pass. Returns the requests
 * whose state changed.
 */
export function processWithdrawalQueue(vaultId: string, point: ProcessingPoint): WithdrawalRequest[] {
  const vault = MOCK_VAULTS.find(v => v.id === vaultId);
  if (!vault?.userPosition) return [];
  if (!(point.navPerShare > 0)) throw new Error("Processing NAV must be positive");

  const queued = WITHDRAWAL_QUEUE
    .filter(r => r.vaultId === vaultId && r.status === "queued")
    .sort((a, b) => a.requestEpoch - b.requestEpoch || a.seq - b.seq);

  const cohorts: WithdrawalRequest[][] = [];
  for (const r of queued) {
    const last = cohorts[cohorts.length - 1];
    if (last && last[0].requestEpoch === r.requestEpoch) last.push(r);
    else cohorts.push([r]);
  }

  const touched: WithdrawalRequest[] = [];
  let liquidity = point.liquidityUsd;
  let redeemedShares = 0;
  for (const cohort of cohorts.slice(0, MAX_COHORTS_PER_PASS)) {
    if (liquidity <= 0) break;
    const cohortValue = cohort.reduce((sum, r) => sum + r.escrowedShares * point.navPerShare, 0);
    const fraction = Math.min(1, liquidity / cohortValue);
    for (const r of cohort) {
      const shares = r.escrowedShares * fraction;
      r.escrowedShares -= shares;
      r.filledShares += shares;
      r.payoutUsd += shares * point.navPerShare;
      r.fillFraction = r.filledShares / r.requestedShares;
      if (r.escrowedShares <= 1e-9) {
        r.escrowedShares = 0;
        r.status = "processed";
      }
      redeemedShares += shares;
      touched.push(r);
    }
    liquidity -= cohortValue * fraction;
  }

  // Redeemed shares leave the supply. Escrowed-but-unfilled shares stay in it.
  vault.userPosition.shares -= redeemedShares;
  vault.totalShares -= redeemedShares;
  return touched;
}

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
  const vault = MOCK_VAULTS.find(v => v.id === id);
  if (!vault) return Promise.resolve(null);
  const userPosition = vault.userPosition && { ...vault.userPosition, pendingWithdrawal: escrowedShares(id) };
  return Promise.resolve({ ...vault, userPosition });
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
): Promise<{ tx_id: string; queued: boolean; request_id: string }> {
  if (process.env.NEXT_PUBLIC_VAULTS === "live") {
    // TODO: return apiPost<{tx_id:string;queued:boolean;request_id:string}>(`/api/v1/vaults/${id}/withdraw`, { shares }, token);
    throw new Error("Live vaults API not yet implemented");
  }
  await new Promise(r => setTimeout(r, 600));
  const vault = MOCK_VAULTS.find(v => v.id === id);
  if (!vault?.userPosition) throw new Error("No position in this vault");
  if (!(shares > 0)) throw new Error("Shares must be positive");
  // Escrowed shares are already counted against the position, so they cannot be requested twice.
  const available = vault.userPosition.shares - escrowedShares(id);
  if (shares > available) throw new Error(`Only ${available} shares available to withdraw`);

  const request: WithdrawalRequest = {
    id: `wd-${nextWithdrawalSeq}`,
    vaultId: id,
    requestEpoch: vault.currentEpoch,
    seq: nextWithdrawalSeq++,
    requestedAt: new Date().toISOString(),
    requestedShares: shares,
    escrowedShares: shares,
    filledShares: 0,
    fillFraction: 0,
    payoutUsd: 0,
    status: "queued",
  };
  WITHDRAWAL_QUEUE.push(request);
  return { tx_id: `mock-tx-withdraw-${id}-${shares.toFixed(0)}-${Date.now()}`, queued: true, request_id: request.id };
}

export async function cancelWithdrawal(requestId: string, _token: string): Promise<{ returned_shares: number }> {
  if (process.env.NEXT_PUBLIC_VAULTS === "live") {
    // TODO: return apiPost<{returned_shares:number}>(`/api/v1/vaults/{id}/withdrawals/${requestId}/cancel`, {}, token);
    throw new Error("Live vaults API not yet implemented");
  }
  await new Promise(r => setTimeout(r, 600));
  const request = WITHDRAWAL_QUEUE.find(r => r.id === requestId);
  if (!request) throw new Error(`Unknown withdrawal request ${requestId}`);
  if (request.status !== "queued") throw new Error("Only queued withdrawals can be cancelled");
  // Escrow is released. Any part already filled was paid out and is not reversed.
  const returned = request.escrowedShares;
  request.escrowedShares = 0;
  request.status = "cancelled";
  return { returned_shares: returned };
}
