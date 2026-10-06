/**
 * An in-process `Store` with no dependencies.
 *
 * It exists so the quickstart runs with no database and so the matching engine
 * can be tested with no I/O. It is not a toy, though: it enforces every
 * constraint in the `Store` contract and passes the same conformance suite as
 * the SQL stores.
 *
 * Transactions are serialised: each one runs against a private copy of the
 * committed state, which replaces the committed state only if the callback
 * resolves. That gives serializable isolation and all-or-nothing rollback.
 * Reads outside a transaction see committed state only.
 *
 * Each transaction copies the state's indexes, so cost grows with the number
 * of records. That is fine for tests, development and small deployments; use
 * a SQL store for anything long-lived.
 */
import type {
  Allocation,
  CursorKey,
  Disposition,
  ExceptionRecord,
  Expectation,
  Memo,
  Movement,
  NewAllocation,
  NewException,
  NewExpectation,
  NewMovement,
} from '../model/index.js'
import {
  ValidationError,
  assertValidNewAllocation,
  assertValidNewException,
  assertValidNewExpectation,
  assertValidNewMovement,
} from '../model/index.js'
import { Money, isSameCodeDifferentIssuer } from '../money/index.js'
import type {
  AllocationQuery,
  ExceptionQuery,
  ExpectationQuery,
  InsertMovementsResult,
  MovementConflict,
  MovementQuery,
  Resolution,
  Store,
  StoreReader,
  StoreTx,
} from './store.js'
import { ConstraintError, NotFoundError, TransactionClosedError } from './store.js'

export interface MemoryStoreOptions {
  /** Id generator. Defaults to `crypto.randomUUID()`; inject one for deterministic tests. */
  readonly ids?: () => string
  /** Clock for `createdAt` and friends. Defaults to `new Date()`. */
  readonly now?: () => Date
}

interface State {
  seq: number
  readonly movements: Map<string, Movement>
  /** Dedupe key → movement id. */
  readonly movementKeys: Map<string, string>
  readonly expectations: Map<string, Expectation>
  /** (tenant, reference) → expectation id. */
  readonly expectationRefs: Map<string, string>
  readonly allocations: Map<string, Allocation>
  readonly exceptions: Map<string, ExceptionRecord>
  readonly cursors: Map<string, string>
}

function emptyState(): State {
  return {
    seq: 0,
    movements: new Map(),
    movementKeys: new Map(),
    expectations: new Map(),
    expectationRefs: new Map(),
    allocations: new Map(),
    exceptions: new Map(),
    cursors: new Map(),
  }
}

/** Records are frozen, so copying the indexes is a complete snapshot. */
function cloneState(s: State): State {
  return {
    seq: s.seq,
    movements: new Map(s.movements),
    movementKeys: new Map(s.movementKeys),
    expectations: new Map(s.expectations),
    expectationRefs: new Map(s.expectationRefs),
    allocations: new Map(s.allocations),
    exceptions: new Map(s.exceptions),
    cursors: new Map(s.cursors),
  }
}

const key = (...parts: readonly string[]): string => JSON.stringify(parts)
const movementKey = (m: { tenantId: string; network: string; source: string; externalId: string }) =>
  key(m.tenantId, m.network, m.source, m.externalId)
const cursorKey = (k: CursorKey) => key(k.tenantId, k.network, k.source, k.account)
const copyDate = (d: Date): Date => new Date(d.getTime())

function sameMemo(a: Memo | null, b: Memo | null): boolean {
  if (a === null || b === null) return a === b
  return a.type === b.type && a.value === b.value
}

/** Whether a re-delivered movement states the same facts as the recorded one. */
function sameFacts(existing: Movement, incoming: Movement): boolean {
  return (
    existing.account === incoming.account &&
    existing.direction === incoming.direction &&
    existing.kind === incoming.kind &&
    existing.amount.equals(incoming.amount) &&
    existing.counterparty === incoming.counterparty &&
    existing.muxedId === incoming.muxedId &&
    sameMemo(existing.memo, incoming.memo) &&
    existing.ledger === incoming.ledger &&
    existing.txHash === incoming.txHash &&
    existing.operationId === incoming.operationId &&
    existing.occurredAt.getTime() === incoming.occurredAt.getTime() &&
    existing.enrichment === incoming.enrichment
  )
}

