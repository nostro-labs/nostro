import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type {
  Allocation,
  ExceptionRecord,
  HorizonEffect,
  HorizonOperation,
  HorizonTransaction,
  JournalEntry,
  JournalLine,
  Movement,
  NewMovement,
  Store,
  StoreTx,
} from '../src/index.js'
import {
  MemoryStore,
  Money,
  NATIVE,
  asset,
  checkMovement,
  doctor,
  normalizeEffects,
  normalizeFee,
  postJournal,
  reconcile,
} from '../src/index.js'

const T = 'acme'
const ACCOUNT = `G${'A'.repeat(55)}`
const USDC = asset('USDC', 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN')
const usdc = (v: string) => Money.parse(v, USDC)
const CASH = `assets:stellar:testnet:${ACCOUNT}`
const OCCURRED = new Date('2026-10-05T12:00:00Z')

describe('checkMovement', () => {
  const movement = (over: Partial<Movement> = {}): Movement => ({
    id: 'm1',
    tenantId: T,
    seq: 1,
    network: 'testnet',
    source: 'horizon',
    externalId: 'effect-1',
    revision: 1,
    account: ACCOUNT,
    direction: 'credit',
    kind: 'transfer',
    amount: usdc('10'),
    counterparty: null,
    muxedId: null,
    memo: null,
    ledger: 1,
    txHash: null,
    operationId: null,
    occurredAt: OCCURRED,
    enrichment: 'complete',
    disposition: 'allocated',
    ignoredReason: null,
    createdAt: OCCURRED,
    ...over,
  })
  const allocation = (id: string, amount: Money): Allocation => ({
    id,
    tenantId: T,
    movementId: 'm1',
    expectationId: `e-${id}`,
    amount,
    strategy: 'memo_text',
    score: 0.85,
    createdAt: OCCURRED,
  })
  const exception = (status: ExceptionRecord['status']): ExceptionRecord => ({
    id: 'x1',
    tenantId: T,
    seq: 1,
    code: 'OVERPAYMENT',
    status,
    movementId: 'm1',
    expectationId: null,
    account: ACCOUNT,
    amount: usdc('4'),
    detail: 'overpaid',
    evidence: null,
    openedAt: OCCURRED,
    resolvedAt: null,
    resolutionNote: null,
  })
  const line = (role: JournalLine['role'], side: JournalLine['side'], amount: Money, expectationId: string | null = null): JournalLine => ({
    account: role === 'cash' ? CASH : `test:${role}`,
    role,
    side,
    amount,
    expectationId,
    exceptionId: null,
  })
  const entry = (postingNo: number, lines: JournalLine[]): JournalEntry => ({
    id: `j${postingNo}`,
    tenantId: T,
    seq: postingNo,
    movementId: 'm1',
    postingNo,
    kind: postingNo === 1 ? 'initial' : 'reclass',
    effectiveAt: OCCURRED,
    postedAt: OCCURRED,
    description: 'test',
    lines,
  })
  /** The entry `planPosting` would make for a movement fully allocated to `e-a1`. */
  const applied = () => entry(1, [line('cash', 'debit', usdc('10')), line('receivable', 'credit', usdc('10'), 'e-a1')])
  const codes = (findings: ReturnType<typeof checkMovement>) => findings.map((f) => [f.invariant, f.severity, f.code])

  it('finds nothing on an allocated movement whose books agree', () => {
    expect(
      checkMovement({ movement: movement(), allocations: [allocation('a1', usdc('10'))], exceptions: [], entries: [applied()] }),
    ).toEqual([])
  })

  it('flags a partial movement whose only exception has been resolved', () => {
    const [finding] = checkMovement({
      movement: movement({ disposition: 'partial' }),
      allocations: [allocation('a1', usdc('6'))],
      exceptions: [exception('resolved')],
      entries: [],
    })
    expect(finding).toMatchObject({ invariant: 'I1', severity: 'error', code: 'disposition_unsupported', movementId: 'm1' })
    expect(finding!.detail).toMatch(/no open exception.*allocate the rest/)
  })

  it('flags allocations on a movement that is still pending', () => {
    const findings = checkMovement({
      movement: movement({ disposition: 'pending' }),
      allocations: [allocation('a1', usdc('10'))],
      exceptions: [],
      entries: [],
    })
    expect(codes(findings)).toEqual([['I1', 'error', 'disposition_unsupported']])
  })

  it('flags an ignored movement with no reason', () => {
    const findings = checkMovement({ movement: movement({ disposition: 'ignored' }), allocations: [], exceptions: [], entries: [] })
    expect(codes(findings)).toEqual([['I1', 'error', 'disposition_unsupported']])
  })

  it('flags allocations beyond the movement amount', () => {
    const findings = checkMovement({
      movement: movement({ disposition: 'exception' }),
      allocations: [allocation('a1', usdc('6')), allocation('a2', usdc('5'))],
      exceptions: [exception('open')],
      entries: [],
    })
    expect(codes(findings)).toEqual([['I1', 'error', 'allocation_over_movement']])
  })

  it('flags an allocation in another asset and checks nothing that would need sums', () => {
    const findings = checkMovement({
      movement: movement(),
      allocations: [allocation('a1', Money.parse('10', NATIVE))],
      exceptions: [],
      entries: [applied()],
    })
    expect(codes(findings)).toEqual([['I1', 'error', 'allocation_asset']])
  })

  it('reports the first entry that does not balance, not the ones after it', () => {
    const bad = entry(1, [line('cash', 'debit', usdc('10')), line('receivable', 'credit', usdc('9'), 'e-a1')])
    const findings = checkMovement({
      movement: movement(),
      allocations: [allocation('a1', usdc('10'))],
      exceptions: [],
      entries: [bad, entry(2, [line('receivable', 'credit', usdc('1'), 'e-a1'), line('cash', 'debit', usdc('1'))])],
    })
    expect(findings).toEqual([expect.objectContaining({ invariant: 'I3', code: 'journal_unbalanced', entryId: 'j1' })])
  })

  it('flags a gap in posting numbers', () => {
    const second = { ...applied(), id: 'j3', postingNo: 3 }
    const findings = checkMovement({ movement: movement(), allocations: [allocation('a1', usdc('10'))], exceptions: [], entries: [second] })
    expect(findings).toEqual([expect.objectContaining({ code: 'journal_posting_sequence', entryId: 'j3' })])
  })

  it('flags a cash leg that does not match the movement', () => {
    const findings = checkMovement({
      movement: movement(),
      allocations: [allocation('a1', usdc('10'))],
      exceptions: [],
      entries: [entry(1, [line('cash', 'debit', usdc('12')), line('receivable', 'credit', usdc('12'), 'e-a1')])],
    })
    expect(codes(findings)).toEqual([['I3', 'error', 'journal_cash_mismatch']])
  })

  it('flags lines in another asset', () => {
    const xlm = Money.parse('10', NATIVE)
    const findings = checkMovement({
      movement: movement(),
      allocations: [allocation('a1', usdc('10'))],
      exceptions: [],
      entries: [entry(1, [line('cash', 'debit', xlm), line('receivable', 'credit', xlm, 'e-a1')])],
    })
    expect(codes(findings)).toEqual([['I3', 'error', 'journal_asset']])
  })

  it('warns when a decision has not been posted yet, but not for a pending movement', () => {
    const decided = checkMovement({ movement: movement(), allocations: [allocation('a1', usdc('10'))], exceptions: [], entries: [] })
    expect(codes(decided)).toEqual([['I3', 'warning', 'journal_stale']])
    const later = checkMovement({
      movement: movement(),
      allocations: [allocation('a1', usdc('6')), allocation('a2', usdc('4'))],
      exceptions: [],
      entries: [applied()],
    })
    expect(codes(later)).toEqual([['I3', 'warning', 'journal_stale']])
    expect(checkMovement({ movement: movement({ disposition: 'pending' }), allocations: [], exceptions: [], entries: [] })).toEqual([])
  })
})

let n = 0
function payment(over: Partial<NewMovement> = {}): NewMovement {
  n += 1
  return {
    tenantId: T,
    network: 'testnet',
    source: 'horizon',
    externalId: `effect-${n}`,
    account: ACCOUNT,
    direction: 'credit',
    kind: 'transfer',
    amount: usdc('10'),
    ledger: 1000 + n,
    occurredAt: new Date(OCCURRED.getTime() + n * 1000),
    ...over,
  }
}

/**
 * A store whose reads are edited on the way out: outside transactions only,
 * or everywhere. Stands in for a writer racing the doctor, or for rows
 * changed behind the store's back.
 */
function tampered(
  store: Store,
  edit: (entries: JournalEntry[]) => JournalEntry[],
  where: 'outside' | 'everywhere',
): Store {
  const wrap = <S extends Store | StoreTx>(target: S): S =>
    new Proxy(target, {
      get(t, prop) {
        if (prop === 'listJournalEntries') {
          return async (q: Parameters<Store['listJournalEntries']>[0]) => edit(await t.listJournalEntries(q))
        }
        if (prop === 'transaction') {
          return <R>(fn: (tx: StoreTx) => Promise<R>) =>
            (t as Store).transaction((tx) => fn(where === 'everywhere' ? wrap(tx) : tx))
        }
        const value = Reflect.get(t, prop) as unknown
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(t) : value
      },
    })
  return wrap(store)
}

async function reconciled() {
  const store = new MemoryStore()
  await store.transaction(async (tx) => {
    await tx.insertExpectation({ tenantId: T, reference: 'INV-2', account: ACCOUNT, amount: usdc('25') })
    await tx.insertExpectation({ tenantId: T, reference: 'INV-3', account: ACCOUNT, amount: usdc('5') })
    await tx.insertMovements([
      payment({ amount: usdc('30'), memo: { type: 'text', value: 'INV 2' } }), // overpaid: partial
      payment({ amount: usdc('5'), memo: { type: 'text', value: 'INV-3' } }), // allocated
      payment({ amount: usdc('7') }), // unexplained: exception
      payment({ kind: 'fee', direction: 'debit', amount: Money.fromRaw(100n, NATIVE) }), // ignored
    ])
  })
  await reconcile({ store, tenantId: T })
  // Still pending, and recorded out of time order.
  await store.transaction((tx) =>
    tx.insertMovements([payment({ amount: usdc('1') }), payment({ amount: usdc('2'), occurredAt: OCCURRED })]),
  )
  return store
}

describe('doctor', () => {
  it('finds nothing after reconcile, and accounts for every movement and entry', async () => {
    const store = await reconciled()
    const report = await doctor({ store, tenantId: T })
    expect(report.findings).toEqual([])
    expect(report.ok).toBe(true)
    expect(report.movements).toEqual({
      total: 6,
      byDisposition: { pending: 2, allocated: 1, partial: 1, exception: 1, ignored: 1 },
      oldestPending: OCCURRED,
    })
    expect(report.journal.entries).toBe(4)
    expect(report.journal.totals.map((t) => [t.asset, t.debits.toString(), t.credits.toString()])).toEqual([
      [USDC, '42.0000000', '42.0000000'],
      [NATIVE, '0.0000100', '0.0000100'],
    ])
  })

  it('reads every page', async () => {
    const store = await reconciled()
    const report = await doctor({ store, tenantId: T, pageSize: 2 })
    expect(report.movements.total).toBe(6)
    expect(report.journal.entries).toBe(4)
  })

  it('flags a partial movement left behind when its exception is resolved, until it is re-marked', async () => {
    const store = await reconciled()
    const [over] = await store.listMovements({ tenantId: T, disposition: 'partial' })
    const [exception] = await store.listExceptions({ tenantId: T, movementId: over!.id })
    await store.transaction((tx) => tx.resolveException(T, exception!.id, { status: 'resolved', note: 'refunded' }))

    const report = await doctor({ store, tenantId: T })
    expect(report.ok).toBe(false)
    expect(report.findings).toEqual([
      expect.objectContaining({ invariant: 'I1', severity: 'error', code: 'disposition_unsupported', movementId: over!.id }),
    ])

    await store.transaction((tx) => tx.setDisposition(T, over!.id, 'exception'))
    expect((await doctor({ store, tenantId: T })).findings).toEqual([])
  })

  it('warns that the books lag a decision made by hand, until the journal is posted', async () => {
    const store = await reconciled()
    const [unexplained] = await store.listMovements({ tenantId: T, disposition: 'exception' })
    await store.transaction(async (tx) => {
      const e = await tx.insertExpectation({ tenantId: T, reference: 'INV-9', account: ACCOUNT, amount: usdc('7') })
      await tx.allocate({ tenantId: T, movementId: unexplained!.id, expectationId: e.id, amount: usdc('7'), strategy: 'manual' })
      await tx.setDisposition(T, unexplained!.id, 'allocated')
    })

    const report = await doctor({ store, tenantId: T })
    expect(report.ok).toBe(true)
    expect(report.findings).toEqual([
      expect.objectContaining({ invariant: 'I3', severity: 'warning', code: 'journal_stale', movementId: unexplained!.id }),
    ])

    await postJournal({ store, tenantId: T })
    expect((await doctor({ store, tenantId: T })).findings).toEqual([])
  })

  it('re-reads a suspect movement under its lock and drops what a racing writer explains', async () => {
    const store = await reconciled()
    // Outside a transaction the doctor sees no journal: as if it read the
    // movement just before reconcile's entry committed.
    const racing = tampered(store, () => [], 'outside')
    expect((await doctor({ store: racing, tenantId: T })).findings).toEqual([])
  })

  it('reports an entry that stopped balancing once, from either pass', async () => {
    const store = await reconciled()
    await store.transaction((tx) =>
      tx.postJournalEntry({
        tenantId: T,
        kind: 'initial',
        description: 'opening balance',
        lines: [
          { account: 'assets:opening', role: 'unexplained', side: 'debit', amount: usdc('3') },
          { account: 'equity:opening', role: 'unapplied', side: 'credit', amount: usdc('3') },
        ],
      }),
    )
    const extra = (e: JournalEntry): JournalEntry =>
      e.kind === 'initial' && (e.movementId === null || e.lines[0]!.amount.equals(usdc('5')))
        ? { ...e, lines: [...e.lines, { ...e.lines[0]!, amount: usdc('1') }] }
        : e
    const report = await doctor({ store: tampered(store, (es) => es.map(extra), 'everywhere'), tenantId: T })
    expect(report.ok).toBe(false)
    expect(report.findings.map((f) => [f.code, f.movementId === null])).toEqual([
      ['journal_unbalanced', false],
      ['journal_unbalanced', true],
    ])
  })
})

describe('doctor over every captured Horizon fixture', () => {
  it('finds nothing wrong once every participant has been ingested, reconciled and posted', async () => {
    const dir = new URL('../../../fixtures/horizon/pubnet/', import.meta.url)
    const ctx = (account: string, source: string) => ({ tenantId: T, network: 'public', source, account })
    const facts: NewMovement[] = []
    for (const name of readdirSync(fileURLToPath(dir)).filter((f) => f.endsWith('.json'))) {
      const f = JSON.parse(readFileSync(fileURLToPath(new URL(name, dir)), 'utf8')) as {
        operation?: HorizonOperation
        effects?: HorizonEffect[]
        transactions?: Record<string, HorizonTransaction>
      }
      if (f.operation !== undefined && f.effects !== undefined) {
        const ops = new Map([[f.operation.id, f.operation]])
        for (const account of new Set(f.effects.map((e) => e.account))) {
          facts.push(...normalizeEffects(f.effects, ops, ctx(account, 'horizon')))
        }
      }
      for (const tx of Object.values(f.transactions ?? {})) {
        const fee = normalizeFee(tx, ctx(tx.fee_account, 'horizon-fees'))
        if (fee !== null) facts.push(fee)
      }
    }
    expect(facts.length).toBeGreaterThan(30)

    const store = new MemoryStore()
    await store.transaction(async (tx) => {
      await tx.insertMovements(facts)
      // Give the muxed payment something to settle, so allocation is covered too.
      const muxed = facts.find((m) => m.muxedId != null && m.direction === 'credit')!
      await tx.insertExpectation({
        tenantId: T,
        reference: 'MUXED',
        account: muxed.account,
        amount: muxed.amount,
        muxedId: muxed.muxedId!,
      })
    })
    expect((await reconcile({ store, tenantId: T, limit: 1000 })).errors).toEqual([])
    expect((await postJournal({ store, tenantId: T })).errors).toEqual([])

    const report = await doctor({ store, tenantId: T })
    expect(report.findings).toEqual([])
    expect(report.movements.total).toBe(facts.length)
    expect(report.movements.byDisposition.pending).toBe(0)
    expect(report.movements.byDisposition.allocated).toBe(1)
    expect(report.journal.entries).toBe(facts.length)
    expect(report.journal.totals.every((t) => t.debits.equals(t.credits))).toBe(true)
  })
})
