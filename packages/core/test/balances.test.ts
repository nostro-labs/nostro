import { describe, expect, it } from 'vitest'
import { FakeHorizon } from 'nostro-testkit'
import type { BalanceSnapshot, BalanceSource, Movement, MovementSource, NewMovement, PullRequest } from '../src/index.js'
import {
  HorizonBalanceSource,
  HorizonClient,
  HorizonEffectsSource,
  HorizonFeesSource,
  MemoryStore,
  Money,
  NATIVE,
  asset,
  attestBalances,
  compareBalances,
  doctor,
} from '../src/index.js'

const T = 'acme'
const A = `G${'A'.repeat(55)}`
const B = `G${'B'.repeat(55)}`
const ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
const USDC = asset('USDC', ISSUER)
const xlm = (v: string) => Money.parse(v, NATIVE)
const usdc = (v: string) => Money.parse(v, USDC)

let n = 0
function fact(ledger: number, amount: Money, direction: 'credit' | 'debit' = 'credit', account = A): NewMovement {
  n += 1
  return {
    tenantId: T,
    network: 'testnet',
    source: 'fake',
    externalId: `fact-${n}`,
    account,
    direction,
    kind: 'transfer',
    amount,
    ledger,
    occurredAt: new Date('2026-10-14T00:00:00Z'),
  }
}

/** Recorded movements, as compareBalances() receives them. */
const recorded = (...facts: NewMovement[]): Movement[] =>
  facts.map((f, i) => ({
    ...f,
    id: `m${i}`,
    seq: i + 1,
    revision: 1,
    counterparty: null,
    muxedId: null,
    memo: null,
    txHash: null,
    operationId: null,
    enrichment: 'complete',
    disposition: 'pending',
    ignoredReason: null,
    createdAt: f.occurredAt,
  }))

const statuses = (checks: ReturnType<typeof compareBalances>) =>
  checks.map((c) => [c.asset, c.status, c.chain.toString(), c.recorded.toString(), c.ledger])

describe('compareBalances', () => {
  const snapshot = (balances: BalanceSnapshot['balances'], ledger: number | null = 50): BalanceSnapshot => ({
    account: A,
    ledger,
    balances,
  })

  it('counts movements up to and including the ledger each balance last changed in', () => {
    const checks = compareBalances(
      snapshot([{ amount: xlm('15'), lastModifiedLedger: 20 }]),
      recorded(fact(10, xlm('10')), fact(20, xlm('5')), fact(21, xlm('99'))),
    )
    expect(statuses(checks)).toEqual([[NATIVE, 'match', '15.0000000', '15.0000000', 20]])
  })

  it('reports a mismatch when something is missing', () => {
    const checks = compareBalances(snapshot([{ amount: xlm('15'), lastModifiedLedger: 20 }]), recorded(fact(10, xlm('10'))))
    expect(statuses(checks)).toEqual([[NATIVE, 'mismatch', '15.0000000', '10.0000000', 20]])
  })

  it('pins each asset at its own ledger', () => {
    const checks = compareBalances(
      snapshot([
        { amount: xlm('4'), lastModifiedLedger: 30 },
        { amount: usdc('7'), lastModifiedLedger: 12 },
      ]),
      recorded(fact(11, usdc('7')), fact(25, usdc('1')), fact(29, xlm('5')), fact(30, xlm('1'), 'debit')),
    )
    expect(statuses(checks)).toEqual([
      [NATIVE, 'match', '4.0000000', '4.0000000', 30],
      [USDC, 'match', '7.0000000', '7.0000000', 12],
    ])
  })

  it('expects zero, as of the snapshot, in an asset the chain shows no balance in', () => {
    const emptied = compareBalances(snapshot([]), recorded(fact(10, usdc('3')), fact(40, usdc('3'), 'debit'), fact(51, usdc('8'))))
    expect(statuses(emptied)).toEqual([[USDC, 'match', '0.0000000', '0.0000000', 50]])
    const left = compareBalances(snapshot([]), recorded(fact(10, usdc('3'))))
    expect(statuses(left)).toEqual([[USDC, 'mismatch', '0.0000000', '3.0000000', 50]])
    const gone = compareBalances(snapshot([], null), recorded(fact(10, usdc('3')), fact(99, usdc('3'), 'debit')))
    expect(statuses(gone)).toEqual([[USDC, 'match', '0.0000000', '0.0000000', null]])
  })

  it("attests nothing for an asset the account issues, and ignores other accounts' movements", () => {
    const own = asset('NOST', A)
    const checks = compareBalances(
      { account: A, ledger: 50, balances: [] },
      recorded(fact(10, Money.parse('100', own), 'debit'), fact(11, xlm('5'), 'credit', B)),
    )
    expect(statuses(checks)).toEqual([[own, 'issuer', '0.0000000', '-100.0000000', 50]])
  })
})

