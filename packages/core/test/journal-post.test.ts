import { describe, expect, it } from 'vitest'
import type { JournalEntry, NewMovement, Store } from '../src/index.js'
import { DEFAULT_CHART, MemoryStore, Money, NATIVE, asset, postJournal, postMovement, reconcile, signedAmount } from '../src/index.js'

const T = 'acme'
const ACCOUNT = `G${'A'.repeat(55)}`
const USDC = asset('USDC', 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN')
const usdc = (v: string) => Money.parse(v, USDC)
const CASH = `assets:stellar:testnet:${ACCOUNT}`
const OCCURRED = new Date('2026-10-05T12:00:00Z')
const LATER = new Date('2026-10-12T09:00:00Z')

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
    occurredAt: OCCURRED,
    ...over,
  }
}

/** Net debit-positive balance per account and asset across every entry. */
async function balances(store: Store): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>()
  for (const e of await store.listJournalEntries({ tenantId: T })) {
    for (const l of e.lines) {
      const key = `${l.account} ${l.amount.asset}`
      out.set(key, (out.get(key) ?? 0n) + (l.side === 'debit' ? l.amount.raw : -l.amount.raw))
    }
  }
  return out
}

/** Σ debits − Σ credits per asset over all entries: zero when I3 holds. */
async function imbalance(store: Store): Promise<bigint[]> {
  const per = new Map<string, bigint>()
  for (const e of await store.listJournalEntries({ tenantId: T })) {
    for (const l of e.lines) per.set(l.amount.asset, (per.get(l.amount.asset) ?? 0n) + (l.side === 'debit' ? l.amount.raw : -l.amount.raw))
  }
  return [...per.values()]
}

async function setup() {
  let clock = OCCURRED
  const store = new MemoryStore({ now: () => clock })
  const invoice = await store.transaction((tx) =>
    tx.insertExpectation({ tenantId: T, reference: 'INV-2', account: ACCOUNT, amount: usdc('25') }),
  )
  clock = LATER
  return { store, invoice }
}

describe('reconcile posts the journal', () => {
  it('posts one balanced initial entry per decided movement, dated when the money moved', async () => {
    const { store } = await setup()
    await store.transaction((tx) =>
      tx.insertMovements([
        payment({ amount: usdc('30'), memo: { type: 'text', value: 'INV 2' } }),
        payment({ amount: usdc('7') }),
        payment({ kind: 'fee', direction: 'debit', amount: Money.fromRaw(100n, NATIVE) }),
      ]),
    )
    const report = await reconcile({ store, tenantId: T })
    expect(report.journalEntries).toBe(3)

    const entries = await store.listJournalEntries({ tenantId: T })
    expect(entries.map((e) => [e.kind, e.postingNo, e.effectiveAt.toISOString()])).toEqual([
      ['initial', 1, OCCURRED.toISOString()],
      ['initial', 1, OCCURRED.toISOString()],
      ['initial', 1, OCCURRED.toISOString()],
    ])
    expect(await imbalance(store)).toEqual([0n, 0n])

    const b = await balances(store)
    expect(b.get(`${CASH} ${USDC}`)).toBe(370_000_000n) // 30 + 7 in
    expect(b.get(`assets:receivable ${USDC}`)).toBe(-250_000_000n) // 25 applied to INV-2
    expect(b.get(`liabilities:customer-credit ${USDC}`)).toBe(-50_000_000n) // 5 overpaid
    expect(b.get(`liabilities:unapplied-receipts ${USDC}`)).toBe(-70_000_000n) // 7 with no memo
    expect(b.get(`expenses:network-fees native`)).toBe(100n)
    expect(b.get(`${CASH} native`)).toBe(-100n)
  })

  it("keeps each wallet's cash equal to the sum of its movements", async () => {
    const { store } = await setup()
    await store.transaction((tx) =>
      tx.insertMovements([payment(), payment({ direction: 'debit', amount: usdc('4') }), payment({ amount: usdc('2.5') })]),
    )
    await reconcile({ store, tenantId: T })
    const movements = await store.listMovements({ tenantId: T })
    const expected = movements.reduce((sum, m) => sum + signedAmount(m).raw, 0n)
    expect((await balances(store)).get(`${CASH} ${USDC}`)).toBe(expected)
  })

  it('posts nothing more when reconcile or the sweep run again', async () => {
    const { store } = await setup()
    await store.transaction((tx) => tx.insertMovements([payment({ memo: { type: 'text', value: 'INV-2' } }), payment()]))
    await reconcile({ store, tenantId: T })
    const before = (await store.listJournalEntries({ tenantId: T })).length
    expect((await reconcile({ store, tenantId: T })).journalEntries).toBe(0)
    expect((await postJournal({ store, tenantId: T })).posted).toEqual({ initial: 0, reclass: 0, correction: 0 })
    expect(await store.listJournalEntries({ tenantId: T })).toHaveLength(before)
  })

  it('posts with a custom chart of accounts', async () => {
    const { store } = await setup()
    await store.transaction((tx) => tx.insertMovements([payment({ memo: { type: 'text', value: 'INV-2' } })]))
    const chart = { ...DEFAULT_CHART, cash: () => 'Assets:Bank:Stellar', receivable: 'Assets:AR' }
    await reconcile({ store, tenantId: T, chart })
    const [entry] = await store.listJournalEntries({ tenantId: T })
    expect(entry!.lines.map((l) => l.account)).toEqual(['Assets:Bank:Stellar', 'Assets:AR'])
  })
})