function sum(amounts: readonly Money[], like: Money): Money {
  return amounts.reduce((acc, m) => acc.add(m), Money.zero(like.asset, like.decimals))
}

abstract class MemoryReader implements StoreReader {
  /** The state reads run against: committed state, or a transaction's draft. */
  protected abstract snapshot(): State

  protected check(): void {}

  async getMovement(tenantId: string, id: string): Promise<Movement | null> {
    this.check()
    const m = this.snapshot().movements.get(id)
    return m !== undefined && m.tenantId === tenantId ? m : null
  }

  async listMovements(q: MovementQuery): Promise<Movement[]> {
    this.check()
    const out: Movement[] = []
    for (const m of this.snapshot().movements.values()) {
      if (m.tenantId !== q.tenantId) continue
      if (q.disposition !== undefined && m.disposition !== q.disposition) continue
      if (q.account !== undefined && m.account !== q.account) continue
      if (q.afterSeq !== undefined && m.seq <= q.afterSeq) continue
      out.push(m)
    }
    out.sort((a, b) => a.seq - b.seq)
    return q.limit === undefined ? out : out.slice(0, q.limit)
  }

  async getExpectation(tenantId: string, id: string): Promise<Expectation | null> {
    this.check()
    const e = this.snapshot().expectations.get(id)
    return e !== undefined && e.tenantId === tenantId ? e : null
  }

  async getExpectationByReference(tenantId: string, reference: string): Promise<Expectation | null> {
    this.check()
    const id = this.snapshot().expectationRefs.get(key(tenantId, reference))
    return id === undefined ? null : (this.snapshot().expectations.get(id) ?? null)
  }

  async listExpectations(q: ExpectationQuery): Promise<Expectation[]> {
    this.check()
    const out: Expectation[] = []
    for (const e of this.snapshot().expectations.values()) {
      if (e.tenantId !== q.tenantId) continue
      if (q.account !== undefined && e.account !== q.account) continue
      if (q.asset !== undefined && e.amount.asset !== q.asset) continue
      if (q.direction !== undefined && e.direction !== q.direction) continue
      if (q.status !== undefined && !q.status.includes(e.status)) continue
      if (q.muxedId !== undefined && e.muxedId !== q.muxedId) continue
      out.push(e)
      if (q.limit !== undefined && out.length >= q.limit) break
    }
    return out
  }

  async listAllocations(q: AllocationQuery): Promise<Allocation[]> {
    this.check()
    const out: Allocation[] = []
    for (const a of this.snapshot().allocations.values()) {
      if (a.tenantId !== q.tenantId) continue
      if (q.movementId !== undefined && a.movementId !== q.movementId) continue
      if (q.expectationId !== undefined && a.expectationId !== q.expectationId) continue
      out.push(a)
    }
    return out
  }

  async getException(tenantId: string, id: string): Promise<ExceptionRecord | null> {
    this.check()
    const e = this.snapshot().exceptions.get(id)
    return e !== undefined && e.tenantId === tenantId ? e : null
  }

  async listExceptions(q: ExceptionQuery): Promise<ExceptionRecord[]> {
    this.check()
    const out: ExceptionRecord[] = []
    for (const e of this.snapshot().exceptions.values()) {
      if (e.tenantId !== q.tenantId) continue
      if (q.status !== undefined && e.status !== q.status) continue
      if (q.code !== undefined && e.code !== q.code) continue
      if (q.movementId !== undefined && e.movementId !== q.movementId) continue
      if (q.expectationId !== undefined && e.expectationId !== q.expectationId) continue
      out.push(e)
      if (q.limit !== undefined && out.length >= q.limit) break
    }
    return out
  }

  async getCursor(k: CursorKey): Promise<string | null> {
    this.check()
    return this.snapshot().cursors.get(cursorKey(k)) ?? null
  }
}