/**
 * A source over a fixed list of facts that can only see up to `reached`, as
 * a Horizon server still ingesting would.
 */
class LaggingSource implements MovementSource {
  readonly name = 'fake'
  readonly network = 'testnet'
  reached = Number.POSITIVE_INFINITY
  /** Records per pull at most, whatever the caller asks for. */
  pageSize = Number.POSITIVE_INFINITY
  pulls = 0
  constructor(readonly facts: NewMovement[]) {}
  async pull({ cursor, limit }: PullRequest) {
    this.pulls += 1
    const from = cursor === null ? 0 : Number(cursor)
    const visible = this.facts.filter((f) => f.ledger <= this.reached)
    const batch = visible.slice(from, from + Math.min(limit, this.pageSize))
    return { movements: batch, cursor: String(from + batch.length), caughtUp: from + batch.length >= visible.length }
  }
}

const balancesOf = (lines: BalanceSnapshot['balances'], network = 'testnet'): BalanceSource & { reads: number } => ({
  network,
  reads: 0,
  async snapshot(account) {
    this.reads += 1
    return { account, ledger: 100, balances: lines }
  },
})

describe('attestBalances', () => {
  it('catches the sources up after reading the balances, then compares', async () => {
    const store = new MemoryStore()
    const source = new LaggingSource([fact(10, xlm('10')), fact(20, xlm('3'), 'debit')])
    const balances = balancesOf([{ amount: xlm('7'), lastModifiedLedger: 20 }])
    const read = balances.snapshot.bind(balances)
    let pulledBeforeRead: number | undefined
    balances.snapshot = async (account) => {
      pulledBeforeRead = source.pulls
      return read(account)
    }
    const sleeps: number[] = []
    const checks = await attestBalances({
      store,
      tenantId: T,
      balances,
      sources: [source],
      accounts: [A],
      sleep: async (ms) => void sleeps.push(ms),
    })
    expect(pulledBeforeRead).toBe(0)
    expect(statuses(checks)).toEqual([[NATIVE, 'match', '7.0000000', '7.0000000', 20]])
    expect(await store.listMovements({ tenantId: T })).toHaveLength(2)
    expect(sleeps).toEqual([])
  })

  it('waits for a source that had not reached the ledger yet, without reading the balance again', async () => {
    const store = new MemoryStore()
    const source = new LaggingSource([fact(10, xlm('10')), fact(20, xlm('3'), 'debit')])
    source.reached = 19
    const balances = balancesOf([{ amount: xlm('7'), lastModifiedLedger: 20 }])
    const sleeps: number[] = []
    const checks = await attestBalances({
      store,
      tenantId: T,
      balances,
      sources: [source],
      accounts: [A],
      retryDelayMs: 1234,
      sleep: async (ms) => {
        sleeps.push(ms)
        source.reached = 25
      },
    })
    expect(statuses(checks)).toEqual([[NATIVE, 'match', '7.0000000', '7.0000000', 20]])
    expect(sleeps).toEqual([1234])
    expect(balances.reads).toBe(1)
  })

  it('reads a backlog longer than one sync() call before comparing', async () => {
    const source = new LaggingSource(Array.from({ length: 25 }, (_, i) => fact(i + 1, xlm('1'))))
    source.pageSize = 2 // sync() reads 10 batches per call: 20 of the 25
    const checks = await attestBalances({
      store: new MemoryStore(),
      tenantId: T,
      balances: balancesOf([{ amount: xlm('25'), lastModifiedLedger: 25 }]),
      sources: [source],
      accounts: [A],
      attempts: 1,
    })
    expect(statuses(checks)).toEqual([[NATIVE, 'match', '25.0000000', '25.0000000', 25]])
  })

  it('reports a gap that does not close after the last attempt', async () => {
    const source = new LaggingSource([fact(10, xlm('10'))])
    const sleeps: number[] = []
    const checks = await attestBalances({
      store: new MemoryStore(),
      tenantId: T,
      balances: balancesOf([{ amount: xlm('7'), lastModifiedLedger: 20 }]),
      sources: [source],
      accounts: [A],
      attempts: 4,
      sleep: async (ms) => void sleeps.push(ms),
    })
    expect(statuses(checks)).toEqual([[NATIVE, 'mismatch', '7.0000000', '10.0000000', 20]])
    expect(sleeps).toEqual([6000, 6000, 6000])
  })

  it('refuses sources from another network, and passes on a source that fails', async () => {
    const options = { store: new MemoryStore(), tenantId: T, accounts: [A], sleep: async () => {} }
    await expect(
      attestBalances({ ...options, balances: balancesOf([], 'public'), sources: [new LaggingSource([])] }),
    ).rejects.toThrow(/fake is on testnet, but the balances are from public/)
    const broken: MovementSource = { name: 'fake', network: 'testnet', pull: async () => Promise.reject(new Error('down')) }
    await expect(attestBalances({ ...options, balances: balancesOf([]), sources: [broken] })).rejects.toThrow('down')
  })
})