describe('postJournal', () => {
  it('backfills movements decided before the journal existed, at the date the money moved', async () => {
    const { store } = await setup()
    const { inserted } = await store.transaction((tx) =>
      tx.insertMovements([payment({ kind: 'fee', direction: 'debit', amount: Money.fromRaw(100n, NATIVE) }), payment()]),
    )
    // Decided by hand, without reconcile, so nothing was posted.
    await store.transaction((tx) => tx.setDisposition(T, inserted[0]!.id, 'ignored', 'fee'))
    const report = await postJournal({ store, tenantId: T })
    expect(report).toMatchObject({ examined: 2, posted: { initial: 1, reclass: 0, correction: 0 }, errors: [] })
    expect(report.lastSeq).toBe(inserted[1]!.seq)
    const [entry] = await store.listJournalEntries({ tenantId: T })
    expect(entry).toMatchObject({ movementId: inserted[0]!.id, kind: 'initial', effectiveAt: OCCURRED })
  })

  it('pages with afterSeq and limit', async () => {
    const { store } = await setup()
    const { inserted } = await store.transaction((tx) => tx.insertMovements([payment(), payment(), payment()]))
    for (const m of inserted) await store.transaction((tx) => tx.setDisposition(T, m.id, 'ignored', 'test'))
    const first = await postJournal({ store, tenantId: T, limit: 2 })
    expect(first.posted.initial).toBe(2)
    const rest = await postJournal({ store, tenantId: T, afterSeq: first.lastSeq! })
    expect(rest).toMatchObject({ examined: 1, posted: { initial: 1 } })
  })

  it('reports a movement it cannot post and carries on', async () => {
    const { store } = await setup()
    const { inserted } = await store.transaction((tx) => tx.insertMovements([payment(), payment()]))
    for (const m of inserted) await store.transaction((tx) => tx.setDisposition(T, m.id, 'ignored', 'test'))
    const chart = {
      ...DEFAULT_CHART,
      cash: () => {
        throw new Error('no account for this wallet')
      },
    }
    const report = await postJournal({ store, tenantId: T, chart })
    expect(report.errors.map((e) => e.error.message)).toEqual(['no account for this wallet', 'no account for this wallet'])
    expect(await store.listJournalEntries({ tenantId: T })).toEqual([])
  })
})

describe('a decision made later by a person', () => {
  it('is one reclass entry that leaves cash alone, dated when it was made', async () => {
    const { store, invoice } = await setup()
    await store.transaction((tx) => tx.insertMovements([payment({ amount: usdc('25') })]))
    await reconcile({ store, tenantId: T }) // no memo: suggested, not settled
    const [m] = await store.listMovements({ tenantId: T })
    const [x] = await store.listExceptions({ tenantId: T })
    expect(x!.code).toBe('AMBIGUOUS_MATCH')

    // A person confirms the suggestion.
    const entry = await store.transaction(async (tx) => {
      await tx.allocate({ tenantId: T, movementId: m!.id, expectationId: invoice.id, amount: usdc('25'), strategy: 'manual' })
      await tx.setDisposition(T, m!.id, 'allocated')
      await tx.resolveException(T, x!.id, { status: 'resolved', note: 'confirmed by the customer' })
      return postMovement(tx, T, m!.id)
    })
    expect(entry).toMatchObject({ kind: 'reclass', postingNo: 2, effectiveAt: LATER })
    expect(entry!.lines.map((l) => [l.side, l.account, l.amount.toString(), l.expectationId])).toEqual([
      ['credit', 'assets:receivable', '25.0000000', invoice.id],
      ['debit', 'liabilities:unapplied-receipts', '25.0000000', null],
    ])
    const cashLines = (await store.listJournalEntries({ tenantId: T })).flatMap((e: JournalEntry) =>
      e.lines.filter((l) => l.role === 'cash'),
    )
    expect(cashLines).toHaveLength(1)
    expect((await balances(store)).get(`liabilities:unapplied-receipts ${USDC}`)).toBe(0n)
    expect(await postJournal({ store, tenantId: T })).toMatchObject({ posted: { initial: 0, reclass: 0, correction: 0 } })
  })
})
