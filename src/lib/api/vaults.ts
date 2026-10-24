/**
 * Vaults REST contract — v1 (frozen).
 *
 * Owner: vaults. Counterpart: Zenith-options/backend. Any change to the wire
 * shapes below is a contract change: bump VAULTS_API_VERSION and land the
 * backend change in the same release.
 *
 * The Phase 2 options vault contract is scaffolded under `contracts/vault`
 * (crate `zenith-options-vault`), but it is not yet deployed and the backend
 * API is not yet available. This module is unrelated to the margin-collateral
 * vault in `./vault.ts`. When NEXT_PUBLIC_VAULTS=mock (or the env var is absent), the mock
 * implementation below is used. Swap in the real implementation by
 * setting NEXT_PUBLIC_VAULTS=live and implementing `fetchVaultsLive`.
 *
 * Transport
 *   All requests go through the BFF (`bffFetch`). The bearer token lives in
 *   the httpOnly session cookie and is attached server-side; this module never
 *   reads or sends it. GET routes are auth-optional, POST routes require a
 *   session (see src/lib/bff/allowlist.ts).
 *
 * Endpoints (all under /api/v1/vaults)
 *   GET  /                    ?limit&cursor                 → Page<VaultRegistryEntry>
 *   GET  /{id}                                              → VaultDetail | 404
 *   GET  /{id}/nav            ?from&to&limit&cursor         → Page<NavPoint>
 *   GET  /{id}/epochs         ?from&to&limit&cursor         → Page<EpochRecord>
 *   POST /{id}/deposit        { amount }                    → { tx_id }
 *   POST /{id}/withdraw       { shares }                    → { tx_id, queued }
 *
 *   POST /api/v1/vaults/{id}/deposit   { amount: number; disclosure_version: string }  → { tx_id: string }
 *   POST /api/v1/vaults/{id}/withdraw  { shares: number }  → { tx_id: string; queued: boolean }
 *
 *   POST /api/v1/vaults/disclosures/acknowledge
 *     { disclosure_version, text_hash, jurisdiction_attested }  → DisclosureAcknowledgement
 *   GET  /api/v1/vaults/disclosures/me  → DisclosureAcknowledgement[]
 *
 * Deposits are rejected server-side (403 with a PolicyReasonCode) unless the
 * wallet holds an acknowledgement for the current disclosure version. The
 * client check in the UI is advisory only.
 *
 * Wire format
 *   - Every amount, price, share count and ratio is a decimal string
 *     (/^-?\d+(\.\d+)?$/), never a JSON number. Amounts are USD collateral
 *     unless the field ends in `_shares`. Ratios are fractions (0.18 = 18%).
 *   - Instants are RFC 3339 with an offset (`*_at`, `phase_ends_at`).
 *     Calendar dates are YYYY-MM-DD (`*_expiry`, `*_start`, `settlement_date`).
 *   - Field names are snake_case (serde output). Unknown extra fields are
 *     stripped; missing or mistyped fields fail validation (ContractError).
 *
 * Pagination and time ranges
 *   - `cursor` is opaque. `limit` is 1–100 (default 50). `next_cursor: null`
 *     marks the last page.
 *   - `from` / `to` are inclusive RFC 3339 bounds. NAV points filter on `at`;
 *     epochs filter on `settlement_date`.
 *
 * Error taxonomy (HTTP status → VaultsApiError.code)
 *   401  unauthorized     Session expired. Not retried; re-authenticate.
 *   403  forbidden        Vaults flag off, or wallet not allowlisted. Not retried.
 *   404  not_found        getVault resolves to null.
 *   409  epoch_closed     The epoch closed while the request was in flight.
 *                         Not retried; the user retries in the next deposit window.
 *   400/422 invalid_request
 *   5xx  unavailable      Retryable.
 *   client-side: timeout (10s), network, aborted, contract (schema violation).
 *
 * Degradation
 *   Reads (list, detail, nav, epochs) that fail with a retryable error return
 *   the last successful response for the same key in this session, so the
 *   detail view keeps its values. Mutations (deposit, withdraw) are never
 *   retried by the adapter and always surface their error.
 *
 * Mode
 *   NEXT_PUBLIC_VAULTS=live selects the live client. Any other value (absent
 *   or "mock") selects the mock client backed by MOCK_VAULTS. Pages import only
 *   from this module, so flipping the flag needs no page changes.
 */

