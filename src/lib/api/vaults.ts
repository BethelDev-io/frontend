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
 *   GET /api/v1/vaults?cursor=<opaque>&limit=<n>
 *   → { items: VaultSummary[]; nextCursor: string | null; cache: CacheMeta }
 *
 *   GET /api/v1/vaults/{id}
 *   → VaultDetail
 *
 *   GET /api/v1/vaults/{id}/epochs?cursor=<opaque>&limit=<n>
 *   → { items: EpochRecord[]; nextCursor: string | null; cache: CacheMeta }
 *
 *   POST /api/v1/vaults/{id}/deposit   { amount: number }  → { tx_id: string }
 *   POST /api/v1/vaults/{id}/withdraw  { shares: number }  → { tx_id: string; queued: boolean }
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
 */

export type VaultStrategy = "covered_call" | "cash_secured_put" | "iron_condor" | "wheel";
export type RiskRating = "low" | "medium" | "high";
export type EpochPhase = "deposit" | "active" | "settlement";

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
// Validation & idempotency helpers (issue #220)
// ---------------------------------------------------------------------------

/** Error thrown when a client-side vault request fails validation. */
export class VaultValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultValidationError";
  }
}

/**
 * Validate a vault id before it is interpolated into a request path.
 * Vault ids are lowercase slugs (e.g. `xlm-cc-v1`).
 */
export function validateVaultId(id: string): string {
  if (typeof id !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) {
    throw new VaultValidationError("Invalid vault id");
  }
  return id;
}

/**
 * Validate a positive amount / share quantity. Rejects non-finite values,
 * negatives, zero, and over-precision inputs before they reach the contract.
 */
export function validateAmount(value: number, field = "amount"): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new VaultValidationError(`${field} must be a finite number`);
  }
  if (value <= 0) {
    throw new VaultValidationError(`${field} must be greater than zero`);
  }
  const decimals = (String(value).split(".")[1] ?? "").length;
  if (decimals > VAULT_AMOUNT_MAX_DECIMALS) {
    throw new VaultValidationError(
      `${field} must have at most ${VAULT_AMOUNT_MAX_DECIMALS} decimal places`,
    );
  }
  return value;
}

/**
 * Generate an idempotency key for a state-changing vault request. Uses the
 * platform crypto API when available so retries can reuse the same key.
 */
export function createIdempotencyKey(): string {
  const cryptoObj = typeof globalThis !== "undefined" ? globalThis.crypto : undefined;
  if (cryptoObj && typeof cryptoObj.randomUUID === "function") {
    return cryptoObj.randomUUID();
  }
  return `idem-${Date.now()}-${Math.random().toString(36).slice(2)}`;
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
    apyMethodology: "Trailing 12-month annualized premium income ÷ average TVL. Does not include spot price change of the underlying.",
    tvl: 412000,
    capacity: 750000,
    currentStrike: 62000,
    currentExpiry: "2026-10-03",
    riskRating: "low",
    description: "Sells weekly cash-secured puts on BTC. Premium is collected each epoch; the vault holds USDC as collateral.",
    currentEpoch: 31,
    currentPhase: "active",
    phaseEndsAt: "2026-10-03T16:00:00Z",
    sharePrice: 1.018,
    totalShares: 404715,
    feeStructure: { managementPct: 0, performancePct: 10 },
    payoffExplanation: "Each week the vault sells a put option at a strike ~10% below the current BTC price. If BTC stays above the strike, depositors keep the full premium. If BTC falls below the strike, the position is exercised and depositors take assignment of BTC at the strike price.",
    historicalEpochs: [
      { epochNumber: 30, depositStart: "2026-09-19", activeStart: "2026-09-20", settlementDate: "2026-09-27", strike: 61000, expiryDays: 7, premiumCollected: 0.0012, outcome: "expired_worthless", pnlPct: 0.014 },
      { epochNumber: 29, depositStart: "2026-09-12", activeStart: "2026-09-13", settlementDate: "2026-09-20", strike: 60500, expiryDays: 7, premiumCollected: 0.0011, outcome: "expired_worthless", pnlPct: 0.012 },
    ],
    userPosition: null,
  },
];

// ---------------------------------------------------------------------------
// Paginated read helpers (issue #223)
// ---------------------------------------------------------------------------

/**
 * Fetch one page of the vault list. Sorted by vault id (stable) so cursors
 * remain valid under concurrent registry changes.
 */
export async function fetchVaultsPage(options: PageOptions = {}): Promise<VaultPage<VaultSummary>> {
  const sorted = [...MOCK_VAULTS].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return paginateByKey(sorted, (v) => v.id, options);
}

/**
 * Fetch one page of a vault's epoch history. Sorted by epoch number descending
 * (newest first) so a newly-closed epoch lands at the head without shifting
 * the cursor of an in-flight pagination.
 */
export async function fetchEpochsPage(
  vaultId: string,
  options: PageOptions = {},
): Promise<VaultPage<EpochRecord>> {
  const id = validateVaultId(vaultId);
  const vault = MOCK_VAULTS.find((v) => v.id === id);
  if (!vault) {
    throw new VaultValidationError("Vault not found");
  }
  const sorted = [...vault.historicalEpochs].sort((a, b) => b.epochNumber - a.epochNumber);
  return paginateByKey(sorted, (e) => e.epochNumber, options);
}

/**
 * Iterate every page of a paginated read, invoking `onPage` for each. Useful
 * for "load more" / windowed-table consumers that want to accumulate rows.
 */
export async function iteratePages<T>(
  fetchPage: (options: PageOptions) => Promise<VaultPage<T>>,
  onPage: (page: VaultPage<T>) => void,
  options: PageOptions = {},
): Promise<void> {
  let cursor = options.cursor ?? null;
  do {
    const page = await fetchPage({ ...options, cursor });
    onPage(page);
    cursor = page.nextCursor;
  } while (cursor !== null);
}
