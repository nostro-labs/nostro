/**
 * Horizon as a `MovementSource`: one for effects, one for fees.
 *
 * Fees are not effects (ADR 0006), so they come from a second feed with its
 * own cursor. Run both sources for every watched account, or the balance
 * invariant will be short by every fee the account paid.
 */
import type { MovementSource, PullRequest, PullResult, SourceGap } from '../../ingest/index.js'
import type { HorizonClient, Page } from './client.js'
import { HorizonError } from './client.js'
import type { NormalizeContext } from './normalize.js'
import { normalizeEffects, normalizeFee } from './normalize.js'
import type { HorizonEffect, HorizonOperation, HorizonTransaction } from './records.js'
import { ledgerOfToid, operationIdOf } from './records.js'

export interface HorizonSourceOptions {
  readonly client: HorizonClient
  /** Label stored on movements and cursors, e.g. `public` or `testnet`. */
  readonly network: string
  /**
   * Where an account with no cursor begins: all history Horizon still
   * retains, or only what happens from now on. Default `earliest`.
   */
  readonly start?: 'earliest' | 'latest'
}

export interface HorizonEffectsSourceOptions extends HorizonSourceOptions {
  /**
   * Operations to fetch one by one per pull, for effects the account's own
   * operations feed does not list (a maker whose offer was crossed is not a
   * participant in the taker's operation). When the budget runs out the
   * batch ends early and the next pull carries on. Default 50, minimum 1.
   */
  readonly lookupBudget?: number
  /** Most effect pages to read to finish one oversized operation. Default 50. */
  readonly maxPagesPerOperation?: number
}

/** A cursor that reads from the start; used when an account has no history yet. */
const FROM_START = '0'

const VALUE_EFFECTS = new Set([
  'account_credited',
  'account_debited',
  'account_created',
  'trade',
  'liquidity_pool_trade',
  'liquidity_pool_deposited',
  'liquidity_pool_withdrew',
])

const isNotFound = (err: unknown): boolean => err instanceof HorizonError && err.status === 404

/**
 * A ledger jump this large is worth confirming with GET /. Horizon keeps a
 * window from `history_elder_ledger`; a cursor just before it can produce a
 * first record only a few thousand ledgers on, so this guard stays small
 * enough to catch that case (the pubnet USDC check saw a 3,126-ledger jump).
 * Without any guard, a pull across an ordinary ledger boundary would make a
 * network call just to confirm nothing was lost.
 */
const LEDGER_JUMP = 1_000

/** The ledger a stored cursor is at, or null for the start sentinel. */
function cursorLedger(cursor: string | null): number | null {
  if (cursor === null || cursor === FROM_START) return null
  const toid = operationIdOf({ paging_token: cursor })
  return /^\d+$/.test(toid) ? ledgerOfToid(toid) : null
}

/**
 * Detect a retention gap without adding a call to an ordinary pull. A page
 * that begins far past the cursor, or a first sync whose history does not
 * begin with `account_created`, is the only reason to read GET /. An account
 * created inside the window always starts its effects with `account_created`;
 * the fees feed alone cannot tell an old account from a new one, so it only
 * checks stored cursors.
 */
async function retentionGap(
  client: HorizonClient,
  cursor: string | null,
  firstLedger: number,
  firstType: string | null,
  earliest: boolean,
): Promise<SourceGap | null> {
  const from = cursorLedger(cursor)
  const stale = from !== null && firstLedger - from > LEDGER_JUMP
  const firstSync = earliest && cursor === null && firstType !== 'account_created'
  if (!stale && !firstSync) return null

  const elder = (await client.root()).history_elder_ledger
  if (!Number.isFinite(elder) || elder <= 0) return null
  if (stale && from !== null && from < elder) {
    return { reason: 'stale_cursor', cursorLedger: from, firstLedger, elderLedger: elder }
  }
  if (firstSync && firstLedger > elder) {
    return { reason: 'first_sync', firstLedger, elderLedger: elder }
  }
  return null
}