import { z } from "zod";
import { env } from "../../env";
import { bffFetch } from "./client";
import { ContractError, reportContractError } from "./contractError";

export const VAULTS_API_VERSION = "v1" as const;
const API = `/api/${VAULTS_API_VERSION}/vaults`;
const REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MAX_PAGES = 20;

// ---------------------------------------------------------------------------
// Wire schemas (source of truth for the frozen contract)
// ---------------------------------------------------------------------------

const DecimalStringSchema = z.string().regex(/^-?\d+(\.\d+)?$/, "must be a decimal string");
const InstantSchema = z.string().datetime({ offset: true });
const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD");

export const VaultStrategySchema = z.enum(["covered_call", "cash_secured_put", "iron_condor", "wheel"]);
export const RiskRatingSchema = z.enum(["low", "medium", "high"]);
export const EpochPhaseSchema = z.enum(["deposit", "active", "settlement"]);
export const EpochOutcomeSchema = z.enum(["expired_worthless", "exercised", "active"]);

/** Registry entry: one row on the /vaults listing. */
export const VaultRegistryEntrySchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  underlying: z.string(),
  strategy: VaultStrategySchema,
  apy: DecimalStringSchema,
  apy_methodology: z.string(),
  tvl_usd: DecimalStringSchema,
  capacity_usd: DecimalStringSchema,
  /** tvl_usd / capacity_usd, as a fraction 0–1. */
  utilisation: DecimalStringSchema,
  current_strike: DecimalStringSchema,
  current_expiry: DateSchema,
  risk_rating: RiskRatingSchema,
  description: z.string(),
});

export const EpochRecordSchema = z.object({
  epoch_number: z.number().int().nonnegative(),
  deposit_start: DateSchema,
  active_start: DateSchema,
  settlement_date: DateSchema,
  strike: DecimalStringSchema,
  expiry_days: z.number().int().nonnegative(),
  premium_collected: DecimalStringSchema,
  outcome: EpochOutcomeSchema,
  /** Epoch return as a fraction; positive = profit for depositors. */
  pnl_ratio: DecimalStringSchema,
});

export const UserPositionSchema = z.object({
  shares: DecimalStringSchema,
  share_value: DecimalStringSchema,
  total_value_usd: DecimalStringSchema,
  accrued_premium_usd: DecimalStringSchema,
  pending_withdrawal_shares: DecimalStringSchema,
});

/** Deposit/withdraw queue state for the current epoch. */
export const QueueStateSchema = z.object({
  deposit_pending_usd: DecimalStringSchema,
  withdraw_pending_shares: DecimalStringSchema,
  settles_at: InstantSchema,
});

/** Fee accrual breakdown, accrued through `accrued_through`. */
export const FeeAccrualSchema = z.object({
  management_accrued_usd: DecimalStringSchema,
  performance_accrued_usd: DecimalStringSchema,
  accrued_through: InstantSchema,
});

/** Full vault detail, including the current epoch and a bounded recent-epoch window. */
export const VaultDetailSchema = VaultRegistryEntrySchema.extend({
  current_epoch: z.number().int().nonnegative(),
  current_phase: EpochPhaseSchema,
  phase_ends_at: InstantSchema,
  share_price: DecimalStringSchema,
  total_shares: DecimalStringSchema,
  fee_structure: z.object({
    management_pct: DecimalStringSchema,
    performance_pct: DecimalStringSchema,
  }),
  payoff_explanation: z.string(),
  queue: QueueStateSchema,
  fees: FeeAccrualSchema,
  recent_epochs: z.array(EpochRecordSchema),
  user_position: UserPositionSchema.nullable(),
});

export const NavPointSchema = z.object({
  at: InstantSchema,
  share_price: DecimalStringSchema,
  total_shares: DecimalStringSchema,
});

export const DepositResponseSchema = z.object({ tx_id: z.string().min(1) });
export const WithdrawResponseSchema = z.object({ tx_id: z.string().min(1), queued: z.boolean() });

export type VaultRegistryEntryWire = z.infer<typeof VaultRegistryEntrySchema>;
export type VaultDetailWire = z.infer<typeof VaultDetailSchema>;
export type EpochRecordWire = z.infer<typeof EpochRecordSchema>;
export type NavPointWire = z.infer<typeof NavPointSchema>;

const pageOf = <T extends z.ZodTypeAny>(item: T) =>
  z.object({ items: z.array(item), next_cursor: z.string().nullable() });

