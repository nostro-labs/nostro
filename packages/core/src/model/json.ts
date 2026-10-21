/**
 * Records as plain JSON: what an API returns and a client can parse.
 *
 * `JSON.stringify` cannot take a record as it is: muxed ids and id memos
 * are bigints, which it refuses, and `Money` would come out as raw units.
 * Here every amount is an exact decimal string beside its asset
 * (`"25.0000000"`, `"native"`), every uint64 is a decimal string, and every
 * date is an ISO 8601 string. Nothing is a float, and nothing is rounded.
 * Tenant ids are left out: whoever is asking already knows which tenant.
 */
import type { AssetId } from '../money/index.js'
import type {
  Allocation,
  Direction,
  Disposition,
  Enrichment,
  ExceptionCode,
  ExceptionRecord,
  ExceptionStatus,
  Expectation,
  ExpectationStatus,
  JournalEntry,
  JournalEntryKind,
  Json,
  LineRole,
  Memo,
  Movement,
  MovementKind,
  Side,
} from './types.js'

export interface MemoJson {
  readonly type: Memo['type']
  /** Text as sent; an id as a decimal string; a hash as hex. */
  readonly value: string
}

export interface MovementJson {
  readonly id: string
  readonly seq: number
  readonly network: string
  readonly source: string
  readonly externalId: string
  readonly revision: number
  readonly account: string
  readonly direction: Direction
  readonly kind: MovementKind
  readonly amount: string
  readonly asset: AssetId
  readonly counterparty: string | null
  readonly muxedId: string | null
  readonly memo: MemoJson | null
  readonly ledger: number
  readonly txHash: string | null
  readonly operationId: string | null
  readonly occurredAt: string
  readonly enrichment: Enrichment
  readonly disposition: Disposition
  readonly ignoredReason: string | null
  readonly createdAt: string
}

export interface ExpectationJson {
  readonly id: string
  readonly seq: number
  readonly reference: string
  readonly account: string
  readonly direction: Direction
  readonly amount: string
  readonly asset: AssetId
  readonly muxedId: string | null
  readonly memo: MemoJson | null
  readonly payers: readonly string[]
  readonly dueAt: string | null
  readonly expiresAt: string | null
  readonly status: ExpectationStatus
  readonly cancelReason: string | null
  readonly metadata: Readonly<Record<string, string>>
  readonly createdAt: string
  readonly updatedAt: string
}

export interface AllocationJson {
  readonly id: string
  readonly movementId: string
  readonly expectationId: string
  readonly amount: string
  readonly asset: AssetId
  readonly strategy: string
  readonly score: number | null
  readonly createdAt: string
}

export interface ExceptionJson {
  readonly id: string
  readonly seq: number
  readonly code: ExceptionCode
  readonly status: ExceptionStatus
  readonly movementId: string | null
  readonly expectationId: string | null
  readonly account: string | null
  readonly amount: string | null
  readonly asset: AssetId | null
  readonly detail: string
  readonly evidence: Json
  readonly openedAt: string
  readonly resolvedAt: string | null
  readonly resolutionNote: string | null
}

export interface JournalLineJson {
  readonly account: string
  readonly role: LineRole
  readonly side: Side
  readonly amount: string
  readonly asset: AssetId
  readonly expectationId: string | null
  readonly exceptionId: string | null
}

export interface JournalEntryJson {
  readonly id: string
  readonly seq: number
  readonly movementId: string | null
  readonly postingNo: number | null
  readonly kind: JournalEntryKind
  readonly effectiveAt: string
  readonly postedAt: string
  readonly description: string
  readonly lines: readonly JournalLineJson[]
}

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString())

export function memoJson(memo: Memo | null): MemoJson | null {
  return memo === null ? null : { type: memo.type, value: String(memo.value) }
}

export function movementJson(m: Movement): MovementJson {
  return {
    id: m.id,
    seq: m.seq,
    network: m.network,
    source: m.source,
    externalId: m.externalId,
    revision: m.revision,
    account: m.account,
    direction: m.direction,
    kind: m.kind,
    amount: m.amount.toString(),
    asset: m.amount.asset,
    counterparty: m.counterparty,
    muxedId: m.muxedId === null ? null : m.muxedId.toString(),
    memo: memoJson(m.memo),
    ledger: m.ledger,
    txHash: m.txHash,
    operationId: m.operationId,
    occurredAt: m.occurredAt.toISOString(),
    enrichment: m.enrichment,
    disposition: m.disposition,
    ignoredReason: m.ignoredReason,
    createdAt: m.createdAt.toISOString(),
  }
}

export function expectationJson(e: Expectation): ExpectationJson {
  return {
    id: e.id,
    seq: e.seq,
    reference: e.reference,
    account: e.account,
    direction: e.direction,
    amount: e.amount.toString(),
    asset: e.amount.asset,
    muxedId: e.muxedId === null ? null : e.muxedId.toString(),
    memo: memoJson(e.memo),
    payers: [...e.payers],
    dueAt: iso(e.dueAt),
    expiresAt: iso(e.expiresAt),
    status: e.status,
    cancelReason: e.cancelReason,
    metadata: { ...e.metadata },
    createdAt: e.createdAt.toISOString(),
    updatedAt: e.updatedAt.toISOString(),
  }
}

export function allocationJson(a: Allocation): AllocationJson {
  return {
    id: a.id,
    movementId: a.movementId,
    expectationId: a.expectationId,
    amount: a.amount.toString(),
    asset: a.amount.asset,
    strategy: a.strategy,
    score: a.score,
    createdAt: a.createdAt.toISOString(),
  }
}

export function exceptionJson(x: ExceptionRecord): ExceptionJson {
  return {
    id: x.id,
    seq: x.seq,
    code: x.code,
    status: x.status,
    movementId: x.movementId,
    expectationId: x.expectationId,
    account: x.account,
    amount: x.amount === null ? null : x.amount.toString(),
    asset: x.amount === null ? null : x.amount.asset,
    detail: x.detail,
    evidence: x.evidence,
    openedAt: x.openedAt.toISOString(),
    resolvedAt: iso(x.resolvedAt),
    resolutionNote: x.resolutionNote,
  }
}

export function journalEntryJson(j: JournalEntry): JournalEntryJson {
  return {
    id: j.id,
    seq: j.seq,
    movementId: j.movementId,
    postingNo: j.postingNo,
    kind: j.kind,
    effectiveAt: j.effectiveAt.toISOString(),
    postedAt: j.postedAt.toISOString(),
    description: j.description,
    lines: j.lines.map((l) => ({
      account: l.account,
      role: l.role,
      side: l.side,
      amount: l.amount.toString(),
      asset: l.amount.asset,
      expectationId: l.expectationId,
      exceptionId: l.exceptionId,
    })),
  }
}
