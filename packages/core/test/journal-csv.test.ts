import { describe, expect, it } from 'vitest'
import type { NewMovement } from '../src/index.js'
import { DEFAULT_CHART, JOURNAL_CSV_COLUMNS, MemoryStore, Money, asset, journalCsv, reconcile } from '../src/index.js'

const T = 'acme'
const ACCOUNT = `G${'A'.repeat(55)}`
const ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
const USDC = asset('USDC', ISSUER)
const usdc = (v: string) => Money.parse(v, USDC)
const HASH = 'ab'.repeat(32)

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
    txHash: HASH,
    occurredAt: new Date('2026-10-05T12:00:00Z'),
    ...over,
  }
}

/** A minimal RFC 4180 parser, so the tests check what a spreadsheet would read. */
function parse(csv: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i]!
    if (quoted) {
      if (c === '"' && csv[i + 1] === '"') {
        cell += '"'
        i++
      } else if (c === '"') quoted = false
      else cell += c
    } else if (c === '"') quoted = true
    else if (c === ',') {
      row.push(cell)
      cell = ''
    } else if (c === '\r' && csv[i + 1] === '\n') {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
      i++
    } else cell += c
  }
  return rows
}

const records = (csv: string) => {
  const [header, ...rows] = parse(csv)
  return rows.map((r) => Object.fromEntries(header!.map((h, i) => [h, r[i]!])))
}

describe('journalCsv', () => {
  it('writes only the header for an empty journal', async () => {
    const csv = await journalCsv({ store: new MemoryStore(), tenantId: T })
    expect(csv).toBe(`${JOURNAL_CSV_COLUMNS.join(',')}\r\n`)
  })

  it('writes one row per line, with exact amounts and the context to reconcile it', async () => {
    const store = new MemoryStore()
    const invoice = await store.transaction((tx) =>
      tx.insertExpectation({ tenantId: T, reference: 'INV-2', account: ACCOUNT, amount: usdc('25') }),
    )
    await store.transaction((tx) => tx.insertMovements([payment({ amount: usdc('30'), memo: { type: 'text', value: 'INV-2' } })]))
    await reconcile({ store, tenantId: T })
    const [over] = await store.listExceptions({ tenantId: T })

    const rows = records(await journalCsv({ store, tenantId: T }))
    expect(rows.map((r) => [r.line_no, r.role, r.debit, r.credit, r.expectation_reference, r.exception_code])).toEqual([
      ['1', 'cash', '30.0000000', '', '', ''],
      ['2', 'receivable', '', '25.0000000', 'INV-2', ''],
      ['3', 'customer_credit', '', '5.0000000', '', 'OVERPAYMENT'],
    ])
    expect(rows[0]).toMatchObject({
      kind: 'initial',
      effective_at: '2026-10-05T12:00:00.000Z',
      description: 'Received 30.0000000 USDC',
      account: `assets:stellar:testnet:${ACCOUNT}`,
      asset: USDC,
      tx_hash: HASH,
    })
    expect(rows[2]!.exception_id).toBe(over!.id)
    expect(invoice.reference).toBe('INV-2')
  })

  it('quotes commas, quotes and line breaks so the file round-trips', async () => {
    const store = new MemoryStore()
    await store.transaction((tx) => tx.insertMovements([payment()]))
    const chart = { ...DEFAULT_CHART, unapplied: 'Liabilities:"Unapplied", held\r\nfor review' }
    await reconcile({ store, tenantId: T, chart })
    const csv = await journalCsv({ store, tenantId: T })
    expect(csv).toContain('"Liabilities:""Unapplied"", held\r\nfor review"')
    expect(records(csv)[1]!.account).toBe('Liabilities:"Unapplied", held\r\nfor review')
  })

  it('stops a spreadsheet from treating user text as a formula', async () => {
    const store = new MemoryStore()
    await store.transaction((tx) =>
      tx.insertExpectation({ tenantId: T, reference: '=HYPERLINK("http://x","pay")', account: ACCOUNT, amount: usdc('10') }),
    )
    await store.transaction((tx) => tx.insertMovements([payment({ memo: { type: 'text', value: '=HYPERLINK("http://x","pay")' } })]))
    await reconcile({ store, tenantId: T, chart: { ...DEFAULT_CHART, receivable: '@SUM(A1)' } })
    const [, receivable] = records(await journalCsv({ store, tenantId: T }))
    expect(receivable!.expectation_reference).toBe(`'=HYPERLINK("http://x","pay")`)
    expect(receivable!.account).toBe(`'@SUM(A1)`)
  })

  it('keeps an 18-decimal amount above 2^64 exact', async () => {
    const store = new MemoryStore()
    const token = Money.fromRaw(2n ** 70n + 1n, USDC, 18)
    await store.transaction((tx) => tx.insertMovements([payment({ amount: token })]))
    await reconcile({ store, tenantId: T })
    const [cash] = records(await journalCsv({ store, tenantId: T }))
    expect(cash!.debit).toBe('1180.591620717411303425')
    expect(cash!.debit).toBe(token.toString())
  })

  it('exports a date range by effective date, across pages', async () => {
    const store = new MemoryStore()
    await store.transaction((tx) =>
      tx.insertMovements([
        payment({ occurredAt: new Date('2026-09-30T23:59:59Z') }),
        payment({ occurredAt: new Date('2026-10-01T00:00:00Z') }),
        payment({ occurredAt: new Date('2026-10-15T00:00:00Z') }),
        payment({ occurredAt: new Date('2026-11-01T00:00:00Z') }),
      ]),
    )
    await reconcile({ store, tenantId: T })
    const october = records(
      await journalCsv({ store, tenantId: T, from: new Date('2026-10-01T00:00:00Z'), to: new Date('2026-11-01T00:00:00Z'), pageSize: 1 }),
    )
    expect([...new Set(october.map((r) => r.effective_at))]).toEqual(['2026-10-01T00:00:00.000Z', '2026-10-15T00:00:00.000Z'])
    expect(october).toHaveLength(4)
  })

  it('ends every row with CRLF', async () => {
    const store = new MemoryStore()
    await store.transaction((tx) => tx.insertMovements([payment()]))
    await reconcile({ store, tenantId: T })
    const csv = await journalCsv({ store, tenantId: T })
    expect(csv.split('\r\n')).toHaveLength(4) // header, two lines, trailing empty
    expect(csv.replaceAll('\r\n', '')).not.toMatch(/\n/)
  })
})
