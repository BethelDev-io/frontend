import { apiGet, apiPost } from "./client";

/**
 * Typed data adapter interface for the Vaults feature.
 *
 * The Phase 2 options vault contract is scaffolded under `contracts/vault`
 * (crate `zenith-options-vault`), but it is not yet deployed and the backend
 * API is not yet available. This module is unrelated to the margin-collateral
 * vault in `./vault.ts`. When NEXT_PUBLIC_VAULTS=mock (or the env var is absent), the mock
 * implementation below is used. Swap in the real implementation by
 * setting NEXT_PUBLIC_VAULTS=live, which calls the backend vault registry
 * (Zenith-options/backend) through the REST contract below.
 *
 * Backend contract (for when the real API lands):
 *
 *   GET /api/v1/vaults?cursor=<opaque>&limit=<n>
 *   → { items: VaultSummary[]; nextCursor: string | null; cache: CacheMeta }
 *
 *   GET /api/v1/vaults/{id}
 *   → VaultDetail
 *
 *   GET /api/v1/vaults/{id}/epochs?cursor=<opaque>&limit=<n>
 *   → { items: EpochRecord[]; nextCursor: string | null; cache: CacheMeta }
 *
 *   POST /api/v1/vaults/{id}/deposit   { amount: number; disclosure_version: string }  → { tx_id: string }
 *   POST /api/v1/vaults/{id}/withdraw  { shares: number }  → { tx_id: string; queued: boolean; request_id: string }
 *   POST /api/v1/vaults/{id}/withdrawals/{request_id}/cancel → { returned_shares: number }
 *
 *   POST /api/v1/vaults/disclosures/acknowledge
 *     { disclosure_version, text_hash, jurisdiction_attested }  → DisclosureAcknowledgement
 *   GET  /api/v1/vaults/disclosures/me  → DisclosureAcknowledgement[]
 *
 * Deposits are rejected server-side (403 with a PolicyReasonCode) unless the
 * wallet holds an acknowledgement for the current disclosure version. The
 * client check in the UI is advisory only.
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
 *
 * Pagination & caching (issue #223):
 *   - List and epoch-history reads are cursor-paginated (never offset). The
 *     cursor is an opaque token over a stable sort key (vault id / epoch
 *     number), so inserting a new epoch mid-pagination neither skips nor
 *     duplicates rows. Page size is capped at VAULT_MAX_PAGE_SIZE.
 *   - Responses carry `cache` freshness metadata so the UI can show whether
 *     NAV values are live or served from cache.
 *
 * Security baseline (issue #220):
 *   - Writes require the `vault:deposit` / `vault:withdraw` scope; the BFF
 *     rejects with 403 when the session token lacks it.
 *   - Writes carry an `Idempotency-Key` header so a legitimately retried
 *     deposit is not double-submitted.
 *   - Amounts/shares are validated client-side (finite, positive, bounded
 *     precision) before they reach the contract layer.
 *   - Rate limits are per-wallet (primary) and per-IP (secondary); a 429
 *     response includes a `retryAfter` hint in seconds.
 *
 * Loss recognition & insolvency (issue #225):
 *   - A realized loss larger than premium + reserves is allocated by a
 *     deterministic waterfall: fee reserves → first-loss buffer → pro-rata
 *     share write-down. Any residual beyond total NAV is recorded as explicit
 *     protocol bad debt (never an underflow).
 *   - NAV per share is clamped at zero and never reported negative.
 *   - While an unresolved loss event exists the vault is `impaired` and
 *     deposits are disabled.
 */

import { toCsv, type CsvColumn } from "../csv";

export type VaultStrategy ="covered_call" | "cash_secured_put" | "iron_condor" | "wheel";
export type RiskRating = "low" | "medium" | "high";
export type EpochPhase = "deposit" | "active" | "settlement";

/**
 * Operational state of a vault. `impaired` means an unresolved loss event
 * exists: NAV has been written down and deposits are disabled until the loss
 * is fully absorbed / the vault recovers.
 */
export type VaultState = "healthy" | "impaired" | "underwater";

