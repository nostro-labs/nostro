#!/usr/bin/env node
/**
 * Ingest real accounts end to end and check the result against Horizon.
 *
 *   pnpm build
 *   node scripts/check-balances.mjs [--public] <G...> [<G...> ...]
 *
 * For each account this syncs every effect and fee into a MemoryStore until
 * both feeds are caught up, sums the movements per asset, and compares the
 * sums with the balances Horizon reports. They should agree to the stroop.
 *
 * This only holds for an account whose whole history Horizon still retains:
 * any testnet account (testnet is reset periodically), or a public-network
 * account younger than the retention window. An account that is transacting
 * while this runs can also drift by whatever landed after the last page.
 *
 * Exits non-zero if any account does not match.
 */
import {
  HorizonClient,
  HorizonEffectsSource,
  HorizonFeesSource,
  MemoryStore,
  NATIVE,
  signedAmount,
  sync,
} from '../packages/core/dist/index.js'

const args = process.argv.slice(2)
const pub = args.includes('--public')
const accounts = args.filter((a) => a !== '--public')
if (accounts.length === 0) {
  console.error('usage: node scripts/check-balances.mjs [--public] <G...> [<G...> ...]')
  process.exit(2)
}

const network = pub ? 'public' : 'testnet'
const client = new HorizonClient({
  url: pub ? 'https://horizon.stellar.org' : 'https://horizon-testnet.stellar.org',
})

let failed = false
for (const account of accounts) {
  const store = new MemoryStore()
  for (const source of [
    new HorizonEffectsSource({ client, network }),
    new HorizonFeesSource({ client, network }),
  ]) {
    for (;;) {
      const report = await sync({ store, source, tenantId: 'check', accounts: [account], maxBatches: 20 })
      if (report.errors.length > 0) throw report.errors[0].error
      if (report.accounts[0].caughtUp) break
    }
  }

  const movements = await store.listMovements({ tenantId: 'check' })
  const net = new Map()
  for (const m of movements) net.set(m.amount.asset, (net.get(m.amount.asset) ?? 0n) + signedAmount(m).raw)

  const { balances } = await client.get(`/accounts/${account}`)
  const lines = []
  let ok = true
  for (const b of balances) {
    if (b.asset_type === 'liquidity_pool_shares') continue
    const id = b.asset_type === 'native' ? NATIVE : `${b.asset_code}:${b.asset_issuer}`
    const horizon = BigInt(b.balance.replace('.', ''))
    const ours = net.get(id) ?? 0n
    net.delete(id)
    ok &&= horizon === ours
    lines.push(`  ${id}  horizon ${horizon}  nostro ${ours}${horizon === ours ? '' : `  off by ${horizon - ours}`}`)
  }
  for (const [id, raw] of net) {
    if (raw === 0n) continue
    ok = false
    lines.push(`  ${id}  no balance on Horizon  nostro ${raw}`)
  }
  failed ||= !ok
  console.log(`${ok ? 'MATCH   ' : 'MISMATCH'} ${account}  ${movements.length} movements`)
  for (const line of lines) console.log(line)
}
process.exit(failed ? 1 : 0)
