import { describe, expect, it } from 'vitest'
import type { NewAllocation, NewException, NewExpectation, NewMovement } from '../src/index.js'
import {
  Money,
  NATIVE,
  ValidationError,
  assertValidMemo,
  assertValidNewAllocation,
  assertValidNewException,
  assertValidNewExpectation,
  assertValidNewMovement,
  isAccountId,
  signedAmount,
} from '../src/index.js'

const ACCOUNT = `G${'A'.repeat(55)}`
const xlm = (v: string) => Money.parse(v, NATIVE)

const movement: NewMovement = {
  tenantId: 't',
  network: 'testnet',
  source: 'horizon',
  externalId: '0004398046515201-0000000001',
  account: ACCOUNT,
  direction: 'credit',
  kind: 'transfer',
  amount: xlm('1'),
  ledger: 1024,
  txHash: 'ab'.repeat(32),
  occurredAt: new Date('2026-10-01T00:00:00Z'),
}
const expectation: NewExpectation = { tenantId: 't', reference: 'INV-1', account: ACCOUNT, amount: xlm('1') }
const allocation: NewAllocation = {
  tenantId: 't',
  movementId: 'm',
  expectationId: 'e',
  amount: xlm('1'),
  strategy: 'memo_id',
}
const exception: NewException = { tenantId: 't', code: 'MEMO_MISSING', account: ACCOUNT, detail: 'no memo' }

/** Assert the validator rejects the input, naming the offending field. */
function rejects(fn: () => void, field: string): void {
  try {
    fn()
  } catch (err) {
    expect(err).toBeInstanceOf(ValidationError)
    expect((err as ValidationError).field).toBe(field)
    return
  }
  throw new Error(`expected a ValidationError on ${field}`)
}

describe('signedAmount', () => {
  it('adds credits and subtracts debits', () => {
    expect(signedAmount({ amount: xlm('2'), direction: 'credit' }).raw).toBe(20_000_000n)
    expect(signedAmount({ amount: xlm('2'), direction: 'debit' }).raw).toBe(-20_000_000n)
  })
})

describe('isAccountId', () => {
  it('accepts classic accounts only', () => {
    expect(isAccountId(ACCOUNT)).toBe(true)
    expect(isAccountId(`M${'A'.repeat(68)}`)).toBe(false)
    expect(isAccountId(`C${'A'.repeat(55)}`)).toBe(false)
    expect(isAccountId(`G${'a'.repeat(55)}`)).toBe(false)
  })
})

describe('assertValidMemo', () => {
  it('accepts every memo type in its valid shape', () => {
    assertValidMemo('memo', { type: 'text', value: '' })
    assertValidMemo('memo', { type: 'id', value: 0n })
    assertValidMemo('memo', { type: 'hash', value: '0f'.repeat(32) })
    assertValidMemo('memo', { type: 'return', value: '0f'.repeat(32) })
  })

  it('rejects malformed memos', () => {
    rejects(() => assertValidMemo('memo', { type: 'text', value: 7 as unknown as string }), 'memo')
    rejects(() => assertValidMemo('memo', { type: 'id', value: -1n }), 'memo.value')
    rejects(() => assertValidMemo('memo', { type: 'id', value: 5 as unknown as bigint }), 'memo.value')
    rejects(() => assertValidMemo('memo', { type: 'return', value: '0F'.repeat(32) }), 'memo')
    rejects(() => assertValidMemo('memo', { type: 'note', value: 'x' } as never), 'memo')
  })
})

