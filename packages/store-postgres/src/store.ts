/**
 * A `Store` on PostgreSQL.
 *
 * Every rule comes from `nostro`'s shared store rules; this file only makes
 * the reads those rules depend on safe under concurrency. Rows a write
 * depends on are locked with `SELECT … FOR UPDATE` inside the transaction, so
 * two workers allocating against one expectation serialise on its row, and
 * a cursor read inside a transaction locks the cursor's row (creating it if
 * absent) until that transaction ends.
 *
 * Isolation is PostgreSQL's default, READ COMMITTED. Statements after a lock
 * wait see what the other transaction committed, which is exactly what the
 * over-allocation and compare-and-set checks need.
 */
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import type { Pool, PoolClient, QueryResultRow } from 'pg'
import type {
  Allocation,
  AllocationQuery,
  CursorKey,
  Disposition,
  ExceptionQuery,
  ExceptionRecord,
  Expectation,
  ExpectationQuery,
  InsertMovementsResult,
  Movement,
  MovementConflict,
  MovementQuery,
  NewAllocation,
  NewException,
  NewExpectation,
  NewMovement,
  Resolution,
  Store,
  StoreReader,
  StoreTx,
} from 'nostro'
import {
  ConstraintError,
  NotFoundError,
  TransactionClosedError,
  assertValidNewAllocation,
  assertValidNewException,
  assertValidNewExpectation,
  assertValidNewMovement,
  checkAllocation,
  checkCancel,
  checkCursorValue,
  checkDisposition,
  checkResolution,
  sameFacts,
} from 'nostro'
import type { AllocationRow, ExceptionRow, ExpectationRow, MovementRow } from './rows.js'
import { memoColumns, toAllocation, toException, toExpectation, toMovement } from './rows.js'
import { MIGRATIONS, quoteSchema } from './schema.js'

export interface PostgresStoreOptions {
  /** A pool you own. The store never ends it. */
  readonly pool?: Pool
  /** Or a connection string; the store creates a pool and ends it on `close()`. */
  readonly connectionString?: string
  /** PostgreSQL schema holding nostro's tables. Default `nostro`. */
  readonly schema?: string
  /** Id generator. Defaults to `crypto.randomUUID()`. */
  readonly ids?: () => string
  /** Clock for `createdAt` and friends. Defaults to `new Date()`. */
  readonly now?: () => Date
}

type Run = <R extends QueryResultRow>(sql: string, params?: readonly unknown[]) => Promise<R[]>

/** Builds `WHERE` clauses with numbered parameters. */
class Where {
  readonly params: unknown[] = []
  private readonly clauses: string[] = []

  add(sql: (p: string) => string, value: unknown): this {
    if (value !== undefined) {
      this.params.push(value)
      this.clauses.push(sql(`$${this.params.length}`))
    }
    return this
  }

  limit(n: number | undefined): string {
    if (n === undefined) return ''
    this.params.push(n)
    return ` LIMIT $${this.params.length}`
  }

  toString(): string {
    return this.clauses.length === 0 ? '' : ` WHERE ${this.clauses.join(' AND ')}`
  }
}

class PgReader implements StoreReader {
  constructor(
    protected readonly s: string,
    protected readonly run: Run,
  ) {}

