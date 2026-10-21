import { describe, expect, it } from 'vitest'
import type {
  Allocation,
  ExceptionCode,
  ExceptionRecord,
  JournalEntry,
  Movement,
  NewJournalEntry,
} from '../src/index.js'
import {
  ConstraintError,
  DEFAULT_CHART,
  Money,
  NATIVE,
  ValidationError,
  asset,
  assertValidNewJournalEntry,
  checkJournalEntry,
  desiredLines,
  planPosting,
} from '../src/index.js'

const ACCOUNT = `G${'A'.repeat(55)}`
const ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
const USDC = asset('USDC', ISSUER)
const usdc = (v: string) => Money.parse(v, USDC)
const CASH = `assets:stellar:testnet:${ACCOUNT}`
const OCCURRED = new Date('2026-10-05T12:00:00Z')

function movement(over: Partial<Movement> = {}): Movement {
  return {
    id: 'm1',
    tenantId: 't',
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
  }
}

const allocation = (expectationId: string, amount: Money): Allocation => ({
  id: `a-${expectationId}`,
  tenantId: 't',
  movementId: 'm1',
  expectationId,
  amount,
  strategy: 'memo_text',
  score: 0.85,
  createdAt: OCCURRED,
})

let ex = 0
const exception = (code: ExceptionCode, amount: Money | null = null): ExceptionRecord => ({
  id: `x${++ex}`,
  tenantId: 't',
  seq: ex,
  code,
  status: 'open',
  movementId: 'm1',
  expectationId: null,
  account: ACCOUNT,
  amount,
  detail: code,
  evidence: null,
  openedAt: OCCURRED,
  resolvedAt: null,
  resolutionNote: null,
})

/** Turn a planned entry into a posted one, as a store would. */
function posted(entries: readonly JournalEntry[], n: NewJournalEntry): JournalEntry[] {
  return [
    ...entries,
    {
      id: `j${entries.length + 1}`,
      tenantId: n.tenantId,
      seq: entries.length + 1,
      movementId: n.movementId ?? null,
      postingNo: n.postingNo ?? null,
      kind: n.kind,
      effectiveAt: n.effectiveAt ?? new Date('2026-10-12T00:00:00Z'),
      postedAt: new Date('2026-10-12T00:00:00Z'),
      description: n.description,
      lines: n.lines.map((l) => ({ ...l, expectationId: l.expectationId ?? null, exceptionId: l.exceptionId ?? null })),
    },
  ]
}

/** Lines as compact tuples: [side, account, amount, expectationId]. */
const tuples = (n: NewJournalEntry | null) =>
  n === null ? null : n.lines.map((l) => [l.side, l.account, l.amount.toString(), l.expectationId ?? null])

