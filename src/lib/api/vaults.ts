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
// Event notifications
// ---------------------------------------------------------------------------

export type VaultEventType =
  | "epoch_opened"
  | "epoch_closed"
  | "nav_published"
  | "premium_collected"
  | "assignment"
  | "redemption_claimable"
  | "redemption_expired"
  | "vault_paused"
  | "vault_unpaused"
  | "capacity_reached"
  | "nav_drift";
export type VaultNotificationSeverity = "info" | "warning" | "critical";
export type VaultNotificationChannel = "in_app" | "email" | "webhook";

/** A vault event from the indexer. `eventId` is the on-chain identity used for dedupe. */
export interface VaultEvent {
  eventId: string;
  type: VaultEventType;
  vaultId: string;
  epoch: number;
  occurredAt: string; // ISO
  /** Optional numeric payload, e.g. the published NAV for `nav_published`. */
  value?: number;
}

export interface VaultEventRoute {
  severity: VaultNotificationSeverity;
  channels: VaultNotificationChannel[];
  /** Events older than this are dropped so historical backfills don't flood the feed. */
  staleAfterMs: number;
  /** Epoch-cadence events are not sent while the vault is paused. */
  suppressWhenPaused: boolean;
  /** Security-relevant events ignore quiet hours so they meet their severity SLA. */
  bypassQuietHours: boolean;
  /** Only depositors with a non-zero balance receive the event. */
  requiresBalance: boolean;
}

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const ALL_CHANNELS: VaultNotificationChannel[] = ["in_app", "email", "webhook"];

/** Routing table: default severity, channels, and delivery guards per event type. */
export const VAULT_EVENT_ROUTING: Record<VaultEventType, VaultEventRoute> = {
  epoch_opened: { severity: "info", channels: ALL_CHANNELS, staleAfterMs: 6 * HOUR_MS, suppressWhenPaused: true, bypassQuietHours: false, requiresBalance: false },
  epoch_closed: { severity: "info", channels: ALL_CHANNELS, staleAfterMs: 6 * HOUR_MS, suppressWhenPaused: true, bypassQuietHours: false, requiresBalance: true },
  nav_published: { severity: "info", channels: ["in_app", "webhook"], staleAfterMs: 6 * HOUR_MS, suppressWhenPaused: false, bypassQuietHours: false, requiresBalance: true },
  premium_collected: { severity: "info", channels: ["in_app"], staleAfterMs: DAY_MS, suppressWhenPaused: false, bypassQuietHours: false, requiresBalance: true },
  assignment: { severity: "warning", channels: ALL_CHANNELS, staleAfterMs: DAY_MS, suppressWhenPaused: false, bypassQuietHours: false, requiresBalance: true },
  redemption_claimable: { severity: "warning", channels: ALL_CHANNELS, staleAfterMs: 2 * DAY_MS, suppressWhenPaused: false, bypassQuietHours: false, requiresBalance: true },
  redemption_expired: { severity: "warning", channels: ALL_CHANNELS, staleAfterMs: 2 * DAY_MS, suppressWhenPaused: false, bypassQuietHours: false, requiresBalance: true },
  vault_paused: { severity: "critical", channels: ALL_CHANNELS, staleAfterMs: DAY_MS, suppressWhenPaused: false, bypassQuietHours: true, requiresBalance: false },
  vault_unpaused: { severity: "warning", channels: ALL_CHANNELS, staleAfterMs: DAY_MS, suppressWhenPaused: false, bypassQuietHours: true, requiresBalance: false },
  capacity_reached: { severity: "info", channels: ["in_app", "email"], staleAfterMs: DAY_MS, suppressWhenPaused: false, bypassQuietHours: false, requiresBalance: false },
  nav_drift: { severity: "critical", channels: ALL_CHANNELS, staleAfterMs: 6 * HOUR_MS, suppressWhenPaused: false, bypassQuietHours: true, requiresBalance: true },
};

/** Versioned copy catalog key for an event type. Copy lives in `messages/*.json`. */
export function vaultNotificationCopyKey(type: VaultEventType): string {
  return `vaults.notifications.v1.${type}`;
}

