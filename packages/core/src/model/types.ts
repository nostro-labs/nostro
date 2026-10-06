/**
 * The reconciliation data model.
 *
 * Four record types carry the whole pipeline:
 *
 * - A **Movement** is a normalised ledger fact: value that moved into or out of
 *   a watched account. It mirrors the vocabulary of Stellar's Token Transfer
 *   Processor (CAP-67: `transfer | mint | burn | clawback | fee`) so the two
 *   stay interoperable.
 * - An **Expectation** is what you were owed (or owe): an invoice, a payroll
 *   line, a subscription charge.
 * - An **Allocation** links the two: `(movement, expectation, amount)`. Matches
 *   are allocations rather than a foreign key on either side, so partial,
 *   split, consolidated and over-payments are one mechanism (ADR 0003).
 * - An **ExceptionRecord** is anything that needs a human, drawn from a closed
 *   set of reason codes.
 *
 * Records are immutable values. Stores return frozen objects and replace rather
 * than mutate them.
 */
import type { Money } from '../money/index.js'

/** Which way value moved, relative to the watched account. */
export type Direction = 'credit' | 'debit'

/**
 * What kind of ledger event produced a movement. Mirrors the Token Transfer
 * Processor event types. `fee` is first-class: omitting fees breaks the
 * balance invariant (I2).
 */
export type MovementKind = 'transfer' | 'mint' | 'burn' | 'clawback' | 'fee'

export const MOVEMENT_KINDS: readonly MovementKind[] = [
  'transfer',
  'mint',
  'burn',
  'clawback',
  'fee',
]

/**
 * A transaction memo. `null` on a record means `MEMO_NONE`.
 *
 * `text` is kept exactly as the source decoded it. On-ledger text memos are at
 * most 28 bytes, but sources substitute U+FFFD for invalid UTF-8, which can
 * push the decoded string past that, so length is the matcher's concern and
 * never a reason to reject a movement at ingest.
 */
export type Memo =
  | { readonly type: 'text'; readonly value: string }
  | { readonly type: 'id'; readonly value: bigint }
  | { readonly type: 'hash'; readonly value: string }
  | { readonly type: 'return'; readonly value: string }

/**
 * Where a movement is in the pipeline. The disposition column *is* the work
 * queue: matching picks up `pending` rows, so a crash mid-match loses nothing.
 *
 * Invariant I1 (total disposition) is stated over these values:
 * - `allocated` — allocations sum to the full amount
 * - `partial`   — allocated in part, with an open exception covering the rest
 * - `exception` — at least one exception is attached
 * - `ignored`   — explicitly excluded, with a recorded reason
 */
export type Disposition = 'pending' | 'allocated' | 'partial' | 'exception' | 'ignored'

/** Whether the enrichment feeds (memo, muxed id, op type) were stitched on. */
export type Enrichment = 'complete' | 'missing'

export interface Movement {
  readonly id: string
  readonly tenantId: string
  /** Store-assigned ingest order. For a cursor-driven source this is ledger order. */
  readonly seq: number
  readonly network: string
  /** The source that observed this fact, e.g. `horizon`. */
  readonly source: string
  /** Identity within `(tenantId, network, source)`; the dedupe key (ADR 0005). */
  readonly externalId: string
  /** Bumped when a source issues a correction; the original is never overwritten. */
  readonly revision: number
  /** The watched account (`G...`). */
  readonly account: string
  readonly direction: Direction
  readonly kind: MovementKind
  /** Always positive; the sign lives in `direction`. */
  readonly amount: Money
  /** The other side of the movement, when there is one (fees have none). */
  readonly counterparty: string | null
  /** The uint64 id of a muxed (`M...`) destination or source, when present. */
  readonly muxedId: bigint | null
  readonly memo: Memo | null
  readonly ledger: number
  readonly txHash: string
  readonly operationId: string | null
  readonly occurredAt: Date
  readonly enrichment: Enrichment
  readonly disposition: Disposition
  readonly ignoredReason: string | null
  readonly createdAt: Date
}

/** A movement as a source produces it, before the store assigns identity. */
export interface NewMovement {
  readonly tenantId: string
  readonly network: string
  readonly source: string
  readonly externalId: string
  readonly revision?: number
  readonly account: string
  readonly direction: Direction
  readonly kind: MovementKind
  readonly amount: Money
  readonly counterparty?: string | null
  readonly muxedId?: bigint | null
  readonly memo?: Memo | null
  readonly ledger: number
  readonly txHash: string
  readonly operationId?: string | null
  readonly occurredAt: Date
  readonly enrichment?: Enrichment
}

export type ExpectationStatus = 'open' | 'partially_paid' | 'settled' | 'cancelled'

