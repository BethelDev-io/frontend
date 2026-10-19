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

// ---------------------------------------------------------------------------
// Operator console
//
// Internal-only surface for vault operators. Every call goes through the BFF
// (/api/bff/...), which attaches the session token server-side. Operator
// authorization is enforced by the backend: a non-operator gets 403 and no
// state changes. Parameter changes never write directly; they return a
// governance proposal id.
// ---------------------------------------------------------------------------

/** Above this indexer lag, state is stale and unsafe actions are disabled. */
export const INDEXER_LAG_LIMIT_SECONDS = 60;

export interface StuckQueueAlert {
  id: string;
  epoch: number;
  openedAt: string; // ISO
  unfulfilledTickets: number;
}

export interface VaultOperatorStatus {
  vaultId: string;
  currentEpoch: number;
  epochState: EpochPhase;
  lastRolloverAt: string; // ISO
  pendingRedemptions: number; // unfulfilled redemption tickets
  capacityUtilisation: number; // 0–1
  indexerUpdatedAt: string; // ISO — when the indexer last caught up
  paused: boolean;
  stuckQueueAlerts: StuckQueueAlert[];
}

export type OperatorAction =
  | "rollover"
  | "pause"
  | "resume"
  | "resolve_alert"
  | "parameter_change";

export interface OperatorAuditEntry {
  id: string;
  actor: string;
  vaultId: string;
  action: OperatorAction;
  before: string;
  after: string;
  timestamp: string; // ISO
}

export type VaultParameterKey = "managementPct" | "performancePct" | "capacity";

export interface ParameterChangeRequest {
  key: VaultParameterKey;
  value: number;
}

export interface ParameterChangeResult {
  proposal_id: string;
}

/** Thrown with `status` so the UI can handle 409 (stale epoch) distinctly. */
export class OperatorApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "OperatorApiError";
  }
}

function csrfToken(): string {
  const m = document.cookie.match(/(?:^|; )(?:__Host-)?zenith_csrf=([^;]*)/);
  return m ? decodeURIComponent(m[1]) : "";
}

