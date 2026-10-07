/**
 * Reconcile pending movements against expectations.
 *
 * `reconcile()` is the step after `sync()`: it takes movements still marked
 * `pending`, decides each with the pure engine, and records the outcome:
 * an allocation, an exception for a person, or an explicit ignore. Every
 * movement it touches leaves `pending` with a disposition that satisfies
 * invariant I1 (the store refuses one that does not).
 *
 * Each movement is handled in its own transaction, and the movement is
 * re-read there with a locking read, so two reconcilers running at once skip
 * what the other has done instead of colliding. Bounded like `sync()`: call
 * it again for the next batch.
 *
 * Candidates are the account's open and part-paid expectations in the same
 * direction, plus any expectation (whatever its status) whose muxed id the
 * movement carries in its address or its memo id, so a second payment to a
 * settled invoice's muxed address is caught as a duplicate. A second payment
 * quoting a settled invoice's text reference finds no open candidate and is
 * raised as unmatched instead: still a person's job, under a less specific
 * code.
 */
import type { ExceptionCode, Expectation, Movement } from '../model/index.js'
import type { Store, StoreTx } from '../store/index.js'
import { sumAmounts } from '../store/index.js'
import type { DecideOptions } from './engine.js'
import { decide } from './engine.js'
import type { Candidate } from './types.js'

export interface ReconcileOptions extends DecideOptions {
  readonly store: Store
  readonly tenantId: string
  /** Pending movements to take per call. Default 100. */
  readonly limit?: number
}

export interface ReconcileReport {
  /** Movements this call decided. */
  readonly processed: number
  /** Fully allocated. */
  readonly allocated: number
  /** Allocated, with an overpayment exception for the rest. */
  readonly partial: number
  /** Exceptions raised, by code. */
  readonly exceptions: Readonly<Partial<Record<ExceptionCode, number>>>
  readonly ignored: number
  /** Already handled by another reconciler by the time this one got to it. */
  readonly skipped: number
  readonly errors: readonly { readonly movementId: string; readonly error: Error }[]
}

async function candidatesFor(tx: StoreTx, movement: Movement): Promise<Candidate[]> {
  const { tenantId, account, direction } = movement
  const found = new Map<string, Expectation>()
  const add = (list: readonly Expectation[]) => {
    for (const e of list) {
      // A muxed id only means something on its own base account.
      if (e.status !== 'cancelled' && e.account === account && e.direction === direction) found.set(e.id, e)
    }
  }
  add(await tx.listExpectations({ tenantId, account, direction, status: ['open', 'partially_paid'] }))
  if (movement.muxedId !== null) add(await tx.listExpectations({ tenantId, muxedId: movement.muxedId }))
  if (movement.memo?.type === 'id') add(await tx.listExpectations({ tenantId, muxedId: movement.memo.value }))

  const candidates: Candidate[] = []
  for (const expectation of found.values()) {
    const allocations = await tx.listAllocations({ tenantId, expectationId: expectation.id })
    const paid = sumAmounts(
      allocations.map((a) => a.amount),
      expectation.amount,
    )
    candidates.push({ expectation, remaining: expectation.amount.subtract(paid) })
  }
  return candidates
}

type Outcome = 'allocated' | 'partial' | 'ignored' | 'skipped' | ExceptionCode

async function reconcileOne(tx: StoreTx, tenantId: string, id: string, options: DecideOptions): Promise<Outcome> {
  const movement = await tx.getMovement(tenantId, id)
  if (movement === null || movement.disposition !== 'pending') return 'skipped'

  const decision = decide(movement, await candidatesFor(tx, movement), options)
  switch (decision.outcome) {
    case 'ignore':
      await tx.setDisposition(tenantId, id, 'ignored', decision.reason)
      return 'ignored'
    case 'exception':
      await tx.openException({
        tenantId,
        code: decision.code,
        movementId: id,
        expectationId: decision.expectationId,
        account: movement.account,
        amount: decision.amount,
        detail: decision.detail,
        evidence: decision.evidence,
      })
      await tx.setDisposition(tenantId, id, 'exception')
      return decision.code
    case 'allocate': {
      await tx.allocate({
        tenantId,
        movementId: id,
        expectationId: decision.expectationId,
        amount: decision.amount,
        strategy: decision.strategy,
        score: decision.score,
      })
      if (decision.residual === null) {
        await tx.setDisposition(tenantId, id, 'allocated')
        return 'allocated'
      }
      await tx.openException({
        tenantId,
        code: 'OVERPAYMENT',
        movementId: id,
        expectationId: decision.expectationId,
        account: movement.account,
        amount: decision.residual,
        detail: `Paid ${movement.amount.toString()}; ${decision.amount.toString()} settled the expectation, ` +
          `${decision.residual.toString()} is left over.`,
        evidence: decision.evidence,
      })
      await tx.setDisposition(tenantId, id, 'partial')
      return 'partial'
    }
  }
}

export async function reconcile(options: ReconcileOptions): Promise<ReconcileReport> {
  const { store, tenantId } = options
  const pending = await store.listMovements({ tenantId, disposition: 'pending', limit: options.limit ?? 100 })
  const counts = { allocated: 0, partial: 0, ignored: 0, skipped: 0 }
  const exceptions: Partial<Record<ExceptionCode, number>> = {}
  const errors: { movementId: string; error: Error }[] = []

  for (const { id } of pending) {
    try {
      const outcome = await store.transaction((tx) => reconcileOne(tx, tenantId, id, options))
      if (outcome in counts) counts[outcome as keyof typeof counts] += 1
      else exceptions[outcome as ExceptionCode] = (exceptions[outcome as ExceptionCode] ?? 0) + 1
    } catch (err) {
      errors.push({ movementId: id, error: err instanceof Error ? err : new Error(String(err)) })
    }
  }

  return {
    processed: pending.length - counts.skipped - errors.length,
    ...counts,
    exceptions,
    errors,
  }
}