// ---------------------------------------------------------------------------
// UI types (camelCase, display-ready)
// ---------------------------------------------------------------------------

export type VaultStrategy = z.infer<typeof VaultStrategySchema>;
export type RiskRating = z.infer<typeof RiskRatingSchema>;
export type EpochPhase = z.infer<typeof EpochPhaseSchema>;
/** `full` is derived from TVL vs. capacity in `effectiveStatus`; the backend may also report it. */
export type VaultStatus = "open" | "paused" | "closed_to_deposits" | "full";

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
  /** tvl / capacity (0–1). */
  utilisation: number;
  currentStrike: number;
  currentExpiry: string; // ISO date
  riskRating: RiskRating;
  description: string;
  status: VaultStatus;
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
  open:               "Open",
  paused:             "Paused",
  closed_to_deposits: "Closed to deposits",
  full:               "Full",
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

/** One epoch record. */
export interface EpochRecord {
  epochNumber: number;
  depositStart: string; // ISO date
  activeStart: string;
  settlementDate: string;
  strike: number;
  expiryDays: number;
  premiumCollected: number; // per share, in USD
  outcome: z.infer<typeof EpochOutcomeSchema>;
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

export interface QueueState {
  depositPendingUsd: number;
  withdrawPendingShares: number;
  settlesAt: string; // ISO
}

export interface FeeAccrual {
  managementAccruedUsd: number;
  performanceAccruedUsd: number;
  accruedThrough: string; // ISO
}

export interface NavPoint {
  at: string; // ISO
  sharePrice: number;
  totalShares: number;
}

/** Full detail for a single vault. */
export interface VaultDetail extends VaultSummary {
  currentEpoch: number;
  currentPhase: EpochPhase;
  phaseEndsAt: string; // ISO — when the current phase ends
  sharePrice: number; // current NAV per share in USD
  totalShares: number;
  payoffExplanation: string;
  queue: QueueState;
  fees: FeeAccrual;
  historicalEpochs: EpochRecord[];
  userPosition: UserVaultPosition | null;
  /** Role assignments scoped to this vault only. */
  roles: VaultRoleGrant[];
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface PageQuery {
  limit?: number;
  cursor?: string | null;
}

export interface TimeRangeQuery {
  /** Inclusive RFC 3339 lower bound. */
  from?: string;
  /** Inclusive RFC 3339 upper bound. */
  to?: string;
}

export interface DepositResult {
  tx_id: string;
}

export interface WithdrawResult {
  tx_id: string;
  queued: boolean;
}

// ---------------------------------------------------------------------------
// Error taxonomy
// ---------------------------------------------------------------------------

export type VaultsErrorCode =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "epoch_closed"
  | "invalid_request"
  | "unavailable"
  | "timeout"
  | "network"
  | "aborted"
  | "contract"
  | "unexpected";

const RETRYABLE_CODES: ReadonlySet<VaultsErrorCode> = new Set(["unavailable", "timeout", "network"]);

/** Every error the vaults surface raises. Pages can switch on `code`. */
export class VaultsApiError extends Error {
  readonly retryable: boolean;