async function operatorRequest<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/bff${path}`, {
    method,
    credentials: "same-origin",
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(method !== "GET" ? { "x-zenith-csrf": csrfToken() } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => null);
    throw new OperatorApiError(
      typeof err?.error === "string" ? err.error : `Request failed (${res.status})`,
      res.status,
    );
  }
  return res.json() as Promise<T>;
}

const MOCK_OPERATOR_DELAY_MS = 400;
const mockDelay = () => new Promise(r => setTimeout(r, MOCK_OPERATOR_DELAY_MS));

const mockOperatorStatus = new Map<string, VaultOperatorStatus>(
  MOCK_VAULTS.map(v => [v.id, {
    vaultId: v.id,
    currentEpoch: v.currentEpoch,
    epochState: v.currentPhase,
    lastRolloverAt: v.historicalEpochs[0]?.activeStart ?? v.phaseEndsAt,
    pendingRedemptions: v.id === "sol-wheel-v1" ? 3 : 0,
    capacityUtilisation: v.tvl / v.capacity,
    indexerUpdatedAt: new Date(Date.now() - 12_000).toISOString(),
    paused: false,
    stuckQueueAlerts: v.id === "sol-wheel-v1"
      ? [{ id: "alert-sol-1", epoch: v.currentEpoch, openedAt: v.phaseEndsAt, unfulfilledTickets: 3 }]
      : [],
  }]),
);
const mockAuditLog: OperatorAuditEntry[] = [];

function mockAudit(entry: Omit<OperatorAuditEntry, "id" | "actor" | "timestamp">) {
  mockAuditLog.unshift({
    id: `mock-audit-${mockAuditLog.length + 1}`,
    actor: "mock-operator",
    timestamp: new Date().toISOString(),
    ...entry,
  });
}

function mockStatusFor(id: string): VaultOperatorStatus {
  const status = mockOperatorStatus.get(id);
  if (!status) throw new OperatorApiError("Vault not found", 404);
  return status;
}

/** Operator dashboard state for one vault. */
export async function fetchOperatorStatus(id: string): Promise<VaultOperatorStatus> {
  if (process.env.NEXT_PUBLIC_VAULTS === "live") {
    return operatorRequest<VaultOperatorStatus>("GET", `/api/v1/operator/vaults/${id}/status`);
  }
  await mockDelay();
  return { ...mockStatusFor(id) };
}

/**
 * Trigger (or retry) epoch rollover. `expectedEpoch` is the epoch the operator
 * saw; the backend rejects with 409 if the vault has already moved on.
 */
export async function triggerRollover(id: string, expectedEpoch: number): Promise<VaultOperatorStatus> {
  if (process.env.NEXT_PUBLIC_VAULTS === "live") {
    return operatorRequest<VaultOperatorStatus>("POST", `/api/v1/operator/vaults/${id}/rollover`, { expected_epoch: expectedEpoch });
  }
  await mockDelay();
  const status = mockStatusFor(id);
  if (status.currentEpoch !== expectedEpoch) {
    throw new OperatorApiError(`Stale epoch: vault is on epoch ${status.currentEpoch}`, 409);
  }
  const next: VaultOperatorStatus = {
    ...status,
    currentEpoch: status.currentEpoch + 1,
    epochState: "deposit",
    lastRolloverAt: new Date().toISOString(),
  };
  mockOperatorStatus.set(id, next);
  mockAudit({ vaultId: id, action: "rollover", before: `epoch ${expectedEpoch}`, after: `epoch ${next.currentEpoch}` });
  return { ...next };
}

export async function pauseVault(id: string): Promise<VaultOperatorStatus> {
  if (process.env.NEXT_PUBLIC_VAULTS === "live") {
    return operatorRequest<VaultOperatorStatus>("POST", `/api/v1/operator/vaults/${id}/pause`);
  }
  await mockDelay();
  const next = { ...mockStatusFor(id), paused: true };
  mockOperatorStatus.set(id, next);
  mockAudit({ vaultId: id, action: "pause", before: "unpaused", after: "paused" });
  return { ...next };
}

export async function resumeVault(id: string): Promise<VaultOperatorStatus> {
  if (process.env.NEXT_PUBLIC_VAULTS === "live") {
    return operatorRequest<VaultOperatorStatus>("POST", `/api/v1/operator/vaults/${id}/resume`);
  }
  await mockDelay();
  const next = { ...mockStatusFor(id), paused: false };
  mockOperatorStatus.set(id, next);
  mockAudit({ vaultId: id, action: "resume", before: "paused", after: "unpaused" });
  return { ...next };
}

/** Acknowledge and resolve a stuck-queue alert. */
export async function resolveStuckAlert(vaultId: string, alertId: string): Promise<VaultOperatorStatus> {
  if (process.env.NEXT_PUBLIC_VAULTS === "live") {
    return operatorRequest<VaultOperatorStatus>("POST", `/api/v1/operator/vaults/${vaultId}/alerts/${alertId}/resolve`);
  }
  await mockDelay();
  const status = mockStatusFor(vaultId);
  if (!status.stuckQueueAlerts.some(a => a.id === alertId)) {
    throw new OperatorApiError("Alert not found", 404);
  }
  const next = { ...status, stuckQueueAlerts: status.stuckQueueAlerts.filter(a => a.id !== alertId) };
  mockOperatorStatus.set(vaultId, next);
  mockAudit({ vaultId, action: "resolve_alert", before: `alert ${alertId} open`, after: `alert ${alertId} resolved` });
  return { ...next };
}

/**
 * Submit a parameter change. This only opens a governance proposal; the
 * vault's parameters change when the proposal passes the approval path.
 */
export async function submitParameterChange(id: string, change: ParameterChangeRequest, before: number): Promise<ParameterChangeResult> {
  if (process.env.NEXT_PUBLIC_VAULTS === "live") {
    return operatorRequest<ParameterChangeResult>("POST", `/api/v1/operator/vaults/${id}/parameter-changes`, change);
  }
  await mockDelay();
  mockStatusFor(id);
  mockAudit({ vaultId: id, action: "parameter_change", before: `${change.key} ${before}`, after: `${change.key} ${change.value} (pending approval)` });
  return { proposal_id: `mock-proposal-${id}-${Date.now()}` };
}

/** Audit log of operator actions, newest first. Optionally filtered to one vault. */
export async function fetchOperatorAuditLog(vaultId?: string): Promise<OperatorAuditEntry[]> {
  if (process.env.NEXT_PUBLIC_VAULTS === "live") {
    const q = vaultId ? `?vault_id=${encodeURIComponent(vaultId)}` : "";
    return operatorRequest<OperatorAuditEntry[]>("GET", `/api/v1/operator/audit-log${q}`);
  }
  await mockDelay();
  return mockAuditLog.filter(e => !vaultId || e.vaultId === vaultId).map(e => ({ ...e }));
}