/** Explicit scopes carried on the session/token for vault operations. */
export type VaultScope =
  | "vault:read"
  | "vault:deposit"
  | "vault:withdraw"
  | "vault:operator";

/** Maximum decimal places accepted for deposit amounts / share quantities. */
export const VAULT_AMOUNT_MAX_DECIMALS = 7;

/** Hard cap on page size for cursor-paginated vault/epoch reads. */
export const VAULT_MAX_PAGE_SIZE = 100;

/** Default page size when the caller does not specify one. */
export const VAULT_DEFAULT_PAGE_SIZE = 25;

/**
 * Per-vault roles. Each vault is its own tenant boundary: a holder of a role
 * on one vault has no implicit authority over any other vault.
 *
 * - depositor: may deposit and withdraw/redeem
 * - operator: may set strategy parameters and roll epochs
 * - guardian: may pause new deposits and new epochs only (never unpause or change parameters)
 * - emergency_authority: protocol-level emergency authority, scoped to this vault
 */
export type VaultRole = "depositor" | "operator" | "guardian" | "emergency_authority";

/** One role assignment on a vault. */
export interface VaultRoleGrant {
  role: VaultRole;
  /** Account address of the role holder. */
  holder: string;
  /** ISO timestamp of when the role was granted. */
  grantedAt: string;
}

// ---------------------------------------------------------------------------
// Lifecycle state machine (see docs/vault-lifecycle.md)
// ---------------------------------------------------------------------------

export const VAULT_STATUSES = ["draft", "open", "paused", "winding_down", "closed"] as const;
export type VaultStatus = (typeof VAULT_STATUSES)[number];

/** Funds-affecting user actions gated by vault status. */
export type VaultAction = "deposit" | "withdraw";

/** Who may trigger a transition. Operator actions are governance-gated (out of scope here). */
export type VaultActor = "operator" | "guardian" | "system";

export interface VaultTransition {
  from: VaultStatus;
  to: VaultStatus;
  actor: VaultActor;
}

export const VAULT_TRANSITIONS: readonly VaultTransition[] = [
  { from: "draft", to: "open", actor: "operator" },
  { from: "open", to: "paused", actor: "guardian" },
  { from: "open", to: "winding_down", actor: "operator" },
  { from: "paused", to: "open", actor: "operator" },
  { from: "paused", to: "winding_down", actor: "operator" },
  { from: "winding_down", to: "closed", actor: "system" },
];

export interface VaultStatusPolicy {
  label: string;
  permittedActions: readonly VaultAction[];
}

export const VAULT_STATUS_POLICY: Record<VaultStatus, VaultStatusPolicy> = {
  draft:        { label: "Draft",        permittedActions: [] },
  open:         { label: "Open",         permittedActions: ["deposit", "withdraw"] },
  paused:       { label: "Paused",       permittedActions: [] },
  winding_down: { label: "Winding Down", permittedActions: ["withdraw"] },
  closed:       { label: "Closed",       permittedActions: [] },
};

/** Read-only fallback for any status this client does not know about. */
const UNKNOWN_STATUS_POLICY: VaultStatusPolicy = { label: "Unknown", permittedActions: [] };

export function isVaultStatus(status: unknown): status is VaultStatus {
  return typeof status === "string" && (VAULT_STATUSES as readonly string[]).includes(status);
}

/** Resolves policy for a raw status string. Unknown statuses are read-only, never actionable. */
export function vaultStatusPolicy(status: string): VaultStatusPolicy {
  return isVaultStatus(status) ? VAULT_STATUS_POLICY[status] : UNKNOWN_STATUS_POLICY;
}

/**
 * Applies a transition. Re-applying the current status is an idempotent no-op
 * (`changed: false`, so no history entry is written). Illegal edges or wrong actors throw.
 */