  async getMovement(tenantId: string, id: string): Promise<Movement | null> {
    const [row] = await this.run<MovementRow>(
      `SELECT * FROM ${this.s}.movements WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id],
    )
    return row === undefined ? null : toMovement(row)
  }

  async listMovements(q: MovementQuery): Promise<Movement[]> {
    const w = new Where()
      .add((p) => `tenant_id = ${p}`, q.tenantId)
      .add((p) => `disposition = ${p}`, q.disposition)
      .add((p) => `account = ${p}`, q.account)
      .add((p) => `seq > ${p}`, q.afterSeq)
    const sql = `SELECT * FROM ${this.s}.movements${w} ORDER BY seq${w.limit(q.limit)}`
    return (await this.run<MovementRow>(sql, w.params)).map(toMovement)
  }

  async getExpectation(tenantId: string, id: string): Promise<Expectation | null> {
    const [row] = await this.run<ExpectationRow>(
      `SELECT * FROM ${this.s}.expectations WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id],
    )
    return row === undefined ? null : toExpectation(row)
  }

  async getExpectationByReference(tenantId: string, reference: string): Promise<Expectation | null> {
    const [row] = await this.run<ExpectationRow>(
      `SELECT * FROM ${this.s}.expectations WHERE tenant_id = $1 AND reference = $2`,
      [tenantId, reference],
    )
    return row === undefined ? null : toExpectation(row)
  }

  async listExpectations(q: ExpectationQuery): Promise<Expectation[]> {
    const w = new Where()
      .add((p) => `tenant_id = ${p}`, q.tenantId)
      .add((p) => `account = ${p}`, q.account)
      .add((p) => `asset = ${p}`, q.asset)
      .add((p) => `direction = ${p}`, q.direction)
      .add((p) => `status = ANY(${p})`, q.status === undefined ? undefined : [...q.status])
      .add((p) => `muxed_id = ${p}`, q.muxedId === undefined ? undefined : q.muxedId.toString())
    const sql = `SELECT * FROM ${this.s}.expectations${w} ORDER BY seq${w.limit(q.limit)}`
    return (await this.run<ExpectationRow>(sql, w.params)).map(toExpectation)
  }

  async listAllocations(q: AllocationQuery): Promise<Allocation[]> {
    const w = new Where()
      .add((p) => `tenant_id = ${p}`, q.tenantId)
      .add((p) => `movement_id = ${p}`, q.movementId)
      .add((p) => `expectation_id = ${p}`, q.expectationId)
    return (await this.run<AllocationRow>(`SELECT * FROM ${this.s}.allocations${w} ORDER BY seq`, w.params)).map(
      toAllocation,
    )
  }

  async getException(tenantId: string, id: string): Promise<ExceptionRecord | null> {
    const [row] = await this.run<ExceptionRow>(
      `SELECT * FROM ${this.s}.exceptions WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id],
    )
    return row === undefined ? null : toException(row)
  }

  async listExceptions(q: ExceptionQuery): Promise<ExceptionRecord[]> {
    const w = new Where()
      .add((p) => `tenant_id = ${p}`, q.tenantId)
      .add((p) => `status = ${p}`, q.status)
      .add((p) => `code = ${p}`, q.code)
      .add((p) => `movement_id = ${p}`, q.movementId)
      .add((p) => `expectation_id = ${p}`, q.expectationId)
    const sql = `SELECT * FROM ${this.s}.exceptions${w} ORDER BY seq${w.limit(q.limit)}`
    return (await this.run<ExceptionRow>(sql, w.params)).map(toException)
  }

  async getCursor(k: CursorKey): Promise<string | null> {
    const [row] = await this.run<{ value: string | null }>(
      `SELECT value FROM ${this.s}.cursors WHERE tenant_id = $1 AND network = $2 AND source = $3 AND account = $4`,
      [k.tenantId, k.network, k.source, k.account],
    )
    return row?.value ?? null
  }
}

const isUniqueViolation = (err: unknown, constraint: string): boolean =>
  err instanceof Error &&
  (err as { code?: string }).code === '23505' &&
  (err as { constraint?: string }).constraint === constraint

class PgTx extends PgReader implements StoreTx {
  private open = true
  private savepoints = 0

  constructor(
    s: string,
    client: PoolClient,
    private readonly ids: () => string,
    private readonly now: () => Date,
  ) {
    super(s, async (sql, params) => {
      if (!this.open) throw new TransactionClosedError()
      return (await client.query(sql, params === undefined ? undefined : [...params])).rows
    })
  }

  close(): void {
    this.open = false
  }

  private async lockMovement(tenantId: string, id: string): Promise<Movement> {
    const [row] = await this.run<MovementRow>(
      `SELECT * FROM ${this.s}.movements WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [tenantId, id],
    )
    if (row === undefined) throw new NotFoundError('movement', id)
    return toMovement(row)
  }

  private async lockExpectation(tenantId: string, id: string): Promise<Expectation> {
    const [row] = await this.run<ExpectationRow>(
      `SELECT * FROM ${this.s}.expectations WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [tenantId, id],
    )
    if (row === undefined) throw new NotFoundError('expectation', id)
    return toExpectation(row)
  }

  /** A locking read: the cursor row is created if absent, then held until the transaction ends. */
  override async getCursor(k: CursorKey): Promise<string | null> {
    const params = [k.tenantId, k.network, k.source, k.account]
    await this.run(
      `INSERT INTO ${this.s}.cursors (tenant_id, network, source, account, value)
       VALUES ($1, $2, $3, $4, NULL) ON CONFLICT DO NOTHING`,
      params,
    )
    const [row] = await this.run<{ value: string | null }>(
      `SELECT value FROM ${this.s}.cursors
       WHERE tenant_id = $1 AND network = $2 AND source = $3 AND account = $4 FOR UPDATE`,
      params,
    )
    return row?.value ?? null
  }

  async setCursor(k: CursorKey, value: string): Promise<void> {
    checkCursorValue(value)
    await this.run(
      `INSERT INTO ${this.s}.cursors (tenant_id, network, source, account, value) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, network, source, account) DO UPDATE SET value = EXCLUDED.value`,
      [k.tenantId, k.network, k.source, k.account, value],
    )
  }

  async insertMovements(batch: readonly NewMovement[]): Promise<InsertMovementsResult> {
    batch.forEach(assertValidNewMovement)
    const inserted: Movement[] = []
    const duplicates: Movement[] = []
    const conflicts: MovementConflict[] = []
    for (const n of batch) {
      const [memoType, memoValue, memoText] = memoColumns(n.memo)
      const [row] = await this.run<MovementRow>(
        `INSERT INTO ${this.s}.movements (
           id, tenant_id, network, source, external_id, revision, account, direction, kind,
           asset, decimals, amount, counterparty, muxed_id, memo_type, memo_value, memo_text,
           ledger, tx_hash, operation_id, occurred_at, enrichment, disposition, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
                   $18, $19, $20, $21, $22, 'pending', $23)
         ON CONFLICT ON CONSTRAINT movements_dedupe DO NOTHING
         RETURNING *`,
        [
          this.ids(),
          n.tenantId,
          n.network,
          n.source,
          n.externalId,
          n.revision ?? 1,
          n.account,
          n.direction,
          n.kind,
          n.amount.asset,
          n.amount.decimals,
          n.amount.raw.toString(),
          n.counterparty ?? null,
          n.muxedId == null ? null : n.muxedId.toString(),
          memoType,
          memoValue,
          memoText,
          n.ledger,
          n.txHash ?? null,
          n.operationId ?? null,
          n.occurredAt,
          n.enrichment ?? 'complete',
          this.now(),
        ],
      )
      if (row !== undefined) {
        inserted.push(toMovement(row))
        continue
      }
      const [existingRow] = await this.run<MovementRow>(
        `SELECT * FROM ${this.s}.movements
         WHERE tenant_id = $1 AND network = $2 AND source = $3 AND external_id = $4`,
        [n.tenantId, n.network, n.source, n.externalId],
      )
      const existing = toMovement(existingRow!)
      if (sameFacts(existing, n)) duplicates.push(existing)
      else conflicts.push({ existing, incoming: n })
    }
    return { inserted, duplicates, conflicts }
  }

  async setDisposition(
    tenantId: string,
    movementId: string,
    disposition: Disposition,
    reason?: string,
  ): Promise<Movement> {
    const m = await this.lockMovement(tenantId, movementId)
    const allocations = await this.listAllocations({ tenantId, movementId })
    const exceptions = await this.listExceptions({ tenantId, movementId })
    checkDisposition(m, allocations, exceptions, disposition, reason)
    const [row] = await this.run<MovementRow>(
      `UPDATE ${this.s}.movements SET disposition = $3, ignored_reason = $4
       WHERE tenant_id = $1 AND id = $2 RETURNING *`,
      [tenantId, movementId, disposition, disposition === 'ignored' ? reason! : null],
    )
    return toMovement(row!)
  }

  async insertExpectation(n: NewExpectation): Promise<Expectation> {
    assertValidNewExpectation(n)
    const taken = () =>
      new ConstraintError(
        'expectation_reference_unique',
        `reference ${JSON.stringify(n.reference)} already exists in this tenant`,
      )
    if ((await this.getExpectationByReference(n.tenantId, n.reference)) !== null) throw taken()

    const [memoType, memoValue, memoText] = memoColumns(n.memo)
    const now = this.now()
    // A concurrent insert of the same reference surfaces as a unique
    // violation; the savepoint keeps this transaction usable afterwards.
    const savepoint = `nostro_${++this.savepoints}`
    await this.run(`SAVEPOINT ${savepoint}`)
    try {
      const [row] = await this.run<ExpectationRow>(
        `INSERT INTO ${this.s}.expectations (
           id, tenant_id, reference, account, direction, asset, decimals, amount, muxed_id,
           memo_type, memo_value, memo_text, payers, due_at, expires_at, status, metadata,
           created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 'open', $16, $17, $17)
         RETURNING *`,
        [
          this.ids(),
          n.tenantId,
          n.reference,
          n.account,
          n.direction ?? 'credit',
          n.amount.asset,
          n.amount.decimals,
          n.amount.raw.toString(),
          n.muxedId == null ? null : n.muxedId.toString(),
          memoType,
          memoValue,
          memoText,
          [...(n.payers ?? [])],
          n.dueAt ?? null,
          n.expiresAt ?? null,
          JSON.stringify(n.metadata ?? {}),
          now,
        ],
      )
      await this.run(`RELEASE SAVEPOINT ${savepoint}`)
      return toExpectation(row!)
    } catch (err) {
      await this.run(`ROLLBACK TO SAVEPOINT ${savepoint}`)
      if (isUniqueViolation(err, 'expectations_reference_unique')) throw taken()
      throw err
    }
  }

  async cancelExpectation(tenantId: string, id: string, reason: string): Promise<Expectation> {
    const e = await this.lockExpectation(tenantId, id)
    checkCancel(e, reason)
    const [row] = await this.run<ExpectationRow>(
      `UPDATE ${this.s}.expectations SET status = 'cancelled', cancel_reason = $3, updated_at = $4
       WHERE tenant_id = $1 AND id = $2 RETURNING *`,
      [tenantId, id, reason, this.now()],
    )
    return toExpectation(row!)
  }

  async allocate(n: NewAllocation): Promise<Allocation> {
    assertValidNewAllocation(n)
    // Lock order is always movement, then expectation.
    const m = await this.lockMovement(n.tenantId, n.movementId)
    const e = await this.lockExpectation(n.tenantId, n.expectationId)
    const status = checkAllocation(
      n,
      m,
      e,
      await this.listAllocations({ tenantId: n.tenantId, movementId: m.id }),
      await this.listAllocations({ tenantId: n.tenantId, expectationId: e.id }),
    )
    const now = this.now()
    const [row] = await this.run<AllocationRow>(
      `INSERT INTO ${this.s}.allocations (
         id, tenant_id, movement_id, expectation_id, asset, decimals, amount, strategy, score, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [
        this.ids(),
        n.tenantId,
        m.id,
        e.id,
        n.amount.asset,
        n.amount.decimals,
        n.amount.raw.toString(),
        n.strategy,
        n.score ?? null,
        now,
      ],
    )
    await this.run(`UPDATE ${this.s}.expectations SET status = $2, updated_at = $3 WHERE id = $1`, [
      e.id,
      status,
      now,
    ])
    return toAllocation(row!)
  }

  async openException(n: NewException): Promise<ExceptionRecord> {
    assertValidNewException(n)
    if (n.movementId != null && (await this.getMovement(n.tenantId, n.movementId)) === null) {
      throw new NotFoundError('movement', n.movementId)
    }
    if (n.expectationId != null && (await this.getExpectation(n.tenantId, n.expectationId)) === null) {
      throw new NotFoundError('expectation', n.expectationId)
    }
    const [row] = await this.run<ExceptionRow>(
      `INSERT INTO ${this.s}.exceptions (
         id, tenant_id, code, status, movement_id, expectation_id, account, asset, decimals, amount,
         detail, evidence, opened_at
       ) VALUES ($1, $2, $3, 'open', $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
      [
        this.ids(),
        n.tenantId,
        n.code,
        n.movementId ?? null,
        n.expectationId ?? null,
        n.account ?? null,
        n.amount?.asset ?? null,
        n.amount?.decimals ?? null,
        n.amount == null ? null : n.amount.raw.toString(),
        n.detail,
        JSON.stringify(n.evidence ?? null),
        this.now(),
      ],
    )
    return toException(row!)
  }

  async resolveException(tenantId: string, id: string, resolution: Resolution): Promise<ExceptionRecord> {
    const [current] = await this.run<ExceptionRow>(
      `SELECT * FROM ${this.s}.exceptions WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [tenantId, id],
    )
    if (current === undefined) throw new NotFoundError('exception', id)
    checkResolution(toException(current), resolution)
    const [row] = await this.run<ExceptionRow>(
      `UPDATE ${this.s}.exceptions SET status = $3, resolved_at = $4, resolution_note = $5
       WHERE tenant_id = $1 AND id = $2 RETURNING *`,
      [tenantId, id, resolution.status, this.now(), resolution.note],
    )
    return toException(row!)
  }
}

