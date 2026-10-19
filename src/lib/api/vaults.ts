/**
 * Vaults REST contract — v1 (frozen).
 *
 * Owner: vaults. Counterpart: Zenith-options/backend. Any change to the wire
 * shapes below is a contract change: bump VAULTS_API_VERSION and land the
 * backend change in the same release.
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
  feeStructure: { managementPct: number; performancePct: number };
  payoffExplanation: string;
  queue: QueueState;
  fees: FeeAccrual;
  historicalEpochs: EpochRecord[];
  userPosition: UserVaultPosition | null;
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

function mockSummary(v: MockVaultRecord): VaultSummary {
  const { historicalEpochs, userPosition, currentEpoch, currentPhase, phaseEndsAt, sharePrice, totalShares, feeStructure, payoffExplanation, ...summary } = v;
  return { ...summary, utilisation: v.tvl / v.capacity };
}

function mockDetail(v: MockVaultRecord): VaultDetail {
  return {
    ...v,
    utilisation: v.tvl / v.capacity,
    // The fixture has no queue or fee ledger, so the mock reports an empty
    // queue and zero accrual. Only the withdrawal queue reflects the fixture.
    queue: {
      depositPendingUsd: 0,
      withdrawPendingShares: v.userPosition?.pendingWithdrawal ?? 0,
      settlesAt: v.phaseEndsAt,
    },
    fees: { managementAccruedUsd: 0, performanceAccruedUsd: 0, accruedThrough: v.phaseEndsAt },
  };
}

/** Offset-based paging for the mock; the cursor is the next offset. */
function paginateMock<T>(items: T[], query: PageQuery = {}): Page<T> {
  const limit = clampLimit(query.limit);
  const offset = Number(query.cursor ?? 0) || 0;
  const next = offset + limit;
  return { items: items.slice(offset, next), nextCursor: next < items.length ? String(next) : null };
}

/** Mock epochs: `settlement_date` is a calendar date, so compare on the date part of the bounds. */
function inEpochRange(settlementDate: string, query: TimeRangeQuery = {}): boolean {
  if (query.from && settlementDate < query.from.slice(0, 10)) return false;
  if (query.to && settlementDate > query.to.slice(0, 10)) return false;
  return true;
}

const mockVaultsClient: VaultsClient = {
  async listVaults(query) {
    return paginateMock(MOCK_VAULTS.map(mockSummary), query);
  },

  async getVault(id) {
    const vault = MOCK_VAULTS.find(v => v.id === id);
    return vault ? mockDetail(vault) : null;
  },

  async getNavHistory() {
    // The fixture has no NAV series, so the mock returns an empty page.
    return { items: [], nextCursor: null };
  },

  async getEpochs(id, query) {
    const vault = MOCK_VAULTS.find(v => v.id === id);
    const epochs = (vault?.historicalEpochs ?? []).filter(e => inEpochRange(e.settlementDate, query));
    return paginateMock(epochs, query);
  },

  async deposit(id, amount) {
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new VaultsApiError("invalid_request", null, "amount must be a positive number");
    }
    // Simulate a 600ms network round-trip
    await new Promise(r => setTimeout(r, 600));
    return { tx_id: `mock-tx-deposit-${id}-${amount.toFixed(0)}-${Date.now()}` };
  },

  async withdraw(id, shares) {
    if (!Number.isFinite(shares) || shares <= 0) {
      throw new VaultsApiError("invalid_request", null, "shares must be a positive number");
    }
    await new Promise(r => setTimeout(r, 600));
    return { tx_id: `mock-tx-withdraw-${id}-${shares.toFixed(0)}-${Date.now()}`, queued: true };
  },
};

// ---------------------------------------------------------------------------
// Client selection and public adapter
// ---------------------------------------------------------------------------

export function getVaultsClient(): VaultsClient {
  return env.NEXT_PUBLIC_VAULTS === "live" ? liveVaultsClient : mockVaultsClient;
}

/** Walks every listing page. Bounded by MAX_PAGES so a repeating cursor cannot loop forever. */
export async function fetchVaults(): Promise<VaultSummary[]> {
  const client = getVaultsClient();
  const out: VaultSummary[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < MAX_PAGES; i++) {
    const page: Page<VaultSummary> = await client.listVaults({ limit: MAX_LIMIT, cursor });
    out.push(...page.items);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return out;
}

export async function fetchVaultDetail(id: string, _token?: string | null): Promise<VaultDetail | null> {
  return getVaultsClient().getVault(id);
}

export async function depositToVault(
  id: string,
  amount: number,
  _token: string
): Promise<{ tx_id: string }> {
  return getVaultsClient().deposit(id, amount);
}

export async function withdrawFromVault(
  id: string,
  shares: number,
  _token: string
): Promise<{ tx_id: string; queued: boolean }> {
  return getVaultsClient().withdraw(id, shares);
}