export function applyVaultTransition(
  current: VaultStatus,
  to: VaultStatus,
  actor: VaultActor
): { status: VaultStatus; changed: boolean } {
  if (current === to) return { status: current, changed: false };
  const edge = VAULT_TRANSITIONS.find(t => t.from === current && t.to === to);
  if (!edge) throw new Error(`Illegal vault transition: ${current} → ${to}`);
  if (edge.actor !== actor) throw new Error(`Actor ${actor} may not move vault ${current} → ${to}`);
  return { status: to, changed: true };
}

/** Summary shown on the /vaults listing page. */
export interface VaultSummary {
  id: string;
  name: string;
  underlying: string;
  strategy: VaultStrategy;
  status: VaultStatus;
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
  /** Current operational state; `impaired`/`underwater` disable deposits. */
  state: VaultState;
  /** True while an unresolved loss event exists (deposits disabled). */
  depositsDisabled: boolean;
  /** Epoch length (tenor) in days. */
  epochDays: number;
  /** Fees as whole percentages, e.g. performancePct: 10 = 10%. */
  feeStructure: { managementPct: number; performancePct: number };
  /** Worst peak-to-trough drawdown (0–1). Null until the vault has enough settled epochs. */
  maxDrawdownPct: number | null;
}

// ---------------------------------------------------------------------------
// Listing query: filter + sort state, shared by the index and compare views.
// Parsed from and serialized to URL search params, so views are shareable.
// ---------------------------------------------------------------------------

export const VAULT_SORT_KEYS = ["apy", "utilization", "tvl", "drawdown", "fees"] as const;
export type VaultSortKey = (typeof VAULT_SORT_KEYS)[number];
export type VaultSortDir = "asc" | "desc";

export const VAULT_STRATEGY_LABELS: Record<VaultStrategy, string> = {
  covered_call:      "Covered Call",
  cash_secured_put:  "Cash-Secured Put",
  iron_condor:       "Iron Condor",
  wheel:             "Wheel",
};

export const VAULT_STATUS_LABELS: Record<VaultStatus, string> = {
  draft:        "Draft",
  open:         "Open",
  paused:       "Paused",
  winding_down: "Winding Down",
  closed:       "Closed",
};

export const VAULT_RISK_LABELS: Record<RiskRating, string> = {
  low:    "Low",
  medium: "Medium",
  high:   "High",
};

export const VAULT_SORT_LABELS: Record<VaultSortKey, string> = {
  apy:         "APY",
  utilization: "Capacity used",
  tvl:         "TVL",
  drawdown:    "Max drawdown",
  fees:        "Fees",
};

/** Maximum vaults that can be placed side by side on the compare view. */
export const VAULT_COMPARE_MAX = 4;

export interface VaultQuery {
  strategy: VaultStrategy | null;
  underlying: string | null;
  status: VaultStatus | null;
  risk: RiskRating | null;
  /** Epoch length in days. */
  tenor: number | null;
  sort: VaultSortKey;
  dir: VaultSortDir;
  /** Vault ids selected for comparison. */
  ids: string[];
}

export const DEFAULT_VAULT_QUERY: VaultQuery = {
  strategy: null,
  underlying: null,
  status: null,
  risk: null,
  tenor: null,
  sort: "apy",
  dir: "desc",
  ids: [],
};

function pickOne<T extends string>(raw: string | null, allowed: readonly T[]): T | null {
  return raw !== null && (allowed as readonly string[]).includes(raw) ? (raw as T) : null;
}

/** Parses a comma-separated id list, dropping blanks and duplicates and capping at VAULT_COMPARE_MAX. */
export function parseVaultIds(raw: string | null): string[] {
  if (!raw) return [];
  const ids = raw.split(",").map(s => s.trim()).filter(Boolean);
  return [...new Set(ids)].slice(0, VAULT_COMPARE_MAX);
}

/**
 * Reads the query from URL search params. Unknown or malformed values degrade
 * to defaults rather than throwing. `knownUnderlyings` is the set present in the
 * loaded data, so a stale or hand-typed underlying is ignored.
 */
