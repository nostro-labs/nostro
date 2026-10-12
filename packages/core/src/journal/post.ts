/**
 * Posting movements to the journal.
 *
 * `postMovement()` brings one movement's journal up to date inside a
 * transaction: it reads the movement (a locking read), its allocations,
 * exceptions and earlier entries, and posts whatever `planPosting()` says is
 * missing, which is often nothing. `reconcile()` calls it in the same
 * transaction as each decision, so the books never lag the decisions.
 *
 * `postJournal()` is the bounded sweep for everything else: movements
 * decided before the journal existed, or changed by hand since (a manual
 * allocation, a resolved exception). Running it again posts nothing new.
 */
import type { JournalEntry, JournalEntryKind } from '../model/index.js'
import type { Store, StoreTx } from '../store/index.js'
import { NotFoundError } from '../store/index.js'
import type { PostingPlanOptions } from './lines.js'
import { planPosting } from './lines.js'

export type PostOptions = PostingPlanOptions

export async function postMovement(
  tx: StoreTx,
  tenantId: string,
  movementId: string,
  options: PostOptions = {},
): Promise<JournalEntry | null> {
  const movement = await tx.getMovement(tenantId, movementId)
  if (movement === null) throw new NotFoundError('movement', movementId)
  const plan = planPosting(
    movement,
    await tx.listAllocations({ tenantId, movementId }),
    await tx.listExceptions({ tenantId, movementId }),
    await tx.listJournalEntries({ tenantId, movementId }),
    options,
  )
  return plan === null ? null : tx.postJournalEntry(plan)
}

export interface PostJournalOptions extends PostOptions {
  readonly store: Store
  readonly tenantId: string
  /** Start after this movement `seq`; pass the previous report's `lastSeq` to continue. */
  readonly afterSeq?: number
  /** Movements to examine per call. Default 500. */
  readonly limit?: number
}

export interface PostJournalReport {
  readonly examined: number
  readonly posted: Readonly<Record<JournalEntryKind, number>>
  /** The last movement `seq` examined, or `null` if there was nothing to examine. */
  readonly lastSeq: number | null
  readonly errors: readonly { readonly movementId: string; readonly error: Error }[]
}

export async function postJournal(options: PostJournalOptions): Promise<PostJournalReport> {
  const { store, tenantId } = options
  const movements = await store.listMovements({
    tenantId,
    ...(options.afterSeq === undefined ? {} : { afterSeq: options.afterSeq }),
    limit: options.limit ?? 500,
  })
  const posted: Record<JournalEntryKind, number> = { initial: 0, reclass: 0, correction: 0 }
  const errors: { movementId: string; error: Error }[] = []
  for (const m of movements) {
    if (m.disposition === 'pending') continue
    try {
      const entry = await store.transaction((tx) => postMovement(tx, tenantId, m.id, options))
      if (entry !== null) posted[entry.kind] += 1
    } catch (err) {
      errors.push({ movementId: m.id, error: err instanceof Error ? err : new Error(String(err)) })
    }
  }
  return {
    examined: movements.length,
    posted,
    lastSeq: movements[movements.length - 1]?.seq ?? null,
    errors,
  }
}