  constructor(readonly code: VaultsErrorCode, readonly status: number | null, message: string) {
    super(message);
    this.name = "VaultsApiError";
    this.retryable = RETRYABLE_CODES.has(code);
  }
}

function httpError(status: number, serverMessage?: string): VaultsApiError {
  if (status === 401) return new VaultsApiError("unauthorized", status, serverMessage ?? "Session expired — sign in again.");
  if (status === 403) return new VaultsApiError("forbidden", status, serverMessage ?? "Vaults are not enabled for this wallet.");
  if (status === 404) return new VaultsApiError("not_found", status, serverMessage ?? "Vault not found.");
  if (status === 409) {
    return new VaultsApiError(
      "epoch_closed",
      status,
      serverMessage ?? "The epoch closed before your request was processed. Try again in the next deposit window."
    );
  }
  if (status === 400 || status === 422) return new VaultsApiError("invalid_request", status, serverMessage ?? "Request rejected.");
  if (status >= 500) return new VaultsApiError("unavailable", status, serverMessage ?? "Vaults service is unavailable.");
  return new VaultsApiError("unexpected", status, serverMessage ?? `Unexpected response (${status}).`);
}

// ---------------------------------------------------------------------------
// Client interface
// ---------------------------------------------------------------------------

export type NavHistoryQuery = PageQuery & TimeRangeQuery;
export type EpochQuery = PageQuery & TimeRangeQuery;

export interface VaultsClient {
  listVaults(query?: PageQuery, signal?: AbortSignal): Promise<Page<VaultSummary>>;
  getVault(id: string, signal?: AbortSignal): Promise<VaultDetail | null>;
  getNavHistory(id: string, query?: NavHistoryQuery, signal?: AbortSignal): Promise<Page<NavPoint>>;
  getEpochs(id: string, query?: EpochQuery, signal?: AbortSignal): Promise<Page<EpochRecord>>;
  deposit(id: string, amount: number, signal?: AbortSignal): Promise<DepositResult>;
  withdraw(id: string, shares: number, signal?: AbortSignal): Promise<WithdrawResult>;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function clampLimit(limit: number | undefined): number {
  return Math.min(Math.max(1, Math.floor(limit ?? DEFAULT_LIMIT)), MAX_LIMIT);
}

/**
 * Wire decimal → display number. Display-only: values converted here are
 * never sent back to the backend. Requests use toDecimalString instead.
 */
function num(decimal: string): number {
  return Number(decimal);
}

/** Display number → wire decimal string (7 places, Stellar precision). */
function toDecimalString(value: number, field: string): string {
  if (!Number.isFinite(value) || value <= 0) {
    throw new VaultsApiError("invalid_request", null, `${field} must be a positive number`);
  }
  return value.toFixed(7).replace(/\.?0+$/, "");
}

function qs(params: Record<string, string | number | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
  }
  const out = search.toString();
  return out ? `?${out}` : "";
}

// ---------------------------------------------------------------------------
// Wire → UI mapping
// ---------------------------------------------------------------------------

function toSummary(w: VaultRegistryEntryWire): VaultSummary {
  return {
    id: w.id,
    name: w.name,
    underlying: w.underlying,
    strategy: w.strategy,
    apy: num(w.apy),
    apyMethodology: w.apy_methodology,
    tvl: num(w.tvl_usd),
    capacity: num(w.capacity_usd),
    utilisation: num(w.utilisation),
    currentStrike: num(w.current_strike),
    currentExpiry: w.current_expiry,
    riskRating: w.risk_rating,
    description: w.description,
  };
}

function toEpoch(w: EpochRecordWire): EpochRecord {
  return {
    epochNumber: w.epoch_number,
    depositStart: w.deposit_start,
    activeStart: w.active_start,
    settlementDate: w.settlement_date,
    strike: num(w.strike),
    expiryDays: w.expiry_days,
    premiumCollected: num(w.premium_collected),
    outcome: w.outcome,
    pnlPct: num(w.pnl_ratio),
  };
}

function toNavPoint(w: NavPointWire): NavPoint {
  return { at: w.at, sharePrice: num(w.share_price), totalShares: num(w.total_shares) };
}

function toDetail(w: VaultDetailWire): VaultDetail {
  return {
    ...toSummary(w),
    currentEpoch: w.current_epoch,
    currentPhase: w.current_phase,
    phaseEndsAt: w.phase_ends_at,
    sharePrice: num(w.share_price),
    totalShares: num(w.total_shares),
    feeStructure: {
      managementPct: num(w.fee_structure.management_pct),
      performancePct: num(w.fee_structure.performance_pct),
    },
    payoffExplanation: w.payoff_explanation,
    queue: {
      depositPendingUsd: num(w.queue.deposit_pending_usd),
      withdrawPendingShares: num(w.queue.withdraw_pending_shares),
      settlesAt: w.queue.settles_at,
    },
    fees: {
      managementAccruedUsd: num(w.fees.management_accrued_usd),
      performanceAccruedUsd: num(w.fees.performance_accrued_usd),
      accruedThrough: w.fees.accrued_through,
    },
    historicalEpochs: w.recent_epochs.map(toEpoch),
    userPosition: w.user_position && {
      shares: num(w.user_position.shares),
      shareValue: num(w.user_position.share_value),
      totalValue: num(w.user_position.total_value_usd),
      accruedPremium: num(w.user_position.accrued_premium_usd),
      pendingWithdrawal: num(w.user_position.pending_withdrawal_shares),
    },
  };
}

// ---------------------------------------------------------------------------
// Live client
// ---------------------------------------------------------------------------

interface RequestOptions {
  method?: "GET" | "POST";
  body?: unknown;
  signal?: AbortSignal;
}

/**
 * Single request path for every live call: timeout, caller abort, BFF
 * transport, status → taxonomy, and response validation at the boundary.
 */
async function request<T>(path: string, schema: z.ZodType<T>, { method = "GET", body, signal }: RequestOptions = {}): Promise<T> {
  if (signal?.aborted) throw new VaultsApiError("aborted", null, "Vaults request was aborted.");

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);