describe('desiredLines and planPosting: one row per matching outcome', () => {
  it('posts nothing for a pending movement', () => {
    const m = movement({ disposition: 'pending' })
    expect(desiredLines(m, [], [])).toBeNull()
    expect(planPosting(m, [], [], [])).toBeNull()
  })

  it('debits cash and credits receivable for a payment applied to an invoice', () => {
    const plan = planPosting(movement(), [allocation('e1', usdc('10'))], [], [])
    expect(plan).toMatchObject({ kind: 'initial', postingNo: 1, movementId: 'm1', effectiveAt: OCCURRED })
    expect(tuples(plan)).toEqual([
      ['debit', CASH, '10.0000000', null],
      ['credit', 'assets:receivable', '10.0000000', 'e1'],
    ])
    expect(plan!.description).toBe('Received 10.0000000 USDC')
  })

  it('splits one payment across two invoices', () => {
    const plan = planPosting(movement({ amount: usdc('30') }), [allocation('e1', usdc('10')), allocation('e2', usdc('20'))], [], [])
    expect(tuples(plan)).toEqual([
      ['debit', CASH, '30.0000000', null],
      ['credit', 'assets:receivable', '10.0000000', 'e1'],
      ['credit', 'assets:receivable', '20.0000000', 'e2'],
    ])
  })

  it('holds an overpayment as credit owed back to the customer', () => {
    const over = exception('OVERPAYMENT', usdc('5'))
    const plan = planPosting(movement({ amount: usdc('15'), disposition: 'partial' }), [allocation('e1', usdc('10'))], [over], [])
    expect(tuples(plan)).toEqual([
      ['debit', CASH, '15.0000000', null],
      ['credit', 'assets:receivable', '10.0000000', 'e1'],
      ['credit', 'liabilities:customer-credit', '5.0000000', null],
    ])
    expect(plan!.lines[2]!.exceptionId).toBe(over.id)
  })

  it('holds a duplicate payment as credit owed back to the customer', () => {
    const plan = planPosting(movement({ disposition: 'exception' }), [], [exception('DUPLICATE_PAYMENT')], [])
    expect(tuples(plan)![1]).toEqual(['credit', 'liabilities:customer-credit', '10.0000000', null])
  })

  it.each<ExceptionCode>(['AMBIGUOUS_MATCH', 'WRONG_ASSET', 'MEMO_MISSING', 'UNEXPECTED_CREDIT', 'LATE_BEYOND_WINDOW'])(
    'holds an unexplained receipt (%s) as unapplied',
    (code) => {
      const plan = planPosting(movement({ disposition: 'exception' }), [], [exception(code)], [])
      expect(tuples(plan)![1]).toEqual(['credit', 'liabilities:unapplied-receipts', '10.0000000', null])
    },
  )

  it('puts unexplained money out into a suspense asset, not a liability', () => {
    const plan = planPosting(movement({ direction: 'debit', disposition: 'exception' }), [], [exception('UNEXPECTED_DEBIT')], [])
    expect(tuples(plan)).toEqual([
      ['credit', CASH, '10.0000000', null],
      ['debit', 'assets:suspense', '10.0000000', null],
    ])
  })

  it('applies an outgoing payment to a payout', () => {
    const plan = planPosting(movement({ direction: 'debit' }), [allocation('p1', usdc('10'))], [], [])
    expect(tuples(plan)).toEqual([
      ['credit', CASH, '10.0000000', null],
      ['debit', 'liabilities:payable', '10.0000000', 'p1'],
    ])
  })

  it('expenses a network fee', () => {
    const fee = movement({ kind: 'fee', direction: 'debit', amount: Money.fromRaw(100n, NATIVE), disposition: 'ignored', ignoredReason: 'fee' })
    const plan = planPosting(fee, [], [], [])
    expect(tuples(plan)).toEqual([
      ['credit', CASH, '0.0000100', null],
      ['debit', 'expenses:network-fees', '0.0000100', null],
    ])
    expect(plan!.description).toBe('Network fee 0.0000100 XLM')
  })

  it('posts ignored movements to uncategorized income or expense', () => {
    const ignored = { disposition: 'ignored' as const, ignoredReason: 'spam airdrop' }
    expect(tuples(planPosting(movement(ignored), [], [], []))![1]).toEqual(['credit', 'income:uncategorized', '10.0000000', null])
    expect(tuples(planPosting(movement({ ...ignored, direction: 'debit' }), [], [], []))![1]).toEqual([
      'debit',
      'expenses:uncategorized',
      '10.0000000',
      null,
    ])
  })

  it("uses the issued-supply liability, not cash, for an issuer's own asset", () => {
    const issuer = movement({ account: ISSUER, disposition: 'exception' })
    const plan = planPosting(issuer, [], [exception('UNEXPECTED_CREDIT')], [])
    expect(plan!.lines.map((l) => [l.role, l.side, l.account])).toEqual([
      ['issued', 'debit', 'liabilities:issued'],
      ['unapplied', 'credit', 'liabilities:unapplied-receipts'],
    ])
  })

  it('takes leftovers from allocations, never from an exception amount', () => {
    const plan = planPosting(
      movement({ amount: usdc('15'), disposition: 'partial' }),
      [allocation('e1', usdc('10'))],
      [exception('OVERPAYMENT', usdc('99'))],
      [],
    )
    expect(plan!.lines[2]!.amount.toString()).toBe('5.0000000')
  })
})