export interface VaultNotificationPreferences {
  /** Per-event-type channel opt-ins. Missing types fall back to the routing table defaults. */
  events: Partial<Record<VaultEventType, VaultNotificationChannel[]>>;
  /** Global unsubscribe. Routing is evaluated at delivery time, so this takes effect immediately. */
  unsubscribed: boolean;
  /** Quiet hours in UTC. Non-bypass events are deferred, not dropped, while quiet. */
  quietHours?: { startHourUtc: number; endHourUtc: number };
}

export interface VaultEventContext {
  now: Date;
  vaultPaused: boolean;
  depositorBalance: number;
  /** True when the depositor's email is on the hard-bounce suppression list. */
  emailSuppressed?: boolean;
}

export interface VaultEventRouting {
  /** Channels to deliver to now. */
  deliver: VaultNotificationChannel[];
  /** Channels to deliver once quiet hours end. */
  deferred: VaultNotificationChannel[];
}

function inQuietHours(now: Date, quietHours?: VaultNotificationPreferences["quietHours"]): boolean {
  if (!quietHours) return false;
  const hour = now.getUTCHours();
  const { startHourUtc: start, endHourUtc: end } = quietHours;
  return start <= end ? hour >= start && hour < end : hour >= start || hour < end;
}

/** Decides which channels a depositor receives a single event on. Pure: no I/O. */
export function routeVaultEvent(
  event: VaultEvent,
  prefs: VaultNotificationPreferences,
  ctx: VaultEventContext
): VaultEventRouting {
  const route = VAULT_EVENT_ROUTING[event.type];
  const none: VaultEventRouting = { deliver: [], deferred: [] };

  if (prefs.unsubscribed) return none;
  if (ctx.now.getTime() - Date.parse(event.occurredAt) > route.staleAfterMs) return none;
  if (route.suppressWhenPaused && ctx.vaultPaused) return none;
  if (route.requiresBalance && ctx.depositorBalance <= 0) return none;

  const optedIn = prefs.events[event.type] ?? route.channels;
  const channels = route.channels.filter(c => optedIn.includes(c) && !(c === "email" && ctx.emailSuppressed));

  if (!route.bypassQuietHours && inQuietHours(ctx.now, prefs.quietHours)) {
    return { deliver: channels.filter(c => c === "in_app"), deferred: channels.filter(c => c !== "in_app") };
  }
  return { deliver: channels, deferred: [] };
}

/** Notification identity: one row per (event, depositor, channel), so replays are idempotent. */
export function vaultNotificationKey(eventId: string, depositor: string, channel: VaultNotificationChannel): string {
  return `${eventId}:${depositor}:${channel}`;
}

/** Keeps the first occurrence of each on-chain event. */
export function dedupeVaultEvents(events: VaultEvent[]): VaultEvent[] {
  const seen = new Set<string>();
  return events.filter(e => {
    if (seen.has(e.eventId)) return false;
    seen.add(e.eventId);
    return true;
  });
}

/** Orders events per vault by epoch, then occurrence time, so a vault's feed never runs backwards. */
export function orderVaultEvents(events: VaultEvent[]): VaultEvent[] {
  return [...events].sort(
    (a, b) =>
      a.vaultId.localeCompare(b.vaultId) ||
      a.epoch - b.epoch ||
      Date.parse(a.occurredAt) - Date.parse(b.occurredAt) ||
      a.eventId.localeCompare(b.eventId)
  );
}

/** Mock in-app feed: deduped and ordered, the same shape the live BFF route should return. */
export async function fetchVaultEventFeed(_token?: string | null): Promise<VaultEvent[]> {
  if (process.env.NEXT_PUBLIC_VAULTS === "live") {
    // TODO: return apiGet<VaultEvent[]>("/api/v1/vaults/events", token);
    throw new Error("Live vaults API not yet implemented");
  }
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
  const mock: VaultEvent[] = [
    { eventId: "mock-evt-2", type: "epoch_closed", vaultId: "xlm-cc-v1", epoch: 47, occurredAt: ago(30 * MINUTE_MS) },
    { eventId: "mock-evt-1", type: "epoch_opened", vaultId: "xlm-cc-v1", epoch: 48, occurredAt: ago(10 * MINUTE_MS) },
  ];
  return Promise.resolve(orderVaultEvents(dedupeVaultEvents(mock)));
}
