/** How records are shown: as text in tables, and as JSON with every amount exact. */
import type { AssetId, ExceptionRecord, Expectation, Memo, Money } from 'nostro'
import { NATIVE } from 'nostro'

/** `XLM` for the native asset, else the full `CODE:ISSUER`: a code alone is not an asset. */
export const assetLabel = (asset: AssetId): string => (asset === NATIVE ? 'XLM' : asset)

export const money = (m: Money): string => `${m.toString()} ${assetLabel(m.asset)}`

/** To the minute, in UTC. */
export const when = (d: Date | null): string => (d === null ? '' : d.toISOString().slice(0, 16).replace('T', ' '))

export function memoJson(memo: Memo | null): { type: Memo['type']; value: string } | null {
  return memo === null ? null : { type: memo.type, value: String(memo.value) }
}

export function expectationJson(e: Expectation, paid: Money) {
  return {
    id: e.id,
    reference: e.reference,
    account: e.account,
    direction: e.direction,
    amount: e.amount.toString(),
    paid: paid.toString(),
    asset: e.amount.asset,
    muxedId: e.muxedId === null ? null : e.muxedId.toString(),
    memo: memoJson(e.memo),
    payers: e.payers,
    dueAt: e.dueAt,
    expiresAt: e.expiresAt,
    status: e.status,
    cancelReason: e.cancelReason,
    metadata: e.metadata,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
  }
}

export function exceptionJson(x: ExceptionRecord) {
  return {
    id: x.id,
    code: x.code,
    status: x.status,
    movementId: x.movementId,
    expectationId: x.expectationId,
    account: x.account,
    amount: x.amount === null ? null : x.amount.toString(),
    asset: x.amount === null ? null : x.amount.asset,
    detail: x.detail,
    evidence: x.evidence,
    openedAt: x.openedAt,
    resolvedAt: x.resolvedAt,
    resolutionNote: x.resolutionNote,
  }
}