describe('planPosting: later changes are adjustments', () => {
  const unapplied = () => {
    const amb = exception('AMBIGUOUS_MATCH')
    const m = movement({ disposition: 'exception' })
    return { m, amb, entries: posted([], planPosting(m, [], [amb], [])!) }
  }

  it('reclassifies a resolved exception without touching cash', () => {
    const { amb, entries } = unapplied()
    const plan = planPosting(movement(), [allocation('e1', usdc('10'))], [amb], entries)
    expect(plan).toMatchObject({ kind: 'reclass', postingNo: 2 })
    expect(plan!.effectiveAt).toBeUndefined() // dated by the store's clock
    expect(tuples(plan)).toEqual([
      ['credit', 'assets:receivable', '10.0000000', 'e1'],
      ['debit', 'liabilities:unapplied-receipts', '10.0000000', null],
    ])
    expect(plan!.description).toBe('Reclassified: Received 10.0000000 USDC')
  })

  it('posts nothing when the books already say the right thing', () => {
    const { m, amb, entries } = unapplied()
    expect(planPosting(m, [], [amb], entries)).toBeNull()
  })

  it('does not churn when a new exception keeps the same role', () => {
    const { m, amb, entries } = unapplied()
    expect(planPosting(m, [], [amb, exception('MEMO_MISSING')], entries)).toBeNull()
  })

  it('does not churn when the chart changes', () => {
    const { m, amb, entries } = unapplied()
    const chart = { ...DEFAULT_CHART, unapplied: 'liabilities:holding', cash: () => 'assets:bank' }
    expect(planPosting(m, [], [amb], entries, { chart })).toBeNull()
  })

  it('clears a balance from the account it was posted to, even after a chart change', () => {
    const { amb, entries } = unapplied()
    const chart = { ...DEFAULT_CHART, unapplied: 'liabilities:holding', receivable: 'assets:ar' }
    expect(tuples(planPosting(movement(), [allocation('e1', usdc('10'))], [amb], entries, { chart }))).toEqual([
      ['credit', 'assets:ar', '10.0000000', 'e1'],
      ['debit', 'liabilities:unapplied-receipts', '10.0000000', null],
    ])
  })

  it('moves an overpayment from unapplied to customer credit when the exception says so', () => {
    const { amb, entries } = unapplied()
    const plan = planPosting(movement({ disposition: 'exception' }), [], [amb, exception('DUPLICATE_PAYMENT')], entries)
    expect(plan!.kind).toBe('reclass')
    expect(plan!.lines.map((l) => [l.side, l.role])).toEqual([
      ['credit', 'customer_credit'],
      ['debit', 'unapplied'],
    ])
  })

  it('dates a change to the cash leg like the original entry', () => {
    const m = movement({ disposition: 'exception' })
    const wrong = posted([], {
      tenantId: 't',
      movementId: 'm1',
      postingNo: 1,
      kind: 'initial',
      effectiveAt: OCCURRED,
      description: 'x',
      lines: [
        { account: CASH, role: 'cash', side: 'debit', amount: usdc('4') },
        { account: 'liabilities:unapplied-receipts', role: 'unapplied', side: 'credit', amount: usdc('4') },
      ],
    })
    const plan = planPosting(m, [], [exception('MEMO_MISSING')], wrong)
    expect(plan).toMatchObject({ kind: 'correction', effectiveAt: OCCURRED })
  })
})