describe('doctor with attest', () => {
  it('reports a balance mismatch as an I2 error, and the movements it caught up', async () => {
    const store = new MemoryStore()
    const source = new LaggingSource([fact(10, xlm('10'))])
    const report = await doctor({
      store,
      tenantId: T,
      attest: {
        balances: balancesOf([{ amount: xlm('7'), lastModifiedLedger: 20 }]),
        sources: [source],
        accounts: [A],
        attempts: 1,
      },
    })
    expect(report.ok).toBe(false)
    expect(report.findings).toEqual([
      expect.objectContaining({ invariant: 'I2', severity: 'error', code: 'balance_mismatch', account: A, asset: NATIVE }),
    ])
    expect(report.findings[0]!.detail).toBe(
      `the chain says ${A} holds 7.0000000 native as of ledger 20, but its recorded movements add up to 10.0000000`,
    )
    expect(report.balances).toHaveLength(1)
    expect(report.movements.byDisposition.pending).toBe(1)
  })

  it('does not attest unless asked', async () => {
    expect((await doctor({ store: new MemoryStore(), tenantId: T })).balances).toBeNull()
  })
})

describe('HorizonBalanceSource', () => {
  const account = {
    id: A,
    last_modified_ledger: 5190231,
    balances: [
      {
        balance: '19.3490000',
        asset_type: 'credit_alphanum4',
        asset_code: 'USDC',
        asset_issuer: ISSUER,
        last_modified_ledger: 2017678,
      },
      { balance: '3.0000000', asset_type: 'liquidity_pool_shares', last_modified_ledger: 2017000 },
      { balance: '9936.9163730', asset_type: 'native' },
    ],
  }
  const serve = (status: number, body: unknown, headers: Record<string, string> = {}) => {
    const urls: string[] = []
    const fetch = (async (input: string | URL | Request) => {
      urls.push(String(input))
      return new Response(JSON.stringify(body), { status, headers })
    }) as typeof globalThis.fetch
    const source = new HorizonBalanceSource({
      client: new HorizonClient({ url: 'https://horizon.test', fetch, retries: 0 }),
      network: 'testnet',
    })
    return { source, urls }
  }

  it('reads each balance with the ledger it last changed in, skipping pool shares', async () => {
    const { source, urls } = serve(200, account, { 'latest-ledger': '5190244' })
    const snapshot = await source.snapshot(A)
    expect(urls).toEqual([`https://horizon.test/accounts/${A}`])
    expect(snapshot.account).toBe(A)
    expect(snapshot.ledger).toBe(5190244)
    expect(snapshot.balances.map((b) => [b.amount.asset, b.amount.raw, b.lastModifiedLedger])).toEqual([
      [USDC, 193490000n, 2017678],
      [NATIVE, 99369163730n, 5190231],
    ])
  })

  it('treats an account Horizon does not know as holding nothing', async () => {
    const { source } = serve(404, { type: 'https://stellar.org/horizon-errors/not_found', status: 404 })
    expect(await source.snapshot(A)).toEqual({ account: A, ledger: null, balances: [] })
  })

  it('passes on any other failure', async () => {
    const { source } = serve(400, { type: 'https://stellar.org/horizon-errors/bad_request', status: 400 })
    await expect(source.snapshot(A)).rejects.toMatchObject({ name: 'HorizonError', status: 400 })
  })
})

describe('attesting through the Horizon sources', () => {
  // A is paid 25 by B, then pays B 5 and the 100-stroop fee.
  const horizon = () => {
    const h = new FakeHorizon()
    h.payment(10, B, A, '25')
    h.payment(11, A, B, '5')
    h.accounts.set(A, { id: A, last_modified_ledger: 11, balances: [{ balance: '19.9999900', asset_type: 'native' }] })
    return h
  }
  const attest = (h: FakeHorizon, fees: boolean) => {
    const client = h.client()
    const sources: MovementSource[] = [new HorizonEffectsSource({ client, network: 'testnet' })]
    if (fees) sources.push(new HorizonFeesSource({ client, network: 'testnet' }))
    const balances = new HorizonBalanceSource({ client, network: 'testnet' })
    return attestBalances({ store: new MemoryStore(), tenantId: T, balances, sources, accounts: [A], attempts: 1 })
  }

  it('matches when both the effects and the fees are read', async () => {
    const [check] = await attest(horizon(), true)
    expect(check).toMatchObject({ asset: NATIVE, status: 'match', ledger: 11 })
    expect(check!.recorded.toString()).toBe('19.9999900')
  })

  it('is short by the fees when the fees source is left out', async () => {
    const [check] = await attest(horizon(), false)
    expect(check!.status).toBe('mismatch')
    expect(check!.chain.subtract(check!.recorded).toString()).toBe('-0.0000100')
  })
})