class MemoryTx extends MemoryReader implements StoreTx {
  private open = true

  constructor(
    readonly draft: State,
    private readonly ids: () => string,
    private readonly now: () => Date,
  ) {
    super()
  }

  protected snapshot(): State {
    return this.draft
  }

  close(): void {
    this.open = false
  }

  protected override check(): void {
    if (!this.open) throw new TransactionClosedError()
  }

  private movement(tenantId: string, id: string): Movement {
    const m = this.draft.movements.get(id)
    if (m === undefined || m.tenantId !== tenantId) throw new NotFoundError('movement', id)
    return m
  }

  private expectation(tenantId: string, id: string): Expectation {
    const e = this.draft.expectations.get(id)
    if (e === undefined || e.tenantId !== tenantId) throw new NotFoundError('expectation', id)
    return e
  }

  private allocationsOf(field: 'movementId' | 'expectationId', id: string): Allocation[] {
    return [...this.draft.allocations.values()].filter((a) => a[field] === id)
  }

  async insertMovements(batch: readonly NewMovement[]): Promise<InsertMovementsResult> {
    this.check()
    batch.forEach(assertValidNewMovement)
    const inserted: Movement[] = []
    const duplicates: Movement[] = []
    const conflicts: MovementConflict[] = []
    for (const n of batch) {
      const candidate: Movement = Object.freeze({
        id: '',
        tenantId: n.tenantId,
        seq: 0,
        network: n.network,
        source: n.source,
        externalId: n.externalId,
        revision: n.revision ?? 1,
        account: n.account,
        direction: n.direction,
        kind: n.kind,
        amount: n.amount,
        counterparty: n.counterparty ?? null,
        muxedId: n.muxedId ?? null,
        memo: n.memo == null ? null : Object.freeze({ ...n.memo }),
        ledger: n.ledger,
        txHash: n.txHash,
        operationId: n.operationId ?? null,
        occurredAt: copyDate(n.occurredAt),
        enrichment: n.enrichment ?? 'complete',
        disposition: 'pending',
        ignoredReason: null,
        createdAt: this.now(),
      })
      const k = movementKey(n)
      const existingId = this.draft.movementKeys.get(k)
      if (existingId !== undefined) {
        const existing = this.draft.movements.get(existingId)!
        if (sameFacts(existing, candidate)) duplicates.push(existing)
        else conflicts.push({ existing, incoming: n })
        continue
      }
      const movement: Movement = Object.freeze({
        ...candidate,
        id: this.ids(),
        seq: ++this.draft.seq,
      })
      this.draft.movements.set(movement.id, movement)
      this.draft.movementKeys.set(k, movement.id)
      inserted.push(movement)
    }
    return { inserted, duplicates, conflicts }
  }

  async setDisposition(
    tenantId: string,
    movementId: string,
    disposition: Disposition,
    reason?: string,
  ): Promise<Movement> {
    this.check()
    const m = this.movement(tenantId, movementId)
    const allocated = sum(
      this.allocationsOf('movementId', m.id).map((a) => a.amount),
      m.amount,
    )
    const exceptions = [...this.draft.exceptions.values()].filter((e) => e.movementId === m.id)
    const refuse = (why: string): never => {
      throw new ConstraintError('disposition_unsupported', `cannot mark movement ${m.id} ${disposition}: ${why}`)
    }
    switch (disposition) {
      case 'pending':
        if (!allocated.isZero()) refuse('it already has allocations')
        break
      case 'allocated':
        if (!allocated.equals(m.amount)) {
          refuse(`allocations total ${allocated.toString()} of ${m.amount.toString()}`)
        }
        break
      case 'partial':
        if (allocated.isZero() || allocated.equals(m.amount)) {
          refuse(`allocations total ${allocated.toString()} of ${m.amount.toString()}`)
        }
        if (!exceptions.some((e) => e.status === 'open')) {
          refuse('no open exception covers the unallocated residual')
        }
        break
      case 'exception':
        if (exceptions.length === 0) refuse('it has no exceptions')
        break
      case 'ignored':
        if (reason === undefined || reason.trim() === '') refuse('a reason is required')
        break
      default:
        throw new ValidationError('disposition', `unknown disposition ${JSON.stringify(disposition)}`)
    }
    const next: Movement = Object.freeze({
      ...m,
      disposition,
      ignoredReason: disposition === 'ignored' ? reason! : null,
    })
    this.draft.movements.set(next.id, next)
    return next
  }