describe('checkJournalEntry', () => {
  const entry = (over: Partial<NewJournalEntry> = {}): NewJournalEntry => ({
    tenantId: 't',
    movementId: 'm1',
    postingNo: 1,
    kind: 'initial',
    description: 'x',
    lines: [
      { account: CASH, role: 'cash', side: 'debit', amount: usdc('10') },
      { account: 'assets:receivable', role: 'receivable', side: 'credit', amount: usdc('10') },
    ],
    ...over,
  })
  const constraint = (fn: () => void) => {
    try {
      fn()
    } catch (e) {
      return e instanceof ConstraintError ? e.constraint : `not a constraint: ${String(e)}`
    }
    return 'accepted'
  }

  it('accepts a balanced entry for its movement', () => {
    expect(constraint(() => checkJournalEntry(entry(), movement(), []))).toBe('accepted')
  })

  it('balances each asset on its own, not the total across assets', () => {
    const lines = [
      { account: CASH, role: 'cash' as const, side: 'debit' as const, amount: usdc('10') },
      { account: 'x', role: 'unapplied' as const, side: 'credit' as const, amount: Money.parse('10', NATIVE) },
    ]
    expect(constraint(() => checkJournalEntry(entry({ lines, movementId: null, postingNo: null }), null, []))).toBe(
      'journal_unbalanced',
    )
  })

  it('appends only at the next posting number', () => {
    expect(constraint(() => checkJournalEntry(entry({ postingNo: 2 }), movement(), []))).toBe('journal_posting_conflict')
  })

  it('keeps lines in the movement asset', () => {
    const xlm = Money.parse('1', NATIVE)
    const lines = [
      { account: CASH, role: 'cash' as const, side: 'debit' as const, amount: xlm },
      { account: 'x', role: 'unapplied' as const, side: 'credit' as const, amount: xlm },
    ]
    expect(constraint(() => checkJournalEntry(entry({ lines }), movement(), []))).toBe('journal_asset')
  })

  it('never lets cash net to anything but zero or the movement amount', () => {
    const first = posted([], entry())
    expect(constraint(() => checkJournalEntry(entry({ postingNo: 2 }), movement(), first))).toBe('journal_cash_mismatch')
    const reverse = entry({
      postingNo: 2,
      kind: 'correction',
      lines: entry().lines.map((l) => ({ ...l, side: l.side === 'debit' ? ('credit' as const) : ('debit' as const) })),
    })
    expect(constraint(() => checkJournalEntry(reverse, movement(), first))).toBe('accepted')
  })
})

describe('assertValidNewJournalEntry', () => {
  const base: NewJournalEntry = {
    tenantId: 't',
    kind: 'initial',
    description: 'x',
    lines: [
      { account: 'a', role: 'cash', side: 'debit', amount: usdc('1') },
      { account: 'b', role: 'unapplied', side: 'credit', amount: usdc('1') },
    ],
  }
  const field = (over: Partial<Record<keyof NewJournalEntry, unknown>>) => {
    try {
      assertValidNewJournalEntry({ ...base, ...over } as NewJournalEntry)
    } catch (e) {
      return e instanceof ValidationError ? e.field : String(e)
    }
    return 'valid'
  }

  it('accepts a manual entry and one tied to a movement', () => {
    expect(field({})).toBe('valid')
    expect(field({ movementId: 'm', postingNo: 3, effectiveAt: new Date() })).toBe('valid')
  })

  it.each<[Partial<Record<keyof NewJournalEntry, unknown>>, string]>([
    [{ lines: [base.lines[0]] }, 'lines'],
    [{ kind: 'other' }, 'kind'],
    [{ description: '' }, 'description'],
    [{ movementId: 'm' }, 'postingNo'],
    [{ postingNo: 1 }, 'postingNo'],
    [{ movementId: 'm', postingNo: 0 }, 'postingNo'],
    [{ effectiveAt: new Date('x') }, 'effectiveAt'],
    [{ lines: [{ ...base.lines[0]!, role: 'bank' }, base.lines[1]] }, 'lines[0].role'],
    [{ lines: [{ ...base.lines[0]!, side: 'left' }, base.lines[1]] }, 'lines[0].side'],
    [{ lines: [{ ...base.lines[0]!, amount: usdc('0') }, base.lines[1]] }, 'lines[0].amount'],
    [{ lines: [base.lines[0], { ...base.lines[1]!, amount: Money.parse('1', USDC, 6) }] }, 'lines[1].amount'],
    [{ lines: [{ ...base.lines[0]!, account: '' }, base.lines[1]] }, 'lines[0].account'],
  ])('rejects %o', (over, want) => {
    expect(field(over)).toBe(want)
  })
})