/** A page, or an empty one if Horizon has never heard of the account. */
async function pageOrEmpty<T extends { paging_token: string }>(
  client: HorizonClient,
  path: string,
  query: Record<string, string | number | boolean | undefined>,
): Promise<Page<T>> {
  try {
    return await client.page<T>(path, query)
  } catch (err) {
    if (isNotFound(err)) return { records: [], lastCursor: null }
    throw err
  }
}

/** Return the inclusive end of the feed as observed now, or zero for a new account. */
async function latestCursor(
  client: HorizonClient,
  path: string,
  query: Record<string, string | number | boolean | undefined> = {},
): Promise<string> {
  const newest = await pageOrEmpty(client, path, { ...query, order: 'desc', limit: 1 })
  return newest.lastCursor ?? FROM_START
}

export interface HorizonPullRequest extends PullRequest {
  /** Include the normaliser inputs in this pull for inspection or replay. */
  readonly includeSourceRecords?: boolean
}

export interface HorizonEffectsPullResult extends PullResult {
  readonly sourceRecords?: {
    readonly effects: readonly HorizonEffect[]
    readonly operations: readonly HorizonOperation[]
  }
}

export interface HorizonFeesPullResult extends PullResult {
  readonly sourceRecords?: { readonly transactions: readonly HorizonTransaction[] }
}

export class HorizonEffectsSource implements MovementSource {
  readonly name = 'horizon'
  readonly network: string
  private readonly client: HorizonClient
  private readonly start: 'earliest' | 'latest'
  private readonly lookupBudget: number
  private readonly maxPagesPerOperation: number

  constructor(options: HorizonEffectsSourceOptions) {
    this.client = options.client
    this.network = options.network
    this.start = options.start ?? 'earliest'
    this.lookupBudget = Math.max(1, options.lookupBudget ?? 50)
    this.maxPagesPerOperation = options.maxPagesPerOperation ?? 50
  }

  /** Capture the effects position to pass as the exclusive cursor on a later live pull. */
  latestCursor(account: string): Promise<string> {
    return latestCursor(this.client, `/accounts/${account}/effects`)
  }

  async pull({ tenantId, account, cursor, limit, includeSourceRecords }: HorizonPullRequest): Promise<HorizonEffectsPullResult> {
    const path = `/accounts/${account}/effects`
    const from = cursor ?? (this.start === 'latest' ? await this.latestCursor(account) : FROM_START)
    const page = await pageOrEmpty<HorizonEffect>(this.client, path, { order: 'asc', limit, cursor: from })
    if (page.records.length === 0) {
      return {
        movements: [], cursor: from, caughtUp: true,
        ...(includeSourceRecords ? { sourceRecords: { effects: [], operations: [] } } : {}),
      }
    }

    const first = page.records[0]!
    const gap = await retentionGap(
      this.client,
      cursor,
      ledgerOfToid(operationIdOf(first)),
      first.type,
      this.start === 'earliest',
    )

    let caughtUp = page.records.length < limit
    let records = caughtUp ? [...page.records] : await this.wholeOperations(path, page.records, limit)

    const { operations, stopAt } = await this.enrich(account, records)
    if (stopAt !== null) {
      records = records.filter((r) => BigInt(operationIdOf(r)) < stopAt)
      if (includeSourceRecords) {
        // Enrichment can prefetch listed operations beyond the first missing lookup.
        for (const id of operations.keys()) if (BigInt(id) >= stopAt) operations.delete(id)
      }
      caughtUp = false
    }

    const ctx: NormalizeContext = { tenantId, network: this.network, source: this.name, account }
    return {
      movements: normalizeEffects(records, operations, ctx),
      ...(includeSourceRecords ? { sourceRecords: { effects: records, operations: [...operations.values()] } } : {}),
      cursor: records[records.length - 1]!.paging_token,
      caughtUp,
      ...(gap === null ? {} : { gap }),
    }
  }

