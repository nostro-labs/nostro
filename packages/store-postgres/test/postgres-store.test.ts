/**
 * Runs the shared Store conformance suite against a real PostgreSQL.
 *
 * Set NOSTRO_TEST_DATABASE_URL to a database the tests may create schemas
 * in; each test gets a fresh schema, dropped afterwards. Without it the suite
 * is skipped locally and fails in CI.
 */
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, describe, expect, it } from 'vitest'
import { Money, NATIVE } from 'nostro'
import { describeStoreConformance } from 'nostro-testkit'
import { PostgresStore } from '../src/index.js'

const url = process.env.NOSTRO_TEST_DATABASE_URL
if (url === undefined && process.env.CI !== undefined) {
  throw new Error('NOSTRO_TEST_DATABASE_URL must be set in CI; the Postgres store would go untested.')
}

const pool = url === undefined ? undefined : new pg.Pool({ connectionString: url, max: 20 })
const schemas: string[] = []

async function freshStore(options: { schema?: string } = {}): Promise<PostgresStore> {
  const schema = options.schema ?? `nostro_test_${randomUUID().replaceAll('-', '').slice(0, 16)}`
  schemas.push(schema)
  const store = new PostgresStore({ pool: pool!, schema })
  await store.migrate()
  return store
}

afterAll(async () => {
  if (pool === undefined) return
  for (const schema of new Set(schemas)) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
  await pool.end()
})

if (pool === undefined) {
  describe.skip('PostgresStore (set NOSTRO_TEST_DATABASE_URL to run)', () => {
    it('conformance', () => {})
  })
} else {
  describeStoreConformance('PostgresStore', () => freshStore())

  describe('PostgresStore', () => {
    it('migrates idempotently, even when several processes migrate at once', async () => {
      const schema = `nostro_test_${randomUUID().replaceAll('-', '').slice(0, 16)}`
      await Promise.all([1, 2, 3].map(() => freshStore({ schema })))
      await freshStore({ schema })
      const { rows } = await pool.query(`SELECT version FROM "${schema}".migrations ORDER BY version`)
      expect(rows.map((r) => r.version)).toEqual([1])
    })

    it('keeps amounts exact beyond 64 bits', async () => {
      const store = await freshStore()
      const huge = Money.fromRaw(2n ** 100n + 7n, NATIVE)
      const e = await store.transaction((tx) =>
        tx.insertExpectation({ tenantId: 't', reference: 'R', account: `G${'A'.repeat(55)}`, amount: huge }),
      )
      expect((await store.getExpectation('t', e.id))!.amount.raw).toBe(2n ** 100n + 7n)
    })

    it('enforces the hard constraints in the database too, not only in code', async () => {
      const store = await freshStore()
      const s = schemas[schemas.length - 1]!
      await expect(
        pool.query(
          `INSERT INTO "${s}".expectations (id, tenant_id, reference, account, direction, asset, decimals,
             amount, payers, status, metadata, created_at, updated_at)
           VALUES ('x', 't', 'r', 'a', 'credit', 'native', 7, 0, '{}', 'open', '{}', now(), now())`,
        ),
      ).rejects.toThrow(/check constraint/)
      expect(await store.listExpectations({ tenantId: 't' })).toEqual([])
    })

    it('reports a reference taken by a concurrent transaction, and leaves this one usable', async () => {
      const store = await freshStore()
      const insert = (tx: Parameters<Parameters<PostgresStore['transaction']>[0]>[0]) =>
        tx.insertExpectation({ tenantId: 't', reference: 'INV-RACE', account: `G${'A'.repeat(55)}`, amount: Money.parse('1', NATIVE) })
      let release!: () => void
      const held = new Promise<void>((r) => (release = r))
      const first = store.transaction(async (tx) => {
        await insert(tx)
        await held // keep the row uncommitted while the second transaction tries
      })
      await new Promise((r) => setTimeout(r, 50))
      const second = store.transaction(async (tx) => {
        // The pre-check cannot see the uncommitted row; the unique index must catch it.
        const attempt = insert(tx).catch((e: unknown) => e)
        setTimeout(release, 50)
        const err = await attempt
        await tx.setCursor({ tenantId: 't', network: 'n', source: 's', account: 'a' }, 'still-usable')
        return err
      })
      await first
      expect(await second).toMatchObject({ name: 'ConstraintError', constraint: 'expectation_reference_unique' })
      expect(await store.getCursor({ tenantId: 't', network: 'n', source: 's', account: 'a' })).toBe('still-usable')
    })

    it('rejects a schema name that is not a plain identifier', () => {
      expect(() => new PostgresStore({ pool: pool!, schema: 'x"; DROP TABLE y; --' })).toThrow(/Invalid schema name/)
      expect(() => new PostgresStore({})).toThrow(/needs a pool or a connectionString/)
    })

    it('owns and ends a pool it created from a connection string', async () => {
      const store = new PostgresStore({ connectionString: url!, schema: 'unused' })
      await store.close()
      await expect(store.getCursor({ tenantId: 't', network: 'n', source: 's', account: 'a' })).rejects.toThrow()
    })
  })
}