export function parseVaultQuery(
  source: { get(name: string): string | null },
  knownUnderlyings: readonly string[] = []
): VaultQuery {
  const underlying = source.get("underlying");
  const tenor = Number(source.get("tenor"));
  return {
    strategy: pickOne(source.get("strategy"), Object.keys(VAULT_STRATEGY_LABELS) as VaultStrategy[]),
    underlying: underlying && knownUnderlyings.includes(underlying) ? underlying : null,
    status: pickOne(source.get("status"), Object.keys(VAULT_STATUS_LABELS) as VaultStatus[]),
    risk: pickOne(source.get("risk"), Object.keys(VAULT_RISK_LABELS) as RiskRating[]),
    tenor: Number.isInteger(tenor) && tenor > 0 ? tenor : null,
    sort: pickOne(source.get("sort"), VAULT_SORT_KEYS) ?? DEFAULT_VAULT_QUERY.sort,
    dir: pickOne(source.get("dir"), ["asc", "desc"] as const) ?? DEFAULT_VAULT_QUERY.dir,
    ids: parseVaultIds(source.get("ids")),
  };
}

/** Serializes a query to a search string, omitting defaults so the default view has a clean URL. */
export function serializeVaultQuery(q: VaultQuery): string {
  const p = new URLSearchParams();
  if (q.strategy) p.set("strategy", q.strategy);
  if (q.underlying) p.set("underlying", q.underlying);
  if (q.status) p.set("status", q.status);
  if (q.risk) p.set("risk", q.risk);
  if (q.tenor) p.set("tenor", String(q.tenor));
  if (q.sort !== DEFAULT_VAULT_QUERY.sort) p.set("sort", q.sort);
  if (q.dir !== DEFAULT_VAULT_QUERY.dir) p.set("dir", q.dir);
  if (q.ids.length) p.set("ids", q.ids.join(","));
  return p.toString();
}

// ---------------------------------------------------------------------------
// Shared metric definitions. Use these wherever APY, utilization, fees or
// drawdown are shown or compared so the numbers mean the same thing everywhere.
// ---------------------------------------------------------------------------

/** Vault status, with `full` derived from TVL reaching capacity. */
export function effectiveStatus(v: VaultSummary): VaultStatus {
  return v.tvl >= v.capacity ? "full" : v.status;
}

/** Share of capacity used (0–1+). */
export function capacityUtilization(v: VaultSummary): number {
  return v.capacity > 0 ? v.tvl / v.capacity : 0;
}

/** Management plus performance fee, in whole percent. */
export function totalFeePct(v: VaultSummary): number {
  return v.feeStructure.managementPct + v.feeStructure.performancePct;
}

function sortValue(v: VaultSummary, key: VaultSortKey): number | null {
  switch (key) {
    case "apy":         return v.apy;
    case "utilization": return capacityUtilization(v);
    case "tvl":         return v.tvl;
    case "drawdown":    return v.maxDrawdownPct;
    case "fees":        return totalFeePct(v);
  }
}

export function filterVaults(vaults: readonly VaultSummary[], q: VaultQuery): VaultSummary[] {
  return vaults.filter(v =>
    (!q.strategy || v.strategy === q.strategy) &&
    (!q.underlying || v.underlying === q.underlying) &&
    (!q.status || effectiveStatus(v) === q.status) &&
    (!q.risk || v.riskRating === q.risk) &&
    (q.tenor === null || v.epochDays === q.tenor)
  );
}

/**
 * Sorts by the query's key and direction. Vaults with no value for the key
 * (e.g. no drawdown history yet) always sort last, and ties break on id so
 * the order is deterministic.
 */
export function sortVaults(vaults: readonly VaultSummary[], q: VaultQuery): VaultSummary[] {
  const sign = q.dir === "asc" ? 1 : -1;
  return [...vaults].sort((a, b) => {
    const av = sortValue(a, q.sort);
    const bv = sortValue(b, q.sort);
    if (av === null && bv === null) return a.id.localeCompare(b.id);
    if (av === null) return 1;
    if (bv === null) return -1;
    return (av - bv) * sign || a.id.localeCompare(b.id);
  });
}

