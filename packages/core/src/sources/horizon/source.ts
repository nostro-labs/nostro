/**
 * Horizon as a `MovementSource`: one for effects, one for fees.
 *
 * Fees are not effects (ADR 0006), so they come from a second feed with its
 * own cursor. Run both sources for every watched account, or the balance
 * invariant will be short by every fee the account paid.
 */
import type { MovementSource, PullRequest, PullResult } from '../../ingest/index.js'
import type { HorizonClient, Page } from './client.js'
import { HorizonError } from './client.js'
import type { NormalizeContext } from './normalize.js'
import { normalizeEffects, normalizeFee } from './normalize.js'
import type { HorizonEffect, HorizonOperation, HorizonTransaction } from './records.js'
import { operationIdOf } from './records.js'

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

/**
 * Resolve where an account with no cursor starts. "Latest" pins the newest
 * record now, so nothing after it can be skipped; an account with no history
 * reads from the start, so its first records cannot be skipped either.
 */
async function startCursor(
  client: HorizonClient,
  start: 'earliest' | 'latest',
  path: string,
  query: Record<string, string | number | boolean | undefined> = {},
): Promise<string> {
  if (start === 'earliest') return FROM_START
  const newest = await pageOrEmpty(client, path, { ...query, order: 'desc', limit: 1 })
  return newest.lastCursor ?? FROM_START
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

  async pull({ tenantId, account, cursor, limit }: PullRequest): Promise<PullResult> {
    const path = `/accounts/${account}/effects`
    const from = cursor ?? (await startCursor(this.client, this.start, path))
    const page = await pageOrEmpty<HorizonEffect>(this.client, path, { order: 'asc', limit, cursor: from })
    if (page.records.length === 0) return { movements: [], cursor: from, caughtUp: true }

    let caughtUp = page.records.length < limit
    let records = caughtUp ? [...page.records] : await this.wholeOperations(path, page.records, limit)

    const { operations, stopAt } = await this.enrich(account, records)
    if (stopAt !== null) {
      records = records.filter((r) => BigInt(operationIdOf(r)) < stopAt)
      caughtUp = false
    }

    const ctx: NormalizeContext = { tenantId, network: this.network, source: this.name, account }
    return {
      movements: normalizeEffects(records, operations, ctx),
      cursor: records[records.length - 1]!.paging_token,
      caughtUp,
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

  async pull({ tenantId, account, cursor, limit }: PullRequest): Promise<PullResult> {
    const path = `/accounts/${account}/transactions`
    // Failed transactions still pay fees.
    const from = cursor ?? (await startCursor(this.client, this.start, path, { include_failed: true }))
    const page = await pageOrEmpty<HorizonTransaction>(this.client, path, {
      order: 'asc',
      limit,
      cursor: from,
      include_failed: true,
    })
    const ctx: NormalizeContext = { tenantId, network: this.network, source: this.name, account }
    return {
      movements: page.records.flatMap((tx) => normalizeFee(tx, ctx) ?? []),
      cursor: page.lastCursor ?? from,
      caughtUp: page.records.length < limit,
    }
  }
}
