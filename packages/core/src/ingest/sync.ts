/**
 * The ingest loop: pull from a source, record, advance the cursor.
 *
 * `sync()` is bounded. It reads at most `maxBatches` batches per account and
 * returns a report, so it can run inside a route handler, a queue job or a
 * Lambda. Call it again (on a timer, or when a stream nudges you) to continue.
 *
 * Each batch is pulled *outside* a database transaction, so no transaction is
 * held open across network I/O. The write then re-reads the cursor and only
 * commits if it is unchanged since the pull: a compare-and-set that keeps two
 * workers from both advancing the same stream. Combined with the dedupe key
 * on movements, that makes ingest effectively-once.
 */
import type { CursorKey, Json, Movement, NewMovement } from '../model/index.js'
import type { MovementConflict, Store } from '../store/index.js'
import type { MovementSource } from './source.js'

export interface SyncOptions {
  readonly store: Store
  readonly source: MovementSource
  readonly tenantId: string
  readonly accounts: readonly string[]
  /** Records per pull. Default 200 (Horizon's maximum page size). */
  readonly batchSize?: number
  /** Pulls per account per call. Default 10. */
  readonly maxBatches?: number
}

export interface AccountSyncReport {
  readonly account: string
  readonly batches: number
  readonly inserted: number
  readonly duplicates: number
  /** Re-deliveries that disagreed with recorded facts; each opened a SOURCE_GAP_DETECTED exception. */
  readonly conflicts: number
  /** The cursor after this sync. */
  readonly cursor: string | null
  readonly caughtUp: boolean
  /** Another writer advanced the cursor mid-batch; this batch was discarded. */
  readonly contended: boolean
  readonly error: Error | null
}

export interface SyncReport {
  readonly accounts: readonly AccountSyncReport[]
  readonly inserted: number
  readonly duplicates: number
  readonly conflicts: number
  readonly errors: readonly { readonly account: string; readonly error: Error }[]
}

export class CursorContendedError extends Error {
  public readonly code = 'CURSOR_CONTENDED'
  constructor(key: CursorKey) {
    super(`The cursor for ${key.account} on ${key.network}/${key.source} moved during the batch.`)
    this.name = 'CursorContendedError'
  }
}

export async function sync(options: SyncOptions): Promise<SyncReport> {
  const batchSize = options.batchSize ?? 200
  const maxBatches = options.maxBatches ?? 10
  const reports: AccountSyncReport[] = []
  for (const account of options.accounts) {
    reports.push(await syncAccount(options, account, batchSize, maxBatches))
  }
  return {
    accounts: reports,
    inserted: reports.reduce((n, r) => n + r.inserted, 0),
    duplicates: reports.reduce((n, r) => n + r.duplicates, 0),
    conflicts: reports.reduce((n, r) => n + r.conflicts, 0),
    errors: reports.flatMap((r) => (r.error === null ? [] : [{ account: r.account, error: r.error }])),
  }
}

async function syncAccount(
  { store, source, tenantId }: SyncOptions,
  account: string,
  batchSize: number,
  maxBatches: number,
): Promise<AccountSyncReport> {
  const key: CursorKey = { tenantId, network: source.network, source: source.name, account }
  let batches = 0
  let inserted = 0
  let duplicates = 0
  let conflicts = 0
  let caughtUp = false
  let contended = false
  let error: Error | null = null
  let cursor = await store.getCursor(key)

  try {
    while (batches < maxBatches && !caughtUp) {
      const from = cursor
      const pulled = await source.pull({ tenantId, account, cursor: from, limit: batchSize })
      for (const m of pulled.movements) assertBelongs(m, key)
      batches += 1

      const result = await store.transaction(async (tx) => {
        if ((await tx.getCursor(key)) !== from) throw new CursorContendedError(key)
        const written = await tx.insertMovements(pulled.movements)
        for (const conflict of written.conflicts) {
          await tx.openException({
            tenantId,
            code: 'SOURCE_GAP_DETECTED',
            movementId: conflict.existing.id,
            account,
            detail:
              `${source.name} re-delivered ${conflict.existing.externalId} with different facts; ` +
              `the recorded movement was left unchanged.`,
            evidence: conflictEvidence(conflict),
          })
        }
        if (pulled.cursor !== null && pulled.cursor !== from) await tx.setCursor(key, pulled.cursor)
        return written
      })

      inserted += result.inserted.length
      duplicates += result.duplicates.length
      conflicts += result.conflicts.length
      cursor = pulled.cursor
      caughtUp = pulled.caughtUp
    }
  } catch (err) {
    if (err instanceof CursorContendedError) contended = true
    else error = err instanceof Error ? err : new Error(String(err))
  }

  return { account, batches, inserted, duplicates, conflicts, cursor, caughtUp, contended, error }
}

/** A source must only return movements for the stream it was asked about. */
function assertBelongs(m: NewMovement, key: CursorKey): void {
  if (
    m.tenantId !== key.tenantId ||
    m.account !== key.account ||
    m.network !== key.network ||
    m.source !== key.source
  ) {
    throw new Error(
      `Source ${key.source} returned movement ${m.externalId} for ` +
        `${m.tenantId}/${m.network}/${m.source}/${m.account}, outside the requested stream.`,
    )
  }
}

function facts(m: Movement | NewMovement): Json {
  return {
    account: m.account,
    direction: m.direction,
    kind: m.kind,
    amount: m.amount.toString(),
    asset: m.amount.asset,
    counterparty: m.counterparty ?? null,
    muxedId: m.muxedId == null ? null : m.muxedId.toString(),
    memo: m.memo == null ? null : { type: m.memo.type, value: String(m.memo.value) },
    ledger: m.ledger,
    txHash: m.txHash ?? null,
    operationId: m.operationId ?? null,
    occurredAt: m.occurredAt.toISOString(),
    enrichment: m.enrichment ?? 'complete',
  }
}

function conflictEvidence(conflict: MovementConflict): Json {
  return { recorded: facts(conflict.existing), redelivered: facts(conflict.incoming) }
}