  try {
    const res = await bffFetch(path, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const payload = (await res.json().catch(() => null)) as { error?: string } | null;
      throw httpError(res.status, payload?.error);
    }

    const parsed = schema.safeParse(await res.json());
    if (!parsed.success) {
      const violation = new ContractError(path, parsed.error.issues);
      reportContractError(violation);
      throw new VaultsApiError("contract", res.status, violation.message);
    }
    return parsed.data;
  } catch (err) {
    if (err instanceof VaultsApiError) throw err;
    if (signal?.aborted) throw new VaultsApiError("aborted", null, "Vaults request was aborted.");
    if (timedOut) {
      throw new VaultsApiError("timeout", null, `Vaults request timed out after ${REQUEST_TIMEOUT_MS / 1000}s.`);
    }
    if (err instanceof SyntaxError) throw new VaultsApiError("contract", null, `Invalid JSON from ${path}.`);
    throw new VaultsApiError("network", null, "Could not reach the vaults service.");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/** Last successful value per key, for graceful degradation on retryable errors. */
const lastKnown = new Map<string, unknown>();

async function remember<T>(key: string, load: () => Promise<T>): Promise<T> {
  try {
    const value = await load();
    lastKnown.set(key, value);
    return value;
  } catch (err) {
    if (err instanceof VaultsApiError && err.retryable && lastKnown.has(key)) {
      return lastKnown.get(key) as T;
    }
    throw err;
  }
}

const liveVaultsClient: VaultsClient = {
  listVaults(query, signal) {
    const path = `${API}${qs({ limit: clampLimit(query?.limit), cursor: query?.cursor })}`;
    return remember(path, async () => {
      const page = await request(path, pageOf(VaultRegistryEntrySchema), { signal });
      return { items: page.items.map(toSummary), nextCursor: page.next_cursor };
    });
  },

  getVault(id, signal) {
    const path = `${API}/${encodeURIComponent(id)}`;
    return remember(path, async () => {
      try {
        return toDetail(await request(path, VaultDetailSchema, { signal }));
      } catch (err) {
        if (err instanceof VaultsApiError && err.code === "not_found") return null;
        throw err;
      }
    });
  },

  getNavHistory(id, query, signal) {
    const path = `${API}/${encodeURIComponent(id)}/nav${qs({
      from: query?.from,
      to: query?.to,
      limit: clampLimit(query?.limit),
      cursor: query?.cursor,
    })}`;
    return remember(path, async () => {
      const page = await request(path, pageOf(NavPointSchema), { signal });
      return { items: page.items.map(toNavPoint), nextCursor: page.next_cursor };
    });
  },

  getEpochs(id, query, signal) {
    const path = `${API}/${encodeURIComponent(id)}/epochs${qs({
      from: query?.from,
      to: query?.to,
      limit: clampLimit(query?.limit),
      cursor: query?.cursor,
    })}`;
    return remember(path, async () => {
      const page = await request(path, pageOf(EpochRecordSchema), { signal });
      return { items: page.items.map(toEpoch), nextCursor: page.next_cursor };
    });
  },

  async deposit(id, amount, signal) {
    return request(`${API}/${encodeURIComponent(id)}/deposit`, DepositResponseSchema, {
      method: "POST",
      body: { amount: toDecimalString(amount, "amount") },
      signal,
    });
  },

  async withdraw(id, shares, signal) {
    return request(`${API}/${encodeURIComponent(id)}/withdraw`, WithdrawResponseSchema, {
      method: "POST",
      body: { shares: toDecimalString(shares, "shares") },
      signal,
    });
  },
};

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

/** Fixture shape. Queue and fee ledgers are derived in the mock client. */
type MockVaultRecord = Omit<VaultDetail, "utilisation" | "queue" | "fees">;

const MOCK_VAULTS: MockVaultRecord[] = [
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
    currentExpiry: "2026-10