  /**
   * Cut a full page on an operation boundary, so the normaliser sees every
   * effect the account has in each operation. Drops a trailing partial
   * operation (the next pull re-reads it); if the page is all one operation,
   * reads on until that operation ends.
   */
  private async wholeOperations(
    path: string,
    records: readonly HorizonEffect[],
    limit: number,
  ): Promise<HorizonEffect[]> {
    const lastOp = operationIdOf(records[records.length - 1]!)
    let keep = records.length
    while (keep > 0 && operationIdOf(records[keep - 1]!) === lastOp) keep -= 1
    if (keep > 0) return records.slice(0, keep)

    const all = [...records]
    for (let pages = 0; pages < this.maxPagesPerOperation; pages++) {
      const next = await this.client.page<HorizonEffect>(path, {
        order: 'asc',
        limit,
        cursor: all[all.length - 1]!.paging_token,
      })
      const same = next.records.filter((r) => operationIdOf(r) === lastOp)
      all.push(...same)
      if (same.length < next.records.length || next.records.length < limit) return all
    }
    throw new Error(
      `Operation ${lastOp} has more than ${this.maxPagesPerOperation * limit} effects; ` +
        `raise maxPagesPerOperation to ingest it.`,
    )
  }

  /**
   * Fetch the joined operation for every operation that moved value. Reads
   * the account's operations feed over the range first, then looks up the
   * rest one by one. Returns `stopAt` when the lookup budget ran out first.
   */
  private async enrich(
    account: string,
    records: readonly HorizonEffect[],
  ): Promise<{ operations: Map<string, HorizonOperation>; stopAt: bigint | null }> {
    const operations = new Map<string, HorizonOperation>()
    const needed = [...new Set(records.filter((r) => VALUE_EFFECTS.has(r.type)).map(operationIdOf))]
      .map(BigInt)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    if (needed.length === 0) return { operations, stopAt: null }

    const wanted = new Set(needed.map(String))
    const last = needed[needed.length - 1]!
    let cursor = (needed[0]! - 1n).toString()
    for (let pages = 0; pages < 3; pages++) {
      const page = await pageOrEmpty<HorizonOperation>(this.client, `/accounts/${account}/operations`, {
        order: 'asc',
        limit: 200,
        cursor,
        join: 'transactions',
      })
      for (const op of page.records) if (wanted.has(op.id)) operations.set(op.id, op)
      if (page.lastCursor === null || page.records.length < 200 || BigInt(page.lastCursor) >= last) break
      cursor = page.lastCursor
    }

    let budget = this.lookupBudget
    for (const id of needed) {
      if (operations.has(String(id))) continue
      if (budget === 0) return { operations, stopAt: id }
      budget -= 1
      try {
        operations.set(String(id), await this.client.get<HorizonOperation>(`/operations/${id}`, { join: 'transactions' }))
      } catch (err) {
        // Horizon no longer has it: the movement is recorded with enrichment missing.
        if (!isNotFound(err)) throw err
      }
    }
    return { operations, stopAt: null }
  }
}

export class HorizonFeesSource implements MovementSource {
  readonly name = 'horizon-fees'
  readonly network: string
  private readonly client: HorizonClient
  private readonly start: 'earliest' | 'latest'

  constructor(options: HorizonSourceOptions) {
    this.client = options.client
    this.network = options.network
    this.start = options.start ?? 'earliest'
  }

  /** Include failed transactions when pinning the fee feed, just as a live pull does. */
  latestCursor(account: string): Promise<string> {
    return latestCursor(this.client, `/accounts/${account}/transactions`, { include_failed: true })
  }

  async pull({ tenantId, account, cursor, limit, includeSourceRecords }: HorizonPullRequest): Promise<HorizonFeesPullResult> {
    const path = `/accounts/${account}/transactions`
    // Failed transactions still pay fees.
    const from = cursor ?? (this.start === 'latest' ? await this.latestCursor(account) : FROM_START)
    const page = await pageOrEmpty<HorizonTransaction>(this.client, path, {
      order: 'asc',
      limit,
      cursor: from,
      include_failed: true,
    })
    const first = page.records[0]
    const gap =
      first === undefined ? null : await retentionGap(this.client, cursor, first.ledger, null, false)
    const ctx: NormalizeContext = { tenantId, network: this.network, source: this.name, account }
    return {
      movements: page.records.flatMap((tx) => normalizeFee(tx, ctx) ?? []),
      ...(includeSourceRecords ? { sourceRecords: { transactions: page.records } } : {}),
      cursor: page.lastCursor ?? from,
      caughtUp: page.records.length < limit,
      ...(gap === null ? {} : { gap }),
    }
  }
}
