/**
 * The `Store` contract, as executable tests.
 *
 * Every store implementation runs this same suite. It is how the Store
 * interface stays honest: a constraint the memory store enforces in code must
 * be enforced by the SQL stores with constraints and locks, and this suite is
 * what notices when one of them doesn't.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Disposition, NewException, NewMovement, Store, StoreTx } from '../src/index.js'
import {
  ConstraintError,
  Money,
  NotFoundError,
  TransactionClosedError,
  ValidationError,
  asset,
} from '../src/index.js'

const T = 'tenant-a'
const T2 = 'tenant-b'
const ACCOUNT = `G${'A'.repeat(55)}`
const OTHER_ACCOUNT = `G${'C'.repeat(55)}`
const PAYER = `G${'B'.repeat(55)}`
const CIRCLE = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
const LOOKALIKE = 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW'
const USDC = asset('USDC', CIRCLE)
const FAKE_USDC = asset('USDC', LOOKALIKE)
const usdc = (v: string) => Money.parse(v, USDC)
const CURSOR = { tenantId: T, network: 'testnet', source: 'horizon', account: ACCOUNT }

let counter = 0
function movement(over: Partial<NewMovement> = {}): NewMovement {
  counter += 1
  return {
    tenantId: T,
    network: 'testnet',
    source: 'horizon',
    externalId: `effect-${counter}`,
    account: ACCOUNT,
    direction: 'credit',
    kind: 'transfer',
    amount: usdc('10'),
    counterparty: PAYER,
    memo: { type: 'text', value: `INV-${counter}` },
    ledger: 1_000 + counter,
    txHash: counter.toString(16).padStart(64, '0'),
    operationId: `op-${counter}`,
    occurredAt: new Date('2026-10-01T12:00:00Z'),
    ...over,
  }
}

const constraint = (name: string) => ({ name: 'ConstraintError', constraint: name })

export function describeStoreConformance(name: string, makeStore: () => Store | Promise<Store>): void {
  describe(`Store conformance: ${name}`, () => {
    let store: Store

    beforeEach(async () => {
      store = await makeStore()
    })
    afterEach(async () => {
      await store.close()
    })

    /** Record one movement and return it. */
    async function record(over: Partial<NewMovement> = {}) {
      const { inserted } = await store.transaction((tx) => tx.insertMovements([movement(over)]))
      return inserted[0]!
    }

    async function expect10(reference = `INV-${++counter}`, over: { amount?: Money; direction?: 'credit' | 'debit' } = {}) {
      return store.transaction((tx) =>
        tx.insertExpectation({ tenantId: T, reference, account: ACCOUNT, amount: usdc('10'), ...over }),
      )
    }

    describe('movements', () => {
      it('records movements in ingest order with store-assigned identity', async () => {
        const a = await record()
        const b = await record()
        expect(a.id).not.toBe('')
        expect(a.id).not.toBe(b.id)
        expect(b.seq).toBeGreaterThan(a.seq)
        expect(a).toMatchObject({ disposition: 'pending', revision: 1, enrichment: 'complete' })
        expect(Object.isFrozen(a)).toBe(true)
        const listed = await store.listMovements({ tenantId: T })
        expect(listed.map((m) => m.id)).toEqual([a.id, b.id])
      })

      it('preserves amounts and muxed ids beyond the float-safe range exactly', async () => {
        const huge = Money.fromRaw(2n ** 62n + 1n, USDC)
        const muxedId = 2n ** 64n - 1n
        const m = await record({ amount: huge, muxedId, memo: { type: 'id', value: muxedId } })
        const read = await store.getMovement(T, m.id)
        expect(read!.amount.raw).toBe(2n ** 62n + 1n)
        expect(read!.muxedId).toBe(muxedId)
        expect(read!.memo).toEqual({ type: 'id', value: muxedId })
      })

      it('deduplicates a re-delivery within a batch and across transactions', async () => {
        const m = movement()
        const first = await store.transaction((tx) => tx.insertMovements([m, m]))
        expect(first.inserted).toHaveLength(1)
        expect(first.duplicates).toHaveLength(1)
        const again = await store.transaction((tx) => tx.insertMovements([m]))
        expect(again.inserted).toHaveLength(0)
        expect(again.duplicates.map((d) => d.id)).toEqual([first.inserted[0]!.id])
        expect(await store.listMovements({ tenantId: T })).toHaveLength(1)
      })

      it('reports a conflicting re-delivery and never overwrites the recorded facts', async () => {
        const m = movement()
        const { inserted } = await store.transaction((tx) => tx.insertMovements([m]))
        const corrected = { ...m, amount: usdc('11') }
        const result = await store.transaction((tx) => tx.insertMovements([corrected]))
        expect(result.inserted).toHaveLength(0)
        expect(result.conflicts).toHaveLength(1)
        expect(result.conflicts[0]!.existing.id).toBe(inserted[0]!.id)
        const stored = await store.getMovement(T, inserted[0]!.id)
        expect(stored!.amount.toString()).toBe('10.0000000')
      })

      it('scopes the dedupe key by tenant', async () => {
        const m = movement()
        await store.transaction((tx) => tx.insertMovements([m]))
        const other = await store.transaction((tx) => tx.insertMovements([{ ...m, tenantId: T2 }]))
        expect(other.inserted).toHaveLength(1)
        expect(await store.listMovements({ tenantId: T })).toHaveLength(1)
        expect(await store.listMovements({ tenantId: T2 })).toHaveLength(1)
      })

      it('rejects structurally impossible movements and records none of the batch', async () => {
        const bad: Partial<NewMovement>[] = [
          { amount: usdc('0') },
          { amount: usdc('-1') },
          { txHash: 'not-a-hash' },
          { muxedId: 2n ** 64n },
          { ledger: 0 },
          { account: 'GSHORT' },
          { memo: { type: 'hash', value: 'XYZ' } },
        ]
        for (const over of bad) {
          await expect(
            store.transaction((tx) => tx.insertMovements([movement(), movement(over)])),
          ).rejects.toBeInstanceOf(ValidationError)
        }
        expect(await store.listMovements({ tenantId: T })).toHaveLength(0)
      })

      it('accepts unusual but possible data rather than dropping it', async () => {
        // Sources replace invalid UTF-8 with U+FFFD (3 bytes each), so a decoded
        // text memo can exceed the 28-byte on-ledger limit. That is the
        // matcher's problem to flag, never a reason to lose the movement.
        const m = await record({
          memo: { type: 'text', value: '�'.repeat(12) },
          counterparty: `M${'A'.repeat(68)}`,
          enrichment: 'missing',
        })
        expect(m.memo).toEqual({ type: 'text', value: '�'.repeat(12) })
        await record({ counterparty: `C${'A'.repeat(55)}`, kind: 'fee', direction: 'debit' })
        await record({ counterparty: null, memo: null, operationId: null })
        expect(await store.listMovements({ tenantId: T })).toHaveLength(3)
      })

      it('serves the pending queue by disposition, account and seq', async () => {
        const a = await record()
        const b = await record({ account: OTHER_ACCOUNT })
        const c = await record()
        await store.transaction((tx) => tx.setDisposition(T, a.id, 'ignored', 'test sweep'))
        const pending = await store.listMovements({ tenantId: T, disposition: 'pending' })
        expect(pending.map((m) => m.id)).toEqual([b.id, c.id])
        const forAccount = await store.listMovements({ tenantId: T, account: OTHER_ACCOUNT })
        expect(forAccount.map((m) => m.id)).toEqual([b.id])
        const page = await store.listMovements({ tenantId: T, afterSeq: a.seq, limit: 1 })
        expect(page.map((m) => m.id)).toEqual([b.id])
      })
    })

    describe('transactions and cursors', () => {
      it('advances the cursor atomically with the movements it covers', async () => {
        await expect(
          store.transaction(async (tx) => {
            await tx.insertMovements([movement()])
            await tx.setCursor(CURSOR, '1234-1')
            throw new Error('crash between write and commit')
          }),
        ).rejects.toThrow('crash between write and commit')
        expect(await store.listMovements({ tenantId: T })).toHaveLength(0)
        expect(await store.getCursor(CURSOR)).toBeNull()

        await store.transaction(async (tx) => {
          await tx.insertMovements([movement()])
          await tx.setCursor(CURSOR, '1234-1')
        })
        expect(await store.listMovements({ tenantId: T })).toHaveLength(1)
        expect(await store.getCursor(CURSOR)).toBe('1234-1')
      })

      it('keeps cursors separate per tenant, network, source and account', async () => {
        await store.transaction((tx) => tx.setCursor(CURSOR, 'a'))
        expect(await store.getCursor({ ...CURSOR, tenantId: T2 })).toBeNull()
        expect(await store.getCursor({ ...CURSOR, network: 'public' })).toBeNull()
        expect(await store.getCursor({ ...CURSOR, account: OTHER_ACCOUNT })).toBeNull()
      })

      it('shows uncommitted writes only inside their own transaction', async () => {
        await store.transaction(async (tx) => {
          await tx.insertMovements([movement()])
          expect(await tx.listMovements({ tenantId: T })).toHaveLength(1)
          expect(await store.listMovements({ tenantId: T })).toHaveLength(0)
        })
        expect(await store.listMovements({ tenantId: T })).toHaveLength(1)
      })

      it('refuses a transaction handle used after it settles', async () => {
        let leaked: StoreTx | undefined
        await store.transaction(async (tx) => {
          leaked = tx
        })
        await expect(leaked!.getCursor(CURSOR)).rejects.toBeInstanceOf(TransactionClosedError)
        await expect(leaked!.insertMovements([movement()])).rejects.toBeInstanceOf(
          TransactionClosedError,
        )
      })
    })

    describe('expectations', () => {
      it('enforces reference uniqueness per tenant', async () => {
        const e = await expect10('INV-001')
        expect(e).toMatchObject({ status: 'open', direction: 'credit', muxedId: null, payers: [] })
        await expect(expect10('INV-001')).rejects.toMatchObject(constraint('expectation_reference_unique'))
        const other = await store.transaction((tx) =>
          tx.insertExpectation({ tenantId: T2, reference: 'INV-001', account: ACCOUNT, amount: usdc('10') }),
        )
        expect(other.id).not.toBe(e.id)
        expect((await store.getExpectationByReference(T, 'INV-001'))!.id).toBe(e.id)
        expect((await store.getExpectationByReference(T2, 'INV-001'))!.id).toBe(other.id)
        expect(await store.getExpectationByReference(T, 'INV-404')).toBeNull()
      })

      it('finds match candidates by account, asset, direction, status and muxed id', async () => {
        const plain = await expect10()
        const muxed = await store.transaction((tx) =>
          tx.insertExpectation({
            tenantId: T,
            reference: 'MUX-1',
            account: ACCOUNT,
            amount: usdc('10'),
            muxedId: 42n,
            payers: [PAYER],
          }),
        )
        const fake = await expect10(undefined, { amount: Money.parse('10', FAKE_USDC) })
        const payout = await expect10(undefined, { direction: 'debit' })
        const ids = async (q: Omit<Parameters<Store['listExpectations']>[0], 'tenantId'>) =>
          (await store.listExpectations({ tenantId: T, ...q })).map((e) => e.id)

        expect(await ids({ asset: USDC, direction: 'credit' })).toEqual([plain.id, muxed.id])
        expect(await ids({ asset: FAKE_USDC })).toEqual([fake.id])
        expect(await ids({ direction: 'debit' })).toEqual([payout.id])
        expect(await ids({ muxedId: 42n })).toEqual([muxed.id])
        expect(await ids({ account: OTHER_ACCOUNT })).toEqual([])
        await store.transaction((tx) => tx.cancelExpectation(T, plain.id, 'customer withdrew'))
        expect(await ids({ asset: USDC, status: ['open', 'partially_paid'] })).toEqual([muxed.id, payout.id])
      })

      it('cancels only an expectation with nothing allocated to it', async () => {
        const e = await expect10()
        const cancelled = await store.transaction((tx) => tx.cancelExpectation(T, e.id, 'duplicate invoice'))
        expect(cancelled).toMatchObject({ status: 'cancelled', cancelReason: 'duplicate invoice' })
        await expect(
          store.transaction((tx) => tx.cancelExpectation(T, e.id, 'again')),
        ).rejects.toMatchObject(constraint('expectation_not_open'))

        const paid = await expect10()
        const m = await record({ amount: usdc('4') })
        await store.transaction((tx) =>
          tx.allocate({ tenantId: T, movementId: m.id, expectationId: paid.id, amount: usdc('4'), strategy: 'manual' }),
        )
        await expect(
          store.transaction((tx) => tx.cancelExpectation(T, paid.id, 'too late')),
        ).rejects.toMatchObject(constraint('expectation_has_allocations'))
      })
    })

    describe('allocations', () => {
      const alloc = (movementId: string, expectationId: string, amount: Money, tenantId = T) =>
        store.transaction((tx) =>
          tx.allocate({ tenantId, movementId, expectationId, amount, strategy: 'memo_text', score: 0.85 }),
        )

      it('settles an expectation through partial payments from several movements', async () => {
        const e = await expect10()
        const first = await record({ amount: usdc('4') })
        const second = await record({ amount: usdc('6') })
        const a = await alloc(first.id, e.id, usdc('4'))
        expect(a).toMatchObject({ strategy: 'memo_text', score: 0.85 })
        expect((await store.getExpectation(T, e.id))!.status).toBe('partially_paid')
        await alloc(second.id, e.id, usdc('6'))
        expect((await store.getExpectation(T, e.id))!.status).toBe('settled')
        const allocations = await store.listAllocations({ tenantId: T, expectationId: e.id })
        expect(allocations.map((x) => x.amount.toString())).toEqual(['4.0000000', '6.0000000'])
      })

      it('splits one payment across several expectations', async () => {
        const wire = await record({ amount: usdc('30') })
        const invoices = [await expect10(), await expect10(), await expect10()]
        for (const inv of invoices) await alloc(wire.id, inv.id, usdc('10'))
        const statuses = await Promise.all(invoices.map((i) => store.getExpectation(T, i.id)))
        expect(statuses.map((s) => s!.status)).toEqual(['settled', 'settled', 'settled'])
        expect(await store.listAllocations({ tenantId: T, movementId: wire.id })).toHaveLength(3)
      })

      it('refuses to over-allocate a movement', async () => {
        const m = await record({ amount: usdc('10') })
        const [x, y] = [await expect10(), await expect10()]
        await alloc(m.id, x.id, usdc('8'))
        await expect(alloc(m.id, y.id, usdc('8'))).rejects.toMatchObject(constraint('allocation_over_movement'))
        await alloc(m.id, y.id, usdc('2'))
      })

      it('refuses to over-allocate an expectation, leaving the residual for an exception', async () => {
        const e = await expect10()
        const m = await record({ amount: usdc('15') })
        await expect(alloc(m.id, e.id, usdc('15'))).rejects.toMatchObject(
          constraint('allocation_over_expectation'),
        )
        await alloc(m.id, e.id, usdc('10'))
        expect((await store.getExpectation(T, e.id))!.status).toBe('settled')
      })

      it('refuses a lookalike asset that shares the code but not the issuer', async () => {
        const e = await expect10()
        const m = await record({ amount: Money.parse('10', FAKE_USDC) })
        const attempt = alloc(m.id, e.id, Money.parse('10', FAKE_USDC))
        await expect(attempt).rejects.toMatchObject(constraint('allocation_asset'))
        await expect(attempt).rejects.toThrow(/lookalike/)
        expect((await store.getExpectation(T, e.id))!.status).toBe('open')
      })

      it('refuses to settle an incoming expectation with an outgoing movement', async () => {
        const e = await expect10()
        const m = await record({ direction: 'debit' })
        await expect(alloc(m.id, e.id, usdc('10'))).rejects.toMatchObject(constraint('allocation_direction'))
      })

      it('refuses a second allocation for the same pair', async () => {
        const e = await expect10()
        const m = await record()
        await alloc(m.id, e.id, usdc('3'))
        await expect(alloc(m.id, e.id, usdc('3'))).rejects.toMatchObject(constraint('allocation_unique'))
      })

      it('refuses to allocate to a cancelled expectation', async () => {
        const e = await expect10()
        const m = await record()
        await store.transaction((tx) => tx.cancelExpectation(T, e.id, 'voided'))
        await expect(alloc(m.id, e.id, usdc('10'))).rejects.toMatchObject(
          constraint('allocation_expectation_cancelled'),
        )
      })

      it('never lets two concurrent transactions over-allocate one expectation', async () => {
        const e = await expect10()
        const [m1, m2] = [await record(), await record()]
        const race = (m: { id: string }) =>
          store.transaction(async (tx) => {
            const before = await tx.getExpectation(T, e.id)
            // Yield so the other transaction gets every chance to interleave.
            await new Promise((r) => setTimeout(r, 5))
            if (before!.status !== 'open') throw new Error('already paid')
            return tx.allocate({ tenantId: T, movementId: m.id, expectationId: e.id, amount: usdc('10'), strategy: 'manual' })
          })
        const results = await Promise.allSettled([race(m1), race(m2)])
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
        expect(await store.listAllocations({ tenantId: T, expectationId: e.id })).toHaveLength(1)
      })

      it('rolls back allocations and expectation status when the transaction throws', async () => {
        const e = await expect10()
        const m = await record()
        await expect(
          store.transaction(async (tx) => {
            await tx.allocate({ tenantId: T, movementId: m.id, expectationId: e.id, amount: usdc('10'), strategy: 'manual' })
            throw new Error('abort')
          }),
        ).rejects.toThrow('abort')
        expect((await store.getExpectation(T, e.id))!.status).toBe('open')
        expect(await store.listAllocations({ tenantId: T, movementId: m.id })).toHaveLength(0)
      })

      it('treats records from another tenant as absent', async () => {
        const e = await expect10()
        const m = await record()
        expect(await store.getMovement(T2, m.id)).toBeNull()
        expect(await store.getExpectation(T2, e.id)).toBeNull()
        await expect(alloc(m.id, e.id, usdc('10'), T2)).rejects.toBeInstanceOf(NotFoundError)
      })
    })

    describe('dispositions', () => {
      const set = (id: string, d: Disposition, reason?: string) =>
        store.transaction((tx) => tx.setDisposition(T, id, d, reason))

      it('marks a movement allocated only once it is fully allocated', async () => {
        const m = await record()
        const e = await expect10()
        await expect(set(m.id, 'allocated')).rejects.toMatchObject(constraint('disposition_unsupported'))
        await store.transaction((tx) =>
          tx.allocate({ tenantId: T, movementId: m.id, expectationId: e.id, amount: usdc('10'), strategy: 'manual' }),
        )
        expect((await set(m.id, 'allocated')).disposition).toBe('allocated')
        await expect(set(m.id, 'pending')).rejects.toMatchObject(constraint('disposition_unsupported'))
      })

      it('marks a movement partial only when an open exception covers the residual', async () => {
        const m = await record({ amount: usdc('15') })
        const e = await expect10()
        await store.transaction((tx) =>
          tx.allocate({ tenantId: T, movementId: m.id, expectationId: e.id, amount: usdc('10'), strategy: 'manual' }),
        )
        await expect(set(m.id, 'partial')).rejects.toMatchObject(constraint('disposition_unsupported'))
        await store.transaction((tx) =>
          tx.openException({ tenantId: T, code: 'OVERPAYMENT', movementId: m.id, amount: usdc('5'), detail: '5 USDC over' }),
        )
        expect((await set(m.id, 'partial')).disposition).toBe('partial')
      })

      it('marks a movement exception only when it has one', async () => {
        const m = await record()
        await expect(set(m.id, 'exception')).rejects.toMatchObject(constraint('disposition_unsupported'))
        await store.transaction((tx) =>
          tx.openException({ tenantId: T, code: 'UNMATCHED_NO_CANDIDATE', movementId: m.id, detail: 'no open invoice' }),
        )
        expect((await set(m.id, 'exception')).disposition).toBe('exception')
      })

      it('marks a movement ignored only with a reason', async () => {
        const m = await record({ kind: 'fee', direction: 'debit' })
        await expect(set(m.id, 'ignored')).rejects.toMatchObject(constraint('disposition_unsupported'))
        await expect(set(m.id, 'ignored', '  ')).rejects.toMatchObject(constraint('disposition_unsupported'))
        const ignored = await set(m.id, 'ignored', 'network fee; posted to expense')
        expect(ignored).toMatchObject({ disposition: 'ignored', ignoredReason: 'network fee; posted to expense' })
      })
    })

    describe('exceptions', () => {
      it('opens, filters and resolves an exception exactly once', async () => {
        const m = await record()
        const opened = await store.transaction((tx) =>
          tx.openException({
            tenantId: T,
            code: 'AMBIGUOUS_MATCH',
            movementId: m.id,
            detail: 'two open invoices for 10 USDC',
            evidence: { candidates: [{ reference: 'INV-1', score: 0.6 }, { reference: 'INV-2', score: 0.6 }] },
          }),
        )
        expect(opened).toMatchObject({ status: 'open', resolvedAt: null, expectationId: null })
        expect(await store.listExceptions({ tenantId: T, code: 'AMBIGUOUS_MATCH' })).toHaveLength(1)
        expect(await store.listExceptions({ tenantId: T, code: 'WRONG_ASSET' })).toHaveLength(0)
        expect(await store.listExceptions({ tenantId: T2 })).toHaveLength(0)

        await expect(
          store.transaction((tx) => tx.resolveException(T, opened.id, { status: 'resolved', note: '' })),
        ).rejects.toBeInstanceOf(ValidationError)
        const resolved = await store.transaction((tx) =>
          tx.resolveException(T, opened.id, { status: 'resolved', note: 'customer confirmed INV-2' }),
        )
        expect(resolved.status).toBe('resolved')
        expect(resolved.resolvedAt).toBeInstanceOf(Date)
        expect(await store.listExceptions({ tenantId: T, status: 'open' })).toHaveLength(0)
        await expect(
          store.transaction((tx) => tx.resolveException(T, opened.id, { status: 'dismissed', note: 'again' })),
        ).rejects.toMatchObject(constraint('exception_not_open'))
      })

      it('requires a subject, a known code and an existing referent', async () => {
        const open = (n: NewException) => store.transaction((tx) => tx.openException(n))
        await expect(open({ tenantId: T, code: 'WRONG_ASSET', detail: 'x' })).rejects.toBeInstanceOf(ValidationError)
        await expect(
          open({ tenantId: T, code: 'NOT_A_CODE' as 'WRONG_ASSET', account: ACCOUNT, detail: 'x' }),
        ).rejects.toBeInstanceOf(ValidationError)
        await expect(
          open({ tenantId: T, code: 'WRONG_ASSET', movementId: 'missing', detail: 'x' }),
        ).rejects.toBeInstanceOf(NotFoundError)
        const gap = await open({
          tenantId: T,
          code: 'SOURCE_GAP_DETECTED',
          account: ACCOUNT,
          detail: 'ledgers 58762517..59501299 re-read with differences',
        })
        expect(gap.account).toBe(ACCOUNT)
      })
    })

    it('validates write arguments that are not records', async () => {
      const e = await expect10()
      const m = await record()
      const tx = <R>(fn: (t: StoreTx) => Promise<R>) => store.transaction(fn)
      await expect(tx((t) => t.setCursor(CURSOR, ''))).rejects.toBeInstanceOf(ValidationError)
      await expect(tx((t) => t.cancelExpectation(T, e.id, ' '))).rejects.toBeInstanceOf(ValidationError)
      await expect(tx((t) => t.cancelExpectation(T, 'missing', 'x'))).rejects.toBeInstanceOf(NotFoundError)
      await expect(tx((t) => t.setDisposition(T, m.id, 'done' as Disposition))).rejects.toBeInstanceOf(
        ValidationError,
      )
      await expect(tx((t) => t.setDisposition(T, 'missing', 'ignored', 'x'))).rejects.toBeInstanceOf(
        NotFoundError,
      )
      await expect(
        tx((t) => t.resolveException(T, 'missing', { status: 'resolved', note: 'x' })),
      ).rejects.toBeInstanceOf(NotFoundError)
      const ex = await tx((t) => t.openException({ tenantId: T, code: 'MEMO_MISSING', movementId: m.id, detail: 'x' }))
      await expect(
        tx((t) => t.resolveException(T, ex.id, { status: 'open' as 'resolved', note: 'x' })),
      ).rejects.toBeInstanceOf(ValidationError)
      expect(await store.getException(T, ex.id)).toMatchObject({ status: 'open' })
      expect(await store.getException(T2, ex.id)).toBeNull()
    })

    it('reports errors with stable, typed codes', () => {
      expect(new ConstraintError('allocation_unique', 'x').code).toBe('CONSTRAINT')
      expect(new NotFoundError('movement', 'x').code).toBe('NOT_FOUND')
      expect(new TransactionClosedError().code).toBe('TX_CLOSED')
    })
  })
}
