import { describe, expect, it } from 'vitest'
import type { MatchStrategy, Movement, NewMovement } from '../src/index.js'
import { DEFAULT_STRATEGIES, MemoryStore, Money, NATIVE, asset, reconcile } from '../src/index.js'

const T = 'acme'
const ACCOUNT = `G${'A'.repeat(55)}`
const PAYER = `G${'B'.repeat(55)}`
const USDC = asset('USDC', 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN')
const usdc = (v: string) => Money.parse(v, USDC)

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
    counterparty: PAYER,
    ledger: 1000 + n,
    txHash: n.toString(16).padStart(64, '0'),
    occurredAt: new Date('2026-10-05T12:00:00Z'),
    ...over,
  }
}

/** A store with three open invoices. */
async function invoices() {
  const store = new MemoryStore({ now: () => new Date('2026-10-01T00:00:00Z') })
  const [muxed, memo, plain] = await store.transaction(async (tx) => [
    await tx.insertExpectation({ tenantId: T, reference: 'INV-1', account: ACCOUNT, amount: usdc('10'), muxedId: 1n }),
    await tx.insertExpectation({ tenantId: T, reference: 'INV-2', account: ACCOUNT, amount: usdc('25') }),
    await tx.insertExpectation({ tenantId: T, reference: 'INV-3', account: ACCOUNT, amount: usdc('7') }),
  ])
  return { store, muxed: muxed!, memo: memo!, plain: plain! }
}

async function ingest(store: MemoryStore, ...movements: NewMovement[]): Promise<Movement[]> {
  return [...(await store.transaction((tx) => tx.insertMovements(movements))).inserted]
}

describe('reconcile', () => {
  it('decides every pending movement and records each outcome', async () => {
    const { store, muxed, memo, plain } = await invoices()
    const [toMuxed, overpaid, noMemo, fee] = await ingest(
      store,
      payment({ muxedId: 1n }),
      payment({ amount: usdc('30'), memo: { type: 'text', value: 'inv 2' } }),
      payment({ amount: usdc('7') }),
      payment({ kind: 'fee', direction: 'debit', amount: Money.fromRaw(100n, NATIVE) }),
    )

    const report = await reconcile({ store, tenantId: T })
    expect(report).toMatchObject({
      processed: 4,
      allocated: 1,
      partial: 1,
      ignored: 1,
      skipped: 0,
      exceptions: { AMBIGUOUS_MATCH: 1 },
      errors: [],
    })

    const disposition = async (m: Movement) => (await store.getMovement(T, m.id))!.disposition
    expect(await disposition(toMuxed!)).toBe('allocated')
    expect(await disposition(overpaid!)).toBe('partial')
    expect(await disposition(noMemo!)).toBe('exception')
    expect(await disposition(fee!)).toBe('ignored')

    const status = async (id: string) => (await store.getExpectation(T, id))!.status
    expect(await status(muxed.id)).toBe('settled')
    expect(await status(memo.id)).toBe('settled')
    expect(await status(plain.id)).toBe('open') // suggested, not settled on amount alone

    const [over] = await store.listExceptions({ tenantId: T, code: 'OVERPAYMENT' })
    expect(over).toMatchObject({ movementId: overpaid!.id, expectationId: memo.id, status: 'open' })
    expect(over!.amount!.toString()).toBe('5.0000000')

    const [suggestion] = await store.listExceptions({ tenantId: T, code: 'AMBIGUOUS_MATCH' })
    expect(JSON.stringify(suggestion!.evidence)).toContain(plain.id)

    const [allocation] = await store.listAllocations({ tenantId: T, movementId: toMuxed!.id })
    expect(allocation).toMatchObject({ expectationId: muxed.id, strategy: 'muxed_id', score: 1 })
  })

  it('leaves nothing pending and is a no-op when run again', async () => {
    const { store } = await invoices()
    await ingest(store, payment({ muxedId: 1n }), payment({ memo: { type: 'text', value: 'nope' } }))
    await reconcile({ store, tenantId: T })
    expect(await store.listMovements({ tenantId: T, disposition: 'pending' })).toEqual([])
    const again = await reconcile({ store, tenantId: T })
    expect(again.processed).toBe(0)
  })

  it('catches a second payment to a settled invoice as a duplicate', async () => {
    const { store, muxed } = await invoices()
    await ingest(store, payment({ muxedId: 1n }))
    await reconcile({ store, tenantId: T })
    await ingest(store, payment({ muxedId: 1n }))
    const report = await reconcile({ store, tenantId: T })
    expect(report.exceptions).toEqual({ DUPLICATE_PAYMENT: 1 })
    const [dup] = await store.listExceptions({ tenantId: T, code: 'DUPLICATE_PAYMENT' })
    expect(dup!.expectationId).toBe(muxed.id)
  })

  it('settles one invoice from several part-payments', async () => {
    const { store, memo } = await invoices()
    await ingest(
      store,
      payment({ amount: usdc('10'), memo: { type: 'text', value: 'INV-2' } }),
      payment({ amount: usdc('15'), memo: { type: 'text', value: 'INV-2' } }),
    )
    const report = await reconcile({ store, tenantId: T })
    expect(report.allocated).toBe(2)
    expect((await store.getExpectation(T, memo.id))!.status).toBe('settled')
  })

  it('matches outgoing payments against payout expectations', async () => {
    const store = new MemoryStore()
    const payout = await store.transaction((tx) =>
      tx.insertExpectation({ tenantId: T, reference: 'PAYROLL-9', account: ACCOUNT, direction: 'debit', amount: usdc('500') }),
    )
    await ingest(store, payment({ direction: 'debit', amount: usdc('500'), memo: { type: 'text', value: 'payroll 9' } }))
    expect((await reconcile({ store, tenantId: T })).allocated).toBe(1)
    expect((await store.getExpectation(T, payout.id))!.status).toBe('settled')
  })

  it('takes at most `limit` movements per call', async () => {
    const { store } = await invoices()
    await ingest(store, payment(), payment(), payment())
    expect((await reconcile({ store, tenantId: T, limit: 2 })).processed).toBe(2)
    expect(await store.listMovements({ tenantId: T, disposition: 'pending' })).toHaveLength(1)
  })

  it('reports a failure, leaves that movement pending, and carries on with the rest', async () => {
    const { store } = await invoices()
    const [bad] = await ingest(store, payment({ memo: { type: 'text', value: 'boom' } }), payment({ muxedId: 1n }))
    const exploding: MatchStrategy = {
      name: 'exploding',
      family: 'payer',
      evaluate: (m) => {
        if (m.id === bad!.id) throw new Error('strategy bug')
        return null
      },
    }
    const report = await reconcile({ store, tenantId: T, strategies: [exploding, ...DEFAULT_STRATEGIES] })
    expect(report.errors.map((e) => [e.movementId, e.error.message])).toEqual([[bad!.id, 'strategy bug']])
    expect(report.allocated).toBe(1)
    expect((await store.getMovement(T, bad!.id))!.disposition).toBe('pending')
  })
})
