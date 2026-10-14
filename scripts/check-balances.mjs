#!/usr/bin/env node
/**
 * Check real accounts end to end with doctor().
 *
 *   pnpm build
 *   node scripts/check-balances.mjs [--public] [--journal] <G...> [<G...> ...]
 *
 * For each account, in a fresh SQLite store in a temporary directory,
 * doctor() ingests every effect and fee Horizon retains and attests the
 * balances (I2): per asset, the recorded movements must add up to what
 * Horizon reports, as of the ledger that balance last changed in. It also
 * checks every movement's disposition (I1) and journal entry (I3).
 *
 * With --journal it then reconciles every movement (which posts the
 * journal), checks that running reconcile and the journal sweep again posts
 * nothing, and runs doctor() once more over the decided movements and their
 * entries.
 *
 * This only holds for an account whose whole history Horizon still retains:
 * any testnet account (testnet is reset periodically), or a public-network
 * account younger than the retention window.
 *
 * Exits non-zero unless every account comes back clean.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  HorizonBalanceSource,
  HorizonClient,
  HorizonEffectsSource,
  HorizonFeesSource,
  doctor,
  postJournal,
  reconcile,
} from '../packages/core/dist/index.js'
import { SqliteStore } from '../packages/store-sqlite/dist/index.js'

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

const symbol = (asset) => (asset === 'native' ? 'XLM' : asset.slice(0, asset.indexOf(':')))

function summary(report) {
  const { total, byDisposition } = report.movements
  const decided = Object.entries(byDisposition)
    .filter(([, n]) => n > 0)
    .map(([d, n]) => `${d} ${n}`)
    .join(', ')
  const books = report.journal.totals.every((t) => t.debits.equals(t.credits)) ? '=' : '≠'
  return `${total} movements (${decided || 'none'}), ${report.journal.entries} journal entries, debits ${books} credits`
}

let failed = false
for (const account of accounts) {
  const dir = mkdtempSync(join(tmpdir(), 'nostro-check-'))
  const store = new SqliteStore({ filename: join(dir, 'check.db') })
  await store.migrate()
  try {
    const sources = [new HorizonEffectsSource({ client, network }), new HorizonFeesSource({ client, network })]
    const balances = new HorizonBalanceSource({ client, network })
    const reports = [await doctor({ store, tenantId, attest: { balances, sources, accounts: [account] } })]
    const lines = []
    let ok = reports[0].ok
    for (const c of reports[0].balances) {
      const at = c.ledger === null ? '' : `  at ledger ${c.ledger}`
      lines.push(`  ${c.status === 'mismatch' ? 'FAIL' : 'ok  '} ${symbol(c.asset)}  chain ${c.chain}  recorded ${c.recorded}${at}${c.status === 'issuer' ? '  (issuer: not attested)' : ''}`)
    }
    if (journal) {
      const posted = await reconcileAll(store)
      const again = (await reconcileAll(store)) + (await sweepAll(store))
      ok &&= again === 0
      lines.push(`  ok   reconciled: ${posted} journal entries posted`)
      lines.push(`  ${again === 0 ? 'ok  ' : 'FAIL'} rerun posted ${again} more`)
      reports.push(await doctor({ store, tenantId }))
      ok &&= reports[1].ok
    }
    const last = reports[reports.length - 1]
    lines.push(`  ${last.ok ? 'ok  ' : 'FAIL'} ${summary(last)}`)
    for (const f of reports.flatMap((r) => r.findings)) {
      lines.push(`  ${f.severity === 'error' ? 'FAIL' : 'warn'} ${f.invariant} ${f.code}: ${f.detail}`)
    }
    failed ||= !ok
    console.log(`${ok ? 'MATCH   ' : 'MISMATCH'} ${account}`)
    for (const line of lines) console.log(line)
  } finally {
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  }
}
process.exit(failed ? 1 : 0)
