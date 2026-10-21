import { describe, expect, it } from 'vitest'
import {
  MemoryStore,
  Money,
  NATIVE,
  allocationJson,
  asset,
  exceptionJson,
  expectationJson,
  journalEntryJson,
  movementJson,
} from '../src/index.js'

const T = 't'
const A = `G${'A'.repeat(55)}`
const B = `G${'B'.repeat(55)}`
const USDC = asset('USDC', 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN')
const MAX = (1n << 64n) - 1n
const HUGE = Money.fromRaw((1n << 70n) + 3n, USDC)

/** One of each record, at the edges JSON.stringify gets wrong on its own. */
async function records() {
  const store = new MemoryStore({ now: () => new Date('2026-10-21T09:30:00.000Z') })
  return store.transaction(async (tx) => {
    const [m] = (
      await tx.insertMovements([
        {
          tenantId: T,
          network: 'testnet',
          source: 'horizon',
          externalId: 'op-1',
          account: A,
          direction: 'credit',
          kind: 'transfer',
          amount: HUGE,
          counterparty: B,
          muxedId: MAX,
          memo: { type: 'id', value: MAX },
          ledger: 7,
          txHash: 'a'.repeat(64),
          operationId: '30064775169',
          occurredAt: new Date('2026-10-20T12:00:00Z'),
        },
      ])
    ).inserted
    const e = await tx.insertExpectation({
      tenantId: T,
      reference: 'INV-1',
      account: A,
      amount: HUGE,
      muxedId: MAX,
      memo: { type: 'text', value: 'INV 1' },
      payers: [B],
      dueAt: new Date('2026-11-01T00:00:00Z'),
      metadata: { po: '77' },
    })
    const a = await tx.allocate({ tenantId: T, movementId: m!.id, expectationId: e.id, amount: HUGE, strategy: 'muxed_id', score: 1 })
    const x = await tx.openException({ tenantId: T, code: 'MEMO_MALFORMED', movementId: m!.id, detail: 'odd', evidence: { why: ['x'] } })
    const j = await tx.postJournalEntry({
      tenantId: T,
      movementId: m!.id,
      postingNo: 1,
      kind: 'initial',
      description: 'Received',
      lines: [
        { account: 'cash', role: 'cash', side: 'debit', amount: HUGE },
        { account: 'ar', role: 'receivable', side: 'credit', amount: HUGE, expectationId: e.id },
      ],
    })
    return { m: m!, e, a, x, j }
  })
}

describe('JSON for records', () => {
  it('keeps every amount and uint64 exact, as strings, and survives JSON.stringify', async () => {
    const { m, e, a, x, j } = await records()
    const all = [movementJson(m), expectationJson(e), allocationJson(a), exceptionJson(x), journalEntryJson(j)]
    const parsed = JSON.parse(JSON.stringify(all)) as unknown[]
    expect(parsed).toEqual(all)
    expect(() => JSON.stringify(m)).toThrow(/BigInt/)

    expect(movementJson(m)).toMatchObject({
      seq: m.seq,
      amount: '118059162071741.1303427', // 2^70 + 3 raw units
      asset: USDC,
      muxedId: '18446744073709551615',
      memo: { type: 'id', value: '18446744073709551615' },
      occurredAt: '2026-10-20T12:00:00.000Z',
      createdAt: '2026-10-21T09:30:00.000Z',
      disposition: 'pending',
    })
    expect(movementJson(m)).not.toHaveProperty('tenantId')
    expect(expectationJson(e)).toMatchObject({
      amount: HUGE.toString(),
      memo: { type: 'text', value: 'INV 1' },
      payers: [B],
      dueAt: '2026-11-01T00:00:00.000Z',
      expiresAt: null,
      status: 'open', // as inserted, before the allocation
      metadata: { po: '77' },
    })
    expect(allocationJson(a)).toMatchObject({ amount: HUGE.toString(), asset: USDC, strategy: 'muxed_id', score: 1 })
    expect(exceptionJson(x)).toMatchObject({ amount: null, asset: null, evidence: { why: ['x'] }, resolvedAt: null })
    expect(journalEntryJson(j).lines).toEqual([
      { account: 'cash', role: 'cash', side: 'debit', amount: HUGE.toString(), asset: USDC, expectationId: null, exceptionId: null },
      { account: 'ar', role: 'receivable', side: 'credit', amount: HUGE.toString(), asset: USDC, expectationId: e.id, exceptionId: null },
    ])
  })

  it('writes a native amount with its seven places, and no memo as null', async () => {
    const store = new MemoryStore()
    const e = await store.transaction((tx) =>
      tx.insertExpectation({ tenantId: T, reference: 'R', account: A, amount: Money.parse('25', NATIVE) }),
    )
    expect(expectationJson(e)).toMatchObject({ amount: '25.0000000', asset: 'native', memo: null, muxedId: null })
  })
})
