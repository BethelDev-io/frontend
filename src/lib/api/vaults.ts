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

export type VaultStrategy = "covered_call" | "cash_secured_put" | "iron_condor" | "wheel";
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
  /** Current operational state; `impaired`/`underwater` disable deposits. */
  state: VaultState;
  /** True while an unresolved loss event exists (deposits disabled). */
  depositsDisabled: boolean;
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
  pendingWithdrawal: number; // shares queued for withdrawal at epoch end
}

/** Full detail for a single vault. */
export interface VaultDetail extends VaultSummary {
  currentEpoch: number;
  currentPhase: EpochPhase;
  phaseEndsAt: string; // ISO — when the current phase ends
  sharePrice: number; // current NAV per share in USD (clamped at zero)
  totalShares: number;
  feeStructure: { managementPct: number; performancePct: number };
  payoffExplanation: string;
  historicalEpochs: EpochRecord[];
  userPosition: UserVaultPosition | null;
  /** Remaining first-loss buffer available to absorb future losses. */
  firstLossBuffer: number;
  /** Outstanding protocol bad debt not yet recovered. */
  badDebt: number;
  /** Most recent unresolved loss event, if the vault is impaired. */
  unresolvedLoss: VaultLossEvent | null;
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

// --------------------------------------------------------------------------