  async setCursor(k: CursorKey, value: string): Promise<void> {
    this.check()
    if (typeof value !== 'string' || value === '') {
      throw new ValidationError('cursor', 'must be a non-empty string')
    }
    this.draft.cursors.set(cursorKey(k), value)
  }

  async insertExpectation(n: NewExpectation): Promise<Expectation> {
    this.check()
    assertValidNewExpectation(n)
    const refKey = key(n.tenantId, n.reference)
    if (this.draft.expectationRefs.has(refKey)) {
      throw new ConstraintError(
        'expectation_reference_unique',
        `reference ${JSON.stringify(n.reference)} already exists in this tenant`,
      )
    }
    const now = this.now()
    const expectation: Expectation = Object.freeze({
      id: this.ids(),
      tenantId: n.tenantId,
      reference: n.reference,
      account: n.account,
      direction: n.direction ?? 'credit',
      amount: n.amount,
      muxedId: n.muxedId ?? null,
      memo: n.memo == null ? null : Object.freeze({ ...n.memo }),
      payers: Object.freeze([...(n.payers ?? [])]),
      dueAt: n.dueAt == null ? null : copyDate(n.dueAt),
      expiresAt: n.expiresAt == null ? null : copyDate(n.expiresAt),
      status: 'open',
      cancelReason: null,
      metadata: Object.freeze({ ...(n.metadata ?? {}) }),
      createdAt: now,
      updatedAt: now,
    })
    this.draft.expectations.set(expectation.id, expectation)
    this.draft.expectationRefs.set(refKey, expectation.id)
    return expectation
  }

  async cancelExpectation(tenantId: string, id: string, reason: string): Promise<Expectation> {
    this.check()
    const e = this.expectation(tenantId, id)
    if (typeof reason !== 'string' || reason.trim() === '') {
      throw new ValidationError('reason', 'must be a non-empty string')
    }
    if (e.status === 'cancelled') {
      throw new ConstraintError('expectation_not_open', `expectation ${id} is already cancelled`)
    }
    if (e.status !== 'open') {
      throw new ConstraintError(
        'expectation_has_allocations',
        `expectation ${id} is ${e.status}; reverse its allocations before cancelling`,
      )
    }
    const next: Expectation = Object.freeze({
      ...e,
      status: 'cancelled',
      cancelReason: reason,
      updatedAt: this.now(),
    })
    this.draft.expectations.set(id, next)
    return next
  }

