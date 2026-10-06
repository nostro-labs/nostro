import { describe, expect, it } from 'vitest'
import type { MovementSource, NewMovement, PullRequest } from '../src/index.js'
import { MemoryStore, Money, NATIVE, sync } from '../src/index.js'

const T = 'tenant'
const A = `G${'A'.repeat(55)}`
const B = `G${'B'.repeat(55)}`
const KEY = (account: string) => ({ tenantId: T, network: 'testnet', source: 'fake', account })

interface FeedRecord {
  readonly token: string
  /** `null` for a record that carries no value movement (e.g. a signer change). */
  readonly amount: string | null
}

function movement(account: string, token: string, amount: string): NewMovement {
  return {
    tenantId: T,
    network: 'testnet',
    source: 'fake',
    externalId: token,
    account,
    direction: 'credit',
    kind: 'transfer',
    amount: Money.parse(amount, NATIVE),
    ledger: Number(token),
    txHash: Number(token).toString(16).padStart(64, '0'),
    occurredAt: new Date('2026-10-06T00:00:00Z'),
  }
}

/** A source over fixed per-account feeds, with tokens compared numerically. */
class FakeSource implements MovementSource {
  readonly name = 'fake'
  readonly network = 'testnet'
  readonly pulls: PullRequest[] = []
  constructor(
    public feeds: Record<string, FeedRecord[]>,
    private readonly beforeReturn?: (req: PullRequest) => Promise<void>,
  ) {}

  async pull(req: PullRequest) {
    this.pulls.push(req)
    const feed = this.feeds[req.account]
    if (feed === undefined) throw new Error(`no feed for ${req.account}`)
    const after = req.cursor === null ? -1 : Number(req.cursor)
    const pending = feed.filter((r) => Number(r.token) > after)
    const batch = pending.slice(0, req.limit)
    await this.beforeReturn?.(req)
    return {
      movements: batch.flatMap((r) => (r.amount === null ? [] : [movement(req.account, r.token, r.amount)])),
      cursor: batch.length === 0 ? req.cursor : batch[batch.length - 1]!.token,
      caughtUp: pending.length <= req.limit,
    }
  }
}

const feed = (...amounts: (string | null)[]): FeedRecord[] =>
  amounts.map((amount, i) => ({ token: String(i + 1), amount }))

describe('sync', () => {
  it('reads a backlog in bounded batches and resumes from the stored cursor', async () => {
    const store = new MemoryStore()
    const source = new FakeSource({ [A]: feed('1', '2', '3', '4', '5') })

    const first = await sync({ store, source, tenantId: T, accounts: [A], batchSize: 2, maxBatches: 2 })
    expect(first.accounts[0]).toMatchObject({ batches: 2, inserted: 4, caughtUp: false, cursor: '4', error: null })
    expect(await store.getCursor(KEY(A))).toBe('4')

    const second = await sync({ store, source, tenantId: T, accounts: [A], batchSize: 2, maxBatches: 2 })
    expect(second.accounts[0]).toMatchObject({ batches: 1, inserted: 1, caughtUp: true, cursor: '5' })
    expect(source.pulls.map((p) => p.cursor)).toEqual([null, '2', '4'])

    const idle = await sync({ store, source, tenantId: T, accounts: [A] })
    expect(idle.inserted).toBe(0)
    expect(await store.listMovements({ tenantId: T })).toHaveLength(5)
  })

  it('advances past records that carry no value movement', async () => {
    const store = new MemoryStore()
    const source = new FakeSource({ [A]: feed(null, null, '1') })
    const report = await sync({ store, source, tenantId: T, accounts: [A], batchSize: 2, maxBatches: 1 })
    expect(report.accounts[0]).toMatchObject({ inserted: 0, cursor: '2' })
    expect(await store.getCursor(KEY(A))).toBe('2')
  })

  it('never advances the cursor past a batch it failed to record', async () => {
    const store = new MemoryStore()
    const source = new FakeSource({ [A]: feed('1', '-2', '3') })
    const report = await sync({ store, source, tenantId: T, accounts: [A] })
    expect(report.errors).toHaveLength(1)
    expect(report.errors[0]!.error.name).toBe('ValidationError')
    expect(await store.getCursor(KEY(A))).toBeNull()
    expect(await store.listMovements({ tenantId: T })).toHaveLength(0)
  })

  it('files SOURCE_GAP_DETECTED when a re-delivery disagrees, and keeps the recorded facts', async () => {
    const store = new MemoryStore()
    const source = new FakeSource({ [A]: feed('10') })
    await sync({ store, source, tenantId: T, accounts: [A] })

    // The source now reports a different amount for the same record, and we
    // re-read it (as a reingest would) by rewinding the cursor.
    source.feeds[A] = feed('12')
    await store.transaction((tx) => tx.setCursor(KEY(A), '0'))
    const report = await sync({ store, source, tenantId: T, accounts: [A] })

    expect(report.conflicts).toBe(1)
    const [m] = await store.listMovements({ tenantId: T })
    expect(m!.amount.toString()).toBe('10.0000000')
    const [gap] = await store.listExceptions({ tenantId: T, code: 'SOURCE_GAP_DETECTED' })
    expect(gap).toMatchObject({ movementId: m!.id, account: A, status: 'open' })
    expect(gap!.evidence).toMatchObject({ recorded: { amount: '10.0000000' }, redelivered: { amount: '12.0000000' } })
  })

  it('discards its batch when another writer advances the cursor mid-pull', async () => {
    const store = new MemoryStore()
    let raced = false
    const source = new FakeSource({ [A]: feed('1', '2') }, async () => {
      if (raced) return
      raced = true
      await store.transaction((tx) => tx.setCursor(KEY(A), '2'))
    })
    const report = await sync({ store, source, tenantId: T, accounts: [A] })
    expect(report.accounts[0]).toMatchObject({ contended: true, inserted: 0, error: null })
    expect(report.errors).toHaveLength(0)
    expect(await store.getCursor(KEY(A))).toBe('2')
    expect(await store.listMovements({ tenantId: T })).toHaveLength(0)
  })

  it('keeps syncing other accounts when one fails', async () => {
    const store = new MemoryStore()
    const source = new FakeSource({ [B]: feed('1') })
    const report = await sync({ store, source, tenantId: T, accounts: [A, B] })
    expect(report.errors.map((e) => e.account)).toEqual([A])
    expect(report.accounts[1]).toMatchObject({ account: B, inserted: 1, error: null })
  })

  it('rejects a source that returns movements outside the requested stream', async () => {
    const store = new MemoryStore()
    const source = new FakeSource({ [A]: feed('1') })
    const leaky: MovementSource = {
      name: 'fake',
      network: 'testnet',
      pull: async (req) => {
        const r = await source.pull(req)
        return { ...r, movements: r.movements.map((m) => ({ ...m, account: B })) }
      },
    }
    const report = await sync({ store, source: leaky, tenantId: T, accounts: [A] })
    expect(report.errors[0]!.error.message).toContain('outside the requested stream')
    expect(await store.listMovements({ tenantId: T })).toHaveLength(0)
  })
})
