/**
 * `doctor()`: check a tenant's records against the invariants.
 *
 * It reads every movement and every journal entry, so it is a batch job, not
 * something to run per request. Each movement is read without locks; a
 * movement that shows a problem is read again inside a transaction, which
 * waits for any writer that was part-way through it, and only what is still
 * wrong then is reported.
 *
 * It writes nothing, unless asked to attest balances (I2): that catches the
 * sources up first, which records new movements as `sync()` would.
 */
import type { Disposition, JournalEntry, Movement } from '../model/index.js'
import { Money } from '../money/index.js'
import type { AssetId } from '../money/index.js'
import type { Store, StoreReader } from '../store/index.js'
import type { AttestOptions, BalanceCheck } from './balances.js'
import { attestBalances } from './balances.js'
import type { MovementRecords } from './movement.js'
import { checkMovement } from './movement.js'
import type { Finding } from './types.js'

export interface DoctorOptions {
  readonly store: Store
  readonly tenantId: string
  /** Movements and journal entries read per query. Default 500. */
  readonly pageSize?: number
  /** Also attest these accounts' balances against the chain (I2). */
  readonly attest?: Omit<AttestOptions, 'store' | 'tenantId'>
}

export interface JournalTotal {
  readonly asset: AssetId
  readonly debits: Money
  readonly credits: Money
}

export interface DoctorReport {
  /** No finding is an error. Warnings do not make a report fail. */
  readonly ok: boolean
  readonly findings: readonly Finding[]
  readonly movements: {
    readonly total: number
    readonly byDisposition: Readonly<Record<Disposition, number>>
    /** When the oldest movement still waiting to be decided happened. */
    readonly oldestPending: Date | null
  }
  readonly journal: {
    readonly entries: number
    /** Per asset across every entry. Debits equal credits when I3 holds. */
    readonly totals: readonly JournalTotal[]
  }
  /** One check per account and asset, or `null` when balances were not attested. */
  readonly balances: readonly BalanceCheck[] | null
}

async function recordsOf(reader: StoreReader, tenantId: string, movement: Movement): Promise<MovementRecords> {
  const movementId = movement.id
  return {
    movement,
    allocations: await reader.listAllocations({ tenantId, movementId }),
    exceptions: await reader.listExceptions({ tenantId, movementId }),
    entries: await reader.listJournalEntries({ tenantId, movementId }),
  }
}

export async function doctor(options: DoctorOptions): Promise<DoctorReport> {
  const { store, tenantId } = options
  const limit = options.pageSize ?? 500
  const findings: Finding[] = []
  const byDisposition: Record<Disposition, number> = { pending: 0, allocated: 0, partial: 0, exception: 0, ignored: 0 }
  let total = 0
  let oldestPending: Date | null = null

  // First, so the movements it catches up are checked below too.
  const balances = options.attest === undefined ? null : await attestBalances({ store, tenantId, ...options.attest })
  for (const c of balances ?? []) {
    if (c.status !== 'mismatch') continue
    findings.push({
      invariant: 'I2',
      severity: 'error',
      code: 'balance_mismatch',
      detail:
        `the chain says ${c.account} holds ${c.chain.toString()} ${c.asset}` +
        `${c.ledger === null ? '' : ` as of ledger ${c.ledger}`}, but its recorded movements add up to ${c.recorded.toString()}`,
      movementId: null,
      entryId: null,
      account: c.account,
      asset: c.asset,
    })
  }

  for (let afterSeq: number | undefined; ; ) {
    const page = await store.listMovements({ tenantId, limit, ...(afterSeq === undefined ? {} : { afterSeq }) })
    for (const m of page) {
      total += 1
      byDisposition[m.disposition] += 1
      if (m.disposition === 'pending' && (oldestPending === null || m.occurredAt < oldestPending)) {
        oldestPending = m.occurredAt
      }
      let found = checkMovement(await recordsOf(store, tenantId, m))
      if (found.length > 0) {
        found = await store.transaction(async (tx) => {
          const locked = await tx.getMovement(tenantId, m.id)
          return locked === null ? [] : checkMovement(await recordsOf(tx, tenantId, locked))
        })
      }
      findings.push(...found)
    }
    if (page.length < limit) break
    afterSeq = page[page.length - 1]!.seq
  }

  // Every entry, including those with no movement, for the totals and for
  // the balance of entries the movement pass did not see.
  const reported = new Set(findings.map((f) => `${f.code} ${f.entryId}`))
  const sums = new Map<string, { like: Money; debits: bigint; credits: bigint }>()
  let entries = 0
  for (let afterSeq: number | undefined; ; ) {
    const page = await store.listJournalEntries({ tenantId, limit, ...(afterSeq === undefined ? {} : { afterSeq }) })
    for (const entry of page) {
      entries += 1
      const unbalanced = tally(entry, sums)
      if (unbalanced.length > 0 && !reported.has(`journal_unbalanced ${entry.id}`)) {
        findings.push({
          invariant: 'I3',
          severity: 'error',
          code: 'journal_unbalanced',
          detail: `entry ${entry.id} does not balance in ${unbalanced.join(', ')}`,
          movementId: entry.movementId,
          entryId: entry.id,
          account: null,
          asset: unbalanced[0]!,
        })
      }
    }
    if (page.length < limit) break
    afterSeq = page[page.length - 1]!.seq
  }

  return {
    ok: findings.every((f) => f.severity !== 'error'),
    findings,
    movements: { total, byDisposition, oldestPending },
    journal: {
      entries,
      totals: [...sums.values()].map((s) => ({
        asset: s.like.asset,
        debits: Money.fromRaw(s.debits, s.like.asset, s.like.decimals),
        credits: Money.fromRaw(s.credits, s.like.asset, s.like.decimals),
      })),
    },
    balances,
  }
}

/** Add an entry's lines to the running totals; returns the assets it does not balance in. */
function tally(entry: JournalEntry, sums: Map<string, { like: Money; debits: bigint; credits: bigint }>): AssetId[] {
  const net = new Map<string, bigint>()
  for (const line of entry.lines) {
    const key = `${line.amount.asset}/${line.amount.decimals}`
    let s = sums.get(key)
    if (s === undefined) sums.set(key, (s = { like: line.amount, debits: 0n, credits: 0n }))
    if (line.side === 'debit') s.debits += line.amount.raw
    else s.credits += line.amount.raw
    net.set(key, (net.get(key) ?? 0n) + (line.side === 'debit' ? line.amount.raw : -line.amount.raw))
  }
  return [...net].filter(([, v]) => v !== 0n).map(([key]) => sums.get(key)!.like.asset)
}
