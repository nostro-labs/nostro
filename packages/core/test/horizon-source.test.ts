import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { HorizonEffect, HorizonOperation, HorizonTransaction } from '../src/index.js'
import { HorizonClient, HorizonEffectsSource, HorizonFeesSource, MemoryStore, sync } from '../src/index.js'

const A = `G${'A'.repeat(55)}`
const B = `G${'B'.repeat(55)}`
const T = 'tenant'

const toid = (ledger: number, op: number) => ((BigInt(ledger) << 32n) | (1n << 12n) | BigInt(op)).toString()
const hash = (n: number) => n.toString(16).padStart(64, '0')

/** Order Horizon paging tokens: `<toid>-<order>`, or a bare toid meaning "after all of it". */
function position(token: string): [bigint, number] {
  const [op, order] = token.split('-')
  return [BigInt(op!), order === undefined ? Number.POSITIVE_INFINITY : Number(order)]
}
const after = (a: string, b: string) => {
  const [ao, an] = position(a)
  const [bo, bn] = position(b)
  return ao > bo || (ao === bo && an > bn)
}

/** An in-memory Horizon with the real paging semantics: strictly-after cursors, asc/desc, 404s. */
class FakeHorizon {
  effects: HorizonEffect[] = []
  operations = new Map<string, HorizonOperation>()
  /** Which accounts' operations feed lists each operation. */
  participants = new Map<string, Set<string>>()
  transactions: (HorizonTransaction & { participants: string[] })[] = []
  gone = new Set<string>()
  requests: URL[] = []

  readonly fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input))
    this.requests.push(url)
    const q = url.searchParams
    const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
    const notFound = () => respond({ type: 'https://stellar.org/horizon-errors/not_found', status: 404 }, 404)
    const page = <R extends { paging_token: string }>(all: R[]) => {
      const desc = q.get('order') === 'desc'
      const cursor = q.get('cursor')
      let rows = [...all].sort((x, y) => (after(x.paging_token, y.paging_token) ? 1 : -1))
      if (desc) rows.reverse()
      if (cursor !== null) rows = rows.filter((r) => (desc ? after(cursor, r.paging_token) : after(r.paging_token, cursor)))
      return respond({ _embedded: { records: rows.slice(0, Number(q.get('limit') ?? 10)) } })
    }
    const known = (account: string) =>
      this.effects.some((e) => e.account === account) || this.transactions.some((t) => t.participants.includes(account))

    let m: RegExpMatchArray | null
    if ((m = url.pathname.match(/^\/accounts\/(\w+)\/effects$/))) {
      return known(m[1]!) ? page(this.effects.filter((e) => e.account === m![1])) : notFound()
    }
    if ((m = url.pathname.match(/^\/accounts\/(\w+)\/operations$/))) {
      expect(q.get('join')).toBe('transactions')
      return page([...this.operations.values()].filter((o) => this.participants.get(o.id)?.has(m![1]!)))
    }
    if ((m = url.pathname.match(/^\/operations\/(\d+)$/))) {
      const op = this.operations.get(m[1]!)
      return op === undefined || this.gone.has(op.id) ? notFound() : respond(op)
    }
    if ((m = url.pathname.match(/^\/accounts\/(\w+)\/transactions$/))) {
      if (!known(m[1]!)) return notFound()
      const failed = q.get('include_failed') === 'true'
      return page(this.transactions.filter((t) => t.participants.includes(m![1]!) && (failed || t.successful)))
    }
    throw new Error(`unrouted ${url.pathname}`)
  }) as typeof globalThis.fetch

  client(): HorizonClient {
    return new HorizonClient({ url: 'https://horizon.test', fetch: this.fetch, retries: 0 })
  }

  /** Add a payment from `from` to `to` in `ledger`, with `extra` non-value effects on `to`. */
  payment(ledger: number, from: string, to: string, amount: string, { listed = true, extra = 0 } = {}): string {
    const id = toid(ledger, 1)
    const tx: HorizonTransaction = {
      hash: hash(ledger),
      paging_token: (BigInt(id) - 1n).toString(),
      ledger,
      created_at: '2026-10-06T00:00:00Z',
      successful: true,
      source_account: from,
      fee_account: from,
      fee_charged: '100',
      memo_type: 'text',
      memo: `INV-${ledger}`,
    }
    this.operations.set(id, {
      id,
      paging_token: id,
      type: 'payment',
      source_account: from,
      transaction_hash: tx.hash,
      transaction: tx,
      from,
      to,
    })
    this.participants.set(id, new Set(listed ? [from, to] : [from]))
    const effect = (order: number, account: string, type: string, rest: Partial<HorizonEffect> = {}): HorizonEffect => ({
      id: `${id.padStart(19, '0')}-${String(order).padStart(10, '0')}`,
      paging_token: `${id}-${order}`,
      account,
      type,
      created_at: tx.created_at,
      ...rest,
    })
    this.effects.push(effect(1, to, 'account_credited', { asset_type: 'native', amount }))
    for (let i = 0; i < extra; i++) this.effects.push(effect(2 + i, to, 'signer_created'))
    this.effects.push(effect(2 + extra, from, 'account_debited', { asset_type: 'native', amount }))
    this.transactions.push({ ...tx, participants: [from, to] })
    return id
  }
}