/** Percent from a 0–1 fraction. Null renders as an em dash. */
export function fmtPct(n: number | null, digits = 1): string {
  return n === null ? "—" : `${(n * 100).toFixed(digits)}%`;
}

/** Whole-percent fee, e.g. 10 → "10%". */
export function fmtFeePct(n: number): string {
  return n === 0 ? "None" : `${n}%`;
}

export function fmtUsd(n: number) {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

export function fmtStrike(n: number) {
  return n >= 1000
    ? `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : `$${n.toFixed(4)}`;
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
  /** Structured loss event recognized at this epoch's close, if any. */
  lossEvent: VaultLossEvent | null;
}

/**
 * Structured loss event emitted by the vault contract and persisted in the
 * epoch ledger. Mirrors the on-chain `VaultLossEvent`.
 */
export interface VaultLossEvent {
  /** Epoch the loss is attributed to. */
  epoch: number;
  /** Total realized loss in USD recognized at this epoch close. */
  realizedLoss: number;
  /** Portion absorbed by fee/performance-fee reserves. */
  absorbedByFees: number;
  /** Portion absorbed by the first-loss buffer. */
  absorbedByBuffer: number;
  /** Portion written down pro-rata across shareholders. */
  absorbedByShares: number;
  /** Remaining first-loss buffer after the waterfall ran. */
  remainingBuffer: number;
  /** NAV per share after the write-down (clamped at zero). */
  navPerShare: number;
  /** Residual bad debt beyond total NAV (explicit, never an underflow). */
  badDebt: number;
  /** ISO timestamp the loss was recognized. */
  recognizedAt: string;
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
  sharePrice: number; // current NAV per share in USD (clamped at zero)
  totalShares: number;
  payoffExplanation: string;
  historicalEpochs: EpochRecord[];
  userPosition: UserVaultPosition | null;
  /** Remaining first-loss buffer available to absorb future losses. */
  firstLossBuffer: number;
  /** Outstanding protocol bad debt not yet recovered. */
  badDebt: number;
  /** Most recent unresolved loss event, if the vault is impaired. */
  unresolvedLoss: VaultLossEvent | null;
  /** Role assignments scoped to this vault only. */
  roles: VaultRoleGrant[];
}

/**
 * Clamp a NAV-per-share value at zero. NAV must never be reported negative;
 * any residual beyond total NAV is surfaced as explicit bad debt instead.
 */
export function clampNavPerShare(nav: number): number {
  if (!Number.isFinite(nav) || nav < 0) return 0;
  return nav;
}

/**
 * Deterministic loss-allocation waterfall. Mirrors the on-chain ordering so
 * the UI can preview a loss before settlement: fee reserves first, then the
 * first-loss buffer, then pro-rata share write-down. Any residual beyond total
 * NAV is recorded as explicit bad debt rather than an underflow.
 */
export function allocateLoss(params: {
  epoch: number;
  realizedLoss: number;
  feeReserves: number;
  firstLossBuffer: number;
  totalNav: number;
  totalShares: number;
}): VaultLossEvent {
  const loss = Math.max(0, params.realizedLoss);
  const feeReserves = Math.max(0, params.feeReserves);
  const buffer = Math.max(0, params.firstLossBuffer);
  const totalNav = Math.max(0, params.totalNav);
  const totalShares = Math.max(0, params.totalShares);

  const absorbedByFees = Math.min(loss, feeReserves);
  let remaining = loss - absorbedByFees;

  const absorbedByBuffer = Math.min(remaining, buffer);
  remaining -= absorbedByBuffer;

  const absorbedByShares = Math.min(remaining, totalNav);
  remaining -= absorbedByShares;

  const badDebt = remaining;
  const navAfter = clampNavPerShare(totalNav - absorbedByShares);
  const navPerShare = totalShares > 0 ? navAfter / totalShares : 0;

  return {
    epoch: params.epoch,
    realizedLoss: loss,
    absorbedByFees,
    absorbedByBuffer,
    absorbedByShares,
    remainingBuffer: buffer - absorbedByBuffer,
    navPerShare: clampNavPerShare(navPerShare),
    badDebt,
    recognizedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Pagination & cache metadata (issue #223)
// ---------------------------------------------------------------------------

/**
 * Freshness metadata attached to every paginated read. `stale` is true when
 * the payload was served from cache and may not reflect the latest chain
 * state (e.g. a NAV value computed before the current epoch ticked).
 */
export interface CacheMeta {
  /** Whether the payload was served from a cache layer. */
  cached: boolean;
  /** ISO timestamp of when the underlying data was produced. */
  asOf: string;
  /** Seconds the payload may be considered fresh. 0 = live. */
  ttlSeconds: number;
  /** True when the payload is cached and past its freshness window. */
  stale: boolean;
}

/** A single page of results plus the cursor to fetch the next page. */
export interface VaultPage<T> {
  items: T[];
  /** Opaque cursor for the next page, or null when the end is reached. */
  nextCursor: string | null;
  cache: CacheMeta;
}

/** Options accepted by the paginated read helpers. */
export interface PageOptions {
  /** Opaque cursor returned by a previous page. Omit for the first page. */
  cursor?: string | null;
  /** Requested page size; clamped to [1, VAULT_MAX_PAGE_SIZE]. */
  limit?: number;
}

/**
 * Clamp a requested page size into the documented bounds. Exported so the BFF
 * route handlers apply the exact same cap as the client.
 */
export function clampPageSize(limit?: number): number {
  if (limit === undefined || limit === null || !Number.isFinite(limit)) {
    return VAULT_DEFAULT_PAGE_SIZE;
  }
  const n = Math.floor(limit);
  if (n < 1) return 1;
  if (n > VAULT_MAX_PAGE_SIZE) return VAULT_MAX_PAGE_SIZE;
  return n;
}

/**
 * Encode an opaque cursor over a stable sort key. The key is the last-seen
 * value of the sort column (vault id or epoch number), never a timestamp, so
 * concurrent inserts do not shift page boundaries.
 */
export function encodeCursor(key: string | number): string {
  const raw = String(key);
  const b64 =
    typeof btoa === "function"
      ? btoa(raw)
      : Buffer.from(raw, "utf8").toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Decode an opaque cursor produced by {@link encodeCursor}. */
export function decodeCursor(cursor: string): string {
  const b64 = cursor.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  return typeof atob === "function"
    ? atob(padded)
    : Buffer.from(padded, "base64").toString("utf8");
}

/**
 * Slice a stable-sorted array into a cursor page. `keyOf` returns the stable
 * sort key for each item; the cursor encodes the last key of the prior page.
 * Items are returned strictly after the cursor key, so a row inserted before
 * the cursor is not re-emitted and a row inserted after it is not skipped.
 */
export function paginateByKey<T>(
  items: T[],
  keyOf: (item: T) => string | number,
  options: PageOptions = {},
): VaultPage<T> {
  const limit = clampPageSize(options.limit);
  const after = options.cursor ? decodeCursor(options.cursor) : null;
  const start = after === null ? 0 : items.findIndex((it) => String(keyOf(it)) === after) + 1;
  const slice = items.slice(start, start + limit);
  const last = slice[slice.length - 1];
  const hasMore = start + limit < items.length;
  return {
    items: slice,
    nextCursor: hasMore && last !== undefined ? encodeCursor(keyOf(last)) : null,
    cache: { cached: false, asOf: new Date().toISOString(), ttlSeconds: 0, stale: false },
  };
}

// ---------------------------------------------------------------------------
// Share-lot accounting (cost basis, realized and unrealized PnL)
//
// Shared by the API and any client-side display. Rebuilding the ledger from
// the same event stream always yields the same output: events are ordered by
// (ledger, seq) and lots by (acquiredLedger, lotId). Schema: docs/vault-lot-ledger.md
// ---------------------------------------------------------------------------

/** Lot relief method. Stored on every ledger row so a future change cannot rewrite history. */
export type LotReliefMethod = "fifo";
export const DEFAULT_LOT_RELIEF_METHOD: LotReliefMethod = "fifo";

/** Share amounts at or below this are rounding residue, never a lot. */
export const DUST_SHARES = 1e-9;

/** A dated acquisition lot held by one depositor in one vault. */
export interface VaultShareLot {
  lotId: string;
  vaultId: string;
  acquiredLedger: number;
  acquiredAt: string; // ledger close time (ISO), never receipt time
  /** Shares still held from this lot. */
  shares: number;
  /** Cost basis still attached to the remaining shares, in USD. */
  costUsd: number;
  /** NAV per share used when the shares were minted. */
  navPerShare: number;
}

/** A lot-affecting event as indexed from the vault contract. */
export interface VaultLotEvent {
  seq: number;
  kind: "deposit" | "transfer_in" | "redemption" | "transfer_out";
  ledger: number;
  ledgerAt: string;
  vaultId: string;
  shares: number;
  /** deposit/transfer_in: cost in USD. redemption/transfer_out: gross proceeds in USD. */
  amountUsd: number;
  /** Fees that reduce proceeds. Management fees are already reflected in NAV and are not repeated here. */
  feesUsd: number;
  navPerShare: number;
}

/** One ledger row per lot-affecting event. This is the export row. */
export interface VaultLedgerRow {
  seq: number;
  kind: VaultLotEvent["kind"];
  ledger: number;
  ledgerAt: string;
  vaultId: string;
  shares: number;
  amountUsd: number;
  feesUsd: number;
  navPerShare: number;
  costBasisUsd: number;
  realizedPnlUsd: number;
  lotMethod: LotReliefMethod;
}

export interface LotRelief {
  shares: number;
  costBasisUsd: number;
  /** Gross proceeds minus fees. */
  netProceedsUsd: number;
  realizedPnlUsd: number;
  consumed: { lotId: string; shares: number; costUsd: number }[];
  remainingLots: VaultShareLot[];
}

function byLotOrder(a: VaultShareLot, b: VaultShareLot): number {
  return a.acquiredLedger - b.acquiredLedger || a.lotId.localeCompare(b.lotId);
}

/**
 * Relieves `shares` from the lots in FIFO order and returns the realized PnL.
 * Throws rather than producing a negative basis when `shares` exceeds the tracked lots.
 */
export function relieveLotsFifo(
  lots: VaultShareLot[],
  shares: number,
  grossProceedsUsd: number,
  feesUsd: number
): LotRelief {
  if (!(shares > DUST_SHARES)) throw new Error(`Relief quantity must be positive, got ${shares}`);
  if (feesUsd < 0) throw new Error(`Fees cannot be negative, got ${feesUsd}`);
  const available = lots.reduce((sum, lot) => sum + lot.shares, 0);
  if (shares > available + DUST_SHARES) {
    throw new Error(`Cannot relieve ${shares} shares: only ${available} tracked`);
  }

  let remaining = shares;
  let costBasisUsd = 0;
  const consumed: LotRelief["consumed"] = [];
  const remainingLots: VaultShareLot[] = [];

  for (const lot of [...lots].sort(byLotOrder)) {
    if (remaining <= DUST_SHARES) {
      remainingLots.push(lot);
      continue;
    }
    const take = Math.min(lot.shares, remaining);
    const costUsd = lot.shares > 0 ? lot.costUsd * (take / lot.shares) : 0;
    remaining -= take;
    costBasisUsd += costUsd;
    consumed.push({ lotId: lot.lotId, shares: take, costUsd });

    const left = lot.shares - take;
    if (left > DUST_SHARES) {
      remainingLots.push({ ...lot, shares: left, costUsd: lot.costUsd - costUsd });
    }
  }

  const netProceedsUsd = grossProceedsUsd - feesUsd;
  return {
    shares,
    costBasisUsd,
    netProceedsUsd,
    realizedPnlUsd: netProceedsUsd - costBasisUsd,
    consumed,
    remainingLots,
  };
}

/** Unrealized PnL on the lots still held, marked at `markNavPerShare`. */
export function unrealizedPnl(lots: VaultShareLot[], markNavPerShare: number): number {
  return lots.reduce((sum