export interface Expectation {
  readonly id: string
  readonly tenantId: string
  /** Your reference for it (an invoice number, say). Unique per tenant. */
  readonly reference: string
  /** The account the money should arrive at (or leave from). */
  readonly account: string
  /** `credit` for money you are owed, `debit` for money you are paying out. */
  readonly direction: Direction
  /** Always positive. Its asset is the only asset that can settle it. */
  readonly amount: Money
  /** The muxed id issued for this expectation, if you issued one. */
  readonly muxedId: bigint | null
  /** The memo the payer was asked to send, if any. */
  readonly memo: Memo | null
  /** Accounts known to pay this expectation; corroborating evidence only. */
  readonly payers: readonly string[]
  readonly dueAt: Date | null
  /** After this, a payment no longer settles it (protects closed periods). */
  readonly expiresAt: Date | null
  /** Maintained by the store from allocations; never set directly. */
  readonly status: ExpectationStatus
  readonly cancelReason: string | null
  readonly metadata: Readonly<Record<string, string>>
  readonly createdAt: Date
  readonly updatedAt: Date
}

export interface NewExpectation {
  readonly tenantId: string
  readonly reference: string
  readonly account: string
  readonly direction?: Direction
  readonly amount: Money
  readonly muxedId?: bigint | null
  readonly memo?: Memo | null
  readonly payers?: readonly string[]
  readonly dueAt?: Date | null
  readonly expiresAt?: Date | null
  readonly metadata?: Readonly<Record<string, string>>
}

export interface Allocation {
  readonly id: string
  readonly tenantId: string
  readonly movementId: string
  readonly expectationId: string
  /** Always positive, in the asset of both the movement and the expectation. */
  readonly amount: Money
  /** Which strategy (or `manual`) produced this allocation. */
  readonly strategy: string
  /** Match confidence in [0, 1]; `null` for manual allocations. */
  readonly score: number | null
  readonly createdAt: Date
}

export interface NewAllocation {
  readonly tenantId: string
  readonly movementId: string
  readonly expectationId: string
  readonly amount: Money
  readonly strategy: string
  readonly score?: number | null
}

/**
 * The closed set of reasons a record needs a human. Open-ended strings make an
 * exceptions queue impossible to operate, so adding a code is a deliberate,
 * reviewed change.
 */
export type ExceptionCode =
  | 'UNMATCHED_NO_CANDIDATE'
  | 'AMBIGUOUS_MATCH'
  | 'WRONG_ASSET'
  | 'OVERPAYMENT'
  | 'DUPLICATE_PAYMENT'
  | 'PARTIAL_UNRESOLVED'
  | 'LATE_BEYOND_WINDOW'
  | 'MEMO_MISSING'
  | 'MEMO_MALFORMED'
  | 'MEMO_TRUNCATED'
  | 'UNEXPECTED_CREDIT'
  | 'UNEXPECTED_DEBIT'
  | 'REFUND_UNLINKED'
  | 'BALANCE_ATTESTATION_FAILED'
  | 'SOURCE_GAP_DETECTED'
  | 'ENRICHMENT_MISSING'

export const EXCEPTION_CODES: readonly ExceptionCode[] = [
  'UNMATCHED_NO_CANDIDATE',
  'AMBIGUOUS_MATCH',
  'WRONG_ASSET',
  'OVERPAYMENT',
  'DUPLICATE_PAYMENT',
  'PARTIAL_UNRESOLVED',
  'LATE_BEYOND_WINDOW',
  'MEMO_MISSING',
  'MEMO_MALFORMED',
  'MEMO_TRUNCATED',
  'UNEXPECTED_CREDIT',
  'UNEXPECTED_DEBIT',
  'REFUND_UNLINKED',
  'BALANCE_ATTESTATION_FAILED',
  'SOURCE_GAP_DETECTED',
  'ENRICHMENT_MISSING',
]

export type ExceptionStatus = 'open' | 'resolved' | 'dismissed'

/** JSON-safe evidence. bigints and Money must be serialised before they go in. */
export type Json = string | number | boolean | null | readonly Json[] | { readonly [k: string]: Json }

export interface ExceptionRecord {
  readonly id: string
  readonly tenantId: string
  readonly code: ExceptionCode
  readonly status: ExceptionStatus
  /** At least one of movementId, expectationId and account is set. */
  readonly movementId: string | null
  readonly expectationId: string | null
  readonly account: string | null
  /** The amount in question: an unallocated residual, an overpayment, etc. */
  readonly amount: Money | null
  readonly detail: string
  /** Why the engine decided what it did, e.g. per-candidate signal scores. */
  readonly evidence: Json
  readonly openedAt: Date
  readonly resolvedAt: Date | null
  readonly resolutionNote: string | null
}

export interface NewException {
  readonly tenantId: string
  readonly code: ExceptionCode
  readonly movementId?: string | null
  readonly expectationId?: string | null
  readonly account?: string | null
  readonly amount?: Money | null
  readonly detail: string
  readonly evidence?: Json
}

/** Identifies one ingest stream's position. */
export interface CursorKey {
  readonly tenantId: string
  readonly network: string
  readonly source: string
  readonly account: string
}

/** A movement's signed effect on its account's balance: credits add, debits subtract. */
export function signedAmount(movement: Pick<Movement, 'amount' | 'direction'>): Money {
  return movement.direction === 'credit' ? movement.amount : movement.amount.negate()
}