export class PostgresStore extends PgReader implements Store {
  private readonly pool: Pool
  private readonly ownsPool: boolean
  private readonly schema: string
  private readonly ids: () => string
  private readonly now: () => Date

  constructor(options: PostgresStoreOptions) {
    if (options.pool === undefined && options.connectionString === undefined) {
      throw new Error('PostgresStore needs a pool or a connectionString.')
    }
    const pool = options.pool ?? new pg.Pool({ connectionString: options.connectionString })
    const schema = options.schema ?? 'nostro'
    super(quoteSchema(schema), async (sql, params) =>
      (await pool.query(sql, params === undefined ? undefined : [...params])).rows,
    )
    this.pool = pool
    this.ownsPool = options.pool === undefined
    this.schema = schema
    this.ids = options.ids ?? randomUUID
    this.now = options.now ?? (() => new Date())
  }

  /**
   * Create the schema and apply any pending migrations. Safe to call from
   * several processes at once: they serialise on an advisory lock.
   */
  async migrate(): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`nostro:migrate:${this.schema}`])
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${this.s}`)
      await client.query(
        `CREATE TABLE IF NOT EXISTS ${this.s}.migrations (
           version    integer PRIMARY KEY,
           applied_at timestamptz NOT NULL DEFAULT now()
         )`,
      )
      const { rows } = await client.query<{ version: number }>(
        `SELECT coalesce(max(version), 0) AS version FROM ${this.s}.migrations`,
      )
      for (let version = rows[0]!.version + 1; version <= MIGRATIONS.length; version++) {
        await client.query(MIGRATIONS[version - 1]!(this.s))
        await client.query(`INSERT INTO ${this.s}.migrations (version) VALUES ($1)`, [version])
      }
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw err
    } finally {
      client.release()
    }
  }

  async transaction<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    const tx = new PgTx(this.s, client, this.ids, this.now)
    let broken: Error | undefined
    try {
      await client.query('BEGIN')
      const result = await fn(tx)
      tx.close()
      await client.query('COMMIT')
      return result
    } catch (err) {
      tx.close()
      await client.query('ROLLBACK').catch((rollbackError: unknown) => {
        // The connection is unusable; make the pool discard it.
        broken = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError))
      })
      throw err
    } finally {
      tx.close()
      client.release(broken)
    }
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end()
  }
}
