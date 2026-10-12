#!/usr/bin/env node
/**
 * Ingest real accounts end to end and check the result against Horizon.
 *
 *   pnpm build
 *   node scripts/check-balances.mjs [--public] [--journal] <G...> [<G...> ...]
 *
 * For each account this syncs every effect and fee until both feeds are
 * caught up, sums the movements per asset, and compares the sums with the
 * balances Horizon reports. They should agree to the stroop.
 *
 * With --journal it also reconciles every movement (which posts the journal)
 * and checks, per asset, that the journal's cash for the account equals the
 * Horizon balance, that debits equal credits across the whole journal (I3),
 * and that running reconcile and the journal sweep again posts nothing.
 * Journal mode uses a SQLite store in a temporary directory, because it runs
 * one transaction per movement.
 *
 * This only holds for an account whose whole history Horizon still retains:
 * any testnet account (testnet is reset periodically), or a public-network
 * account younger than the retention window. An account that is transacting
 * while this runs can also drift by whatever landed after the last page.
 *
 * Exits non-zero if any account does not match.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  HorizonClient,
  HorizonEffectsSource,
  HorizonFeesSource,
  MemoryStore,
  NATIVE,
  postJournal,
  reconcile,
  signedAmount,
  sync,
} from '../packages/core/dist/index.js'

const args = process.argv.slice(2)
const pub = args.includes('--public')
const journal = args.includes('--journal')
const accounts = args.filter((a) => !a.startsWith('--'))
if (accounts.length === 0) {
  console.error('usage: node scripts/check-balances.mjs [--public] [--journal] <G...> [<G...> ...]')
  process.exit(2)
}

const network = pub ? 'public' : 'testnet'
const tenantId = 'check'
const client = new HorizonClient({
  url: pub ? 'https://horizon.stellar.org' : 'https://horizon-testnet.stellar.org',
})
const { SqliteStore } = journal ? await import('../packages/store-sqlite/dist/index.js') : {}

/** Reconcile until nothing is pending; returns how many journal entries were posted. */
async function reconcileAll(store) {
  let posted = 0
  for (;;) {
    const report = await reconcile({ store, tenantId, limit: 1000 })
    if (report.errors.length > 0) throw report.errors[0].error
    posted += report.journalEntries
    if (report.processed + report.skipped === 0) return posted
  }
}

/** Run the journal sweep over every movement; returns how many entries it posted. */
async function sweepAll(store) {
  let posted = 0
  let afterSeq
  for (;;) {
    const report = await postJournal({ store, tenantId, ...(afterSeq === undefined ? {} : { afterSeq }) })
    if (report.errors.length > 0) throw report.errors[0].error
    posted += report.posted.initial + report.posted.reclass + report.posted.correction
    if (report.lastSeq === null) return posted
    afterSeq = report.lastSeq
  }
}

let failed = false
for (const account of accounts) {
  const dir = journal ? mkdtempSync(join(tmpdir(), 'nostro-check-')) : null
  const store = journal ? new SqliteStore({ filename: join(dir, 'check.db') }) : new MemoryStore()
  if (journal) await store.migrate()
  try {
    for (const source of [new HorizonEffectsSource({ client, network }), new HorizonFeesSource({ client, network })]) {
      for (;;) {
        const report = await sync({ store, source, tenantId, accounts: [account], maxBatches: 20 })
        if (report.errors.length > 0) throw report.errors[0].error
        if (report.accounts[0].caughtUp) break
      }
    }

    const movements = await store.listMovements({ tenantId })
    const net = new Map()
    for (const m of movements) net.set(m.amount.asset, (net.get(m.amount.asset) ?? 0n) + signedAmount(m).raw)

    const cash = new Map()
    const imbalance = new Map()
    const checks = []
    if (journal) {
      const posted = await reconcileAll(store)
      for (const entry of await store.listJournalEntries({ tenantId })) {
        for (const l of entry.lines) {
          const signed = l.side === 'debit' ? l.amount.raw : -l.amount.raw
          imbalance.set(l.amount.asset, (imbalance.get(l.amount.asset) ?? 0n) + signed)
          if (l.role === 'cash') cash.set(l.amount.asset, (cash.get(l.amount.asset) ?? 0n) + signed)
        }
      }
      const unbalanced = [...imbalance].filter(([, v]) => v !== 0n)
      const again = (await reconcileAll(store)) + (await sweepAll(store))
      checks.push([unbalanced.length === 0, `journal: ${posted} entries, debits ${unbalanced.length === 0 ? '=' : '≠'} credits`])
      checks.push([again === 0, `rerun posted ${again} more`])
    }

    const { balances } = await client.get(`/accounts/${account}`)
    const lines = []
    let ok = checks.every(([pass]) => pass)
    for (const b of balances) {
      if (b.asset_type === 'liquidity_pool_shares') continue
      const id = b.asset_type === 'native' ? NATIVE : `${b.asset_code}:${b.asset_issuer}`
      const horizon = BigInt(b.balance.replace('.', ''))
      const ours = net.get(id) ?? 0n
      const books = journal ? (cash.get(id) ?? 0n) : ours
      net.delete(id)
      cash.delete(id)
      const match = horizon === ours && horizon === books
      ok &&= match
      lines.push(
        `  ${id}  horizon ${horizon}  movements ${ours}${journal ? `  journal cash ${books}` : ''}` +
          (match ? '' : '  MISMATCH'),
      )
    }
    for (const [id, raw] of [...net, ...cash]) {
      if (raw === 0n) continue
      ok = false
      lines.push(`  ${id}  no balance on Horizon  nostro ${raw}`)
    }
    failed ||= !ok
    console.log(`${ok ? 'MATCH   ' : 'MISMATCH'} ${account}  ${movements.length} movements`)
    for (const [pass, text] of checks) console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${text}`)
    for (const line of lines) console.log(line)
  } finally {
    await store.close()
    if (dir !== null) rmSync(dir, { recursive: true, force: true })
  }
}
process.exit(failed ? 1 : 0)