  async allocate(n: NewAllocation): Promise<Allocation> {
    this.check()
    assertValidNewAllocation(n)
    const m = this.movement(n.tenantId, n.movementId)
    const e = this.expectation(n.tenantId, n.expectationId)

    if (e.status === 'cancelled') {
      throw new ConstraintError('allocation_expectation_cancelled', `expectation ${e.id} is cancelled`)
    }
    for (const [label, other] of [
      ['movement', m.amount],
      ['expectation', e.amount],
    ] as const) {
      if (n.amount.asset !== other.asset || n.amount.decimals !== other.decimals) {
        const lookalike = isSameCodeDifferentIssuer(n.amount.asset, other.asset)
          ? ' (same code, different issuer: a lookalike asset)'
          : ''
        throw new ConstraintError(
          'allocation_asset',
          `allocation is in ${n.amount.asset} but the ${label} is in ${other.asset}${lookalike}`,
        )
      }
    }
    if (m.direction !== e.direction) {
      throw new ConstraintError(
        'allocation_direction',
        `a ${m.direction} movement cannot settle a ${e.direction} expectation`,
      )
    }

    const onMovement = this.allocationsOf('movementId', m.id)
    if (onMovement.some((a) => a.expectationId === e.id)) {
      throw new ConstraintError(
        'allocation_unique',
        `movement ${m.id} is already allocated to expectation ${e.id}`,
      )
    }
    const movementTotal = sum(onMovement.map((a) => a.amount), m.amount).add(n.amount)
    if (movementTotal.compare(m.amount) > 0) {
      throw new ConstraintError(
        'allocation_over_movement',
        `would allocate ${movementTotal.toString()} of a ${m.amount.toString()} movement`,
      )
    }
    const onExpectation = this.allocationsOf('expectationId', e.id)
    const expectationTotal = sum(onExpectation.map((a) => a.amount), e.amount).add(n.amount)
    if (expectationTotal.compare(e.amount) > 0) {
      throw new ConstraintError(
        'allocation_over_expectation',
        `would allocate ${expectationTotal.toString()} against ${e.amount.toString()} expected`,
      )
    }

    const now = this.now()
    const allocation: Allocation = Object.freeze({
      id: this.ids(),
      tenantId: n.tenantId,
      movementId: m.id,
      expectationId: e.id,
      amount: n.amount,
      strategy: n.strategy,
      score: n.score ?? null,
      createdAt: now,
    })
    this.draft.allocations.set(allocation.id, allocation)
    this.draft.expectations.set(
      e.id,
      Object.freeze({
        ...e,
        status: expectationTotal.equals(e.amount) ? 'settled' : 'partially_paid',
        updatedAt: now,
      }),
    )
    return allocation
  }

  async openException(n: NewException): Promise<ExceptionRecord> {
    this.check()
    assertValidNewException(n)
    if (n.movementId != null) this.movement(n.tenantId, n.movementId)
    if (n.expectationId != null) this.expectation(n.tenantId, n.expectationId)
    const record: ExceptionRecord = Object.freeze({
      id: this.ids(),
      tenantId: n.tenantId,
      code: n.code,
      status: 'open',
      movementId: n.movementId ?? null,
      expectationId: n.expectationId ?? null,
      account: n.account ?? null,
      amount: n.amount ?? null,
      detail: n.detail,
      evidence: n.evidence ?? null,
      openedAt: this.now(),
      resolvedAt: null,
      resolutionNote: null,
    })
    this.draft.exceptions.set(record.id, record)
    return record
  }

  async resolveException(tenantId: string, id: string, resolution: Resolution): Promise<ExceptionRecord> {
    this.check()
    const e = this.draft.exceptions.get(id)
    if (e === undefined || e.tenantId !== tenantId) throw new NotFoundError('exception', id)
    if (resolution.status !== 'resolved' && resolution.status !== 'dismissed') {
      throw new ValidationError('status', 'must be "resolved" or "dismissed"')
    }
    if (typeof resolution.note !== 'string' || resolution.note.trim() === '') {
      throw new ValidationError('note', 'must be a non-empty string')
    }
    if (e.status !== 'open') {
      throw new ConstraintError('exception_not_open', `exception ${id} is already ${e.status}`)
    }
    const next: ExceptionRecord = Object.freeze({
      ...e,
      status: resolution.status,
      resolvedAt: this.now(),
      resolutionNote: resolution.note,
    })
    this.draft.exceptions.set(id, next)
    return next
  }
}

export class MemoryStore extends MemoryReader implements Store {
  private committed: State = emptyState()
  private tail: Promise<unknown> = Promise.resolve()
  private readonly ids: () => string
  private readonly now: () => Date

  constructor(options: MemoryStoreOptions = {}) {
    super()
    this.ids = options.ids ?? (() => globalThis.crypto.randomUUID())
    this.now = options.now ?? (() => new Date())
  }

  protected snapshot(): State {
    return this.committed
  }

  transaction<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T> {
    const run = this.tail.then(async () => {
      const tx = new MemoryTx(cloneState(this.committed), this.ids, this.now)
      try {
        const result = await fn(tx)
        this.committed = tx.draft
        return result
      } finally {
        tx.close()
      }
    })
    // The next transaction waits for this one whether it commits or not.
    this.tail = run.catch(() => undefined)
    return run
  }

  async close(): Promise<void> {}
}