describe('assertValidNewMovement', () => {
  it('accepts a minimal movement', () => {
    assertValidNewMovement(movement)
    assertValidNewMovement({ ...movement, revision: 3, enrichment: 'missing', operationId: '42' })
  })

  it.each<[Partial<Record<keyof NewMovement, unknown>>, string]>([
    [{ tenantId: '' }, 'tenantId'],
    [{ network: '   ' }, 'network'],
    [{ externalId: 'x'.repeat(257) }, 'externalId'],
    [{ revision: 0 }, 'revision'],
    [{ revision: 1.5 }, 'revision'],
    [{ direction: 'sideways' }, 'direction'],
    [{ kind: 'payment' }, 'kind'],
    [{ counterparty: 'not-an-address' }, 'counterparty'],
    [{ ledger: 1.5 }, 'ledger'],
    [{ operationId: '' }, 'operationId'],
    [{ occurredAt: new Date('nonsense') }, 'occurredAt'],
    [{ occurredAt: '2026-10-01' }, 'occurredAt'],
    [{ enrichment: 'partial' }, 'enrichment'],
  ])('rejects %o', (over, field) => {
    rejects(() => assertValidNewMovement({ ...movement, ...over } as NewMovement), field)
  })
})

describe('assertValidNewExpectation', () => {
  it('accepts a fully specified expectation', () => {
    assertValidNewExpectation({
      ...expectation,
      direction: 'debit',
      muxedId: 7n,
      memo: { type: 'text', value: 'INV-1' },
      payers: [ACCOUNT],
      dueAt: new Date(),
      expiresAt: new Date(),
      metadata: { customer: 'acme' },
    })
  })

  it.each<[Partial<Record<keyof NewExpectation, unknown>>, string]>([
    [{ reference: '' }, 'reference'],
    [{ account: `M${'A'.repeat(68)}` }, 'account'],
    [{ direction: 'in' }, 'direction'],
    [{ amount: xlm('0') }, 'amount'],
    [{ muxedId: 2n ** 64n }, 'muxedId'],
    [{ memo: { type: 'hash', value: 'nope' } }, 'memo'],
    [{ payers: [ACCOUNT, 'GBAD'] }, 'payers[1]'],
    [{ dueAt: new Date('x') }, 'dueAt'],
    [{ expiresAt: 0 }, 'expiresAt'],
    [{ metadata: { tier: 3 } }, 'metadata.tier'],
  ])('rejects %o', (over, field) => {
    rejects(() => assertValidNewExpectation({ ...expectation, ...over } as NewExpectation), field)
  })
})

describe('assertValidNewAllocation', () => {
  it('accepts scores in [0, 1] and manual allocations without one', () => {
    assertValidNewAllocation(allocation)
    assertValidNewAllocation({ ...allocation, score: 0 })
    assertValidNewAllocation({ ...allocation, score: 1 })
    assertValidNewAllocation({ ...allocation, score: null })
  })

  it.each<[Partial<Record<keyof NewAllocation, unknown>>, string]>([
    [{ movementId: '' }, 'movementId'],
    [{ amount: xlm('-1') }, 'amount'],
    [{ strategy: '' }, 'strategy'],
    [{ score: 1.01 }, 'score'],
    [{ score: Number.NaN }, 'score'],
  ])('rejects %o', (over, field) => {
    rejects(() => assertValidNewAllocation({ ...allocation, ...over } as NewAllocation), field)
  })
})

describe('assertValidNewException', () => {
  it('accepts any one subject', () => {
    assertValidNewException(exception)
    assertValidNewException({ tenantId: 't', code: 'OVERPAYMENT', movementId: 'm', detail: 'x' })
    assertValidNewException({ tenantId: 't', code: 'LATE_BEYOND_WINDOW', expectationId: 'e', detail: 'x' })
  })

  it.each<[Partial<Record<keyof NewException, unknown>>, string]>([
    [{ code: 'SOMETHING_ELSE' }, 'code'],
    [{ account: null }, 'subject'],
    [{ account: 'GBAD' }, 'account'],
    [{ detail: '' }, 'detail'],
    [{ detail: 'x'.repeat(2_001) }, 'detail'],
  ])('rejects %o', (over, field) => {
    rejects(() => assertValidNewException({ ...exception, ...over } as NewException), field)
  })
})