const effects = (h: FakeHorizon, options: Partial<ConstructorParameters<typeof HorizonEffectsSource>[0]> = {}) =>
  new HorizonEffectsSource({ client: h.client(), network: 'testnet', ...options })
const pull = (source: HorizonEffectsSource | HorizonFeesSource, cursor: string | null, limit = 10, account = A) =>
  source.pull({ tenantId: T, account, cursor, limit })

describe('HorizonEffectsSource', () => {
  it('cuts pages on operation boundaries and loses nothing', async () => {
    const h = new FakeHorizon()
    h.payment(10, B, A, '1', { extra: 1 }) // 2 effects on A
    h.payment(11, B, A, '2', { extra: 2 }) // 3 effects on A
    h.payment(12, B, A, '3', { extra: 1 })
    const source = effects(h)

    const first = await pull(source, null, 4)
    expect(first.movements.map((m) => m.amount.toString())).toEqual(['1.0000000'])
    expect(first).toMatchObject({ cursor: `${toid(10, 1)}-2`, caughtUp: false })
    const second = await pull(source, first.cursor, 4)
    expect(second.movements.map((m) => m.amount.toString())).toEqual(['2.0000000'])
    expect(second.cursor).toBe(`${toid(11, 1)}-3`)
    const third = await pull(source, second.cursor, 4)
    expect(third.movements.map((m) => m.amount.toString())).toEqual(['3.0000000'])
    expect(third.caughtUp).toBe(true)
  })

  it('reads on through an operation larger than a page', async () => {
    const h = new FakeHorizon()
    h.payment(10, B, A, '1', { extra: 4 }) // 5 effects on A in one operation
    h.payment(11, B, A, '2')
    const result = await pull(effects(h), null, 2)
    expect(result.movements).toHaveLength(1)
    expect(result.cursor).toBe(`${toid(10, 1)}-5`)
    expect(result.caughtUp).toBe(false)
  })

  it('fails loudly rather than split an operation it cannot finish reading', async () => {
    const h = new FakeHorizon()
    h.payment(10, B, A, '1', { extra: 6 })
    await expect(pull(effects(h, { maxPagesPerOperation: 1 }), null, 2)).rejects.toThrow(/more than 2 effects/)
  })

  it("enriches from the account's operations feed without per-operation lookups", async () => {
    const h = new FakeHorizon()
    h.payment(10, B, A, '1')
    h.payment(11, B, A, '2')
    const result = await pull(effects(h), null)
    expect(result.movements.map((m) => [m.enrichment, m.memo, m.counterparty])).toEqual([
      ['complete', { type: 'text', value: 'INV-10' }, B],
      ['complete', { type: 'text', value: 'INV-11' }, B],
    ])
    expect(h.requests.map((u) => u.pathname)).toEqual([`/accounts/${A}/effects`, `/accounts/${A}/operations`])
  })

  it('looks up operations the account feed does not list, such as a crossed maker trade', async () => {
    const dir = new URL('../../../fixtures/horizon/pubnet/', import.meta.url)
    const f = JSON.parse(readFileSync(fileURLToPath(new URL('manage-offer-crossed.json', dir)), 'utf8')) as {
      operation: HorizonOperation
      effects: HorizonEffect[]
    }
    const maker = f.effects[1]!.account
    const h = new FakeHorizon()
    h.effects = f.effects
    h.operations.set(f.operation.id, f.operation)
    h.participants.set(f.operation.id, new Set([f.operation.source_account])) // makers are not participants
    const result = await pull(effects(h), null, 10, maker)
    expect(result.movements).toHaveLength(2)
    expect(result.movements.every((m) => m.enrichment === 'complete' && m.txHash === f.operation.transaction_hash)).toBe(true)
    expect(h.requests.some((u) => u.pathname === `/operations/${f.operation.id}`)).toBe(true)
  })

  it('ends the batch early when the lookup budget runs out, and the next pull carries on', async () => {
    const h = new FakeHorizon()
    for (const ledger of [10, 11, 12]) h.payment(ledger, B, A, String(ledger), { listed: false })
    const source = effects(h, { lookupBudget: 1 })
    const first = await pull(source, null)
    expect(first.movements.map((m) => m.amount.toString())).toEqual(['10.0000000'])
    expect(first).toMatchObject({ caughtUp: false, cursor: `${toid(10, 1)}-1` })

    const store = new MemoryStore()
    const report = await sync({ store, source, tenantId: T, accounts: [A] })
    expect(report.accounts[0]).toMatchObject({ inserted: 3, caughtUp: true, error: null })
    const recorded = await store.listMovements({ tenantId: T })
    expect(recorded.every((m) => m.enrichment === 'complete')).toBe(true)
  })

  it('records a movement with enrichment missing when Horizon no longer has the operation', async () => {
    const h = new FakeHorizon()
    const id = h.payment(10, B, A, '1', { listed: false })
    h.gone.add(id)
    const [movement] = (await pull(effects(h), null)).movements
    expect(movement).toMatchObject({ enrichment: 'missing', txHash: null, memo: null, ledger: 10 })
  })

  it('treats an account Horizon has never seen as having no history yet', async () => {
    const result = await pull(effects(new FakeHorizon()), null)
    expect(result).toEqual({ movements: [], cursor: '0', caughtUp: true })
  })

  it('with start "latest", pins the newest record and reads only what comes after', async () => {
    const h = new FakeHorizon()
    h.payment(10, B, A, '1')
    h.payment(11, B, A, '2')
    const store = new MemoryStore()
    const source = effects(h, { start: 'latest' })
    await sync({ store, source, tenantId: T, accounts: [A] })
    expect(await store.listMovements({ tenantId: T })).toHaveLength(0)
    h.payment(12, B, A, '3')
    await sync({ store, source, tenantId: T, accounts: [A] })
    expect((await store.listMovements({ tenantId: T })).map((m) => m.amount.toString())).toEqual(['3.0000000'])
  })

  it('with start "latest", still reads the first records of an account that had none', async () => {
    const h = new FakeHorizon()
    const store = new MemoryStore()
    const source = effects(h, { start: 'latest' })
    await sync({ store, source, tenantId: T, accounts: [A] })
    h.payment(10, B, A, '1')
    await sync({ store, source, tenantId: T, accounts: [A] })
    expect(await store.listMovements({ tenantId: T })).toHaveLength(1)
  })
})

describe('HorizonFeesSource', () => {
  it('charges the account for the fees it paid, including on failed transactions', async () => {
    const h = new FakeHorizon()
    h.payment(10, A, B, '1') // A pays the fee
    h.payment(11, B, A, '1') // B pays the fee
    h.transactions.push({ ...h.transactions[0]!, hash: hash(99), paging_token: toid(12, 0), ledger: 12, successful: false, fee_charged: '250' })
    const source = new HorizonFeesSource({ client: h.client(), network: 'testnet' })
    const result = await pull(source, null)
    expect(result.movements.map((m) => [m.kind, m.direction, m.amount.raw])).toEqual([
      ['fee', 'debit', 100n],
      ['fee', 'debit', 250n],
    ])
    expect(h.requests.every((u) => u.searchParams.get('include_failed') === 'true')).toBe(true)
    expect(result.caughtUp).toBe(true)
  })

  it('syncs alongside effects without duplicates on a second run', async () => {
    const h = new FakeHorizon()
    h.payment(10, A, B, '5')
    h.payment(11, B, A, '7')
    const store = new MemoryStore()
    const sources = [effects(h), new HorizonFeesSource({ client: h.client(), network: 'testnet' })]
    for (const source of sources) await sync({ store, source, tenantId: T, accounts: [A] })
    const first = await store.listMovements({ tenantId: T })
    expect(first.map((m) => `${m.source}:${m.kind}:${m.direction}:${m.amount.toString()}`).sort()).toEqual([
      'horizon-fees:fee:debit:0.0000100',
      'horizon:transfer:credit:7.0000000',
      'horizon:transfer:debit:5.0000000',
    ])
    for (const source of sources) {
      const again = await sync({ store, source, tenantId: T, accounts: [A] })
      expect(again.inserted).toBe(0)
    }
  })
})
