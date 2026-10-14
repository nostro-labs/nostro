/**
 * Balance attestation (I2): do an account's recorded movements add up to the
 * balance the chain reports for it?
 *
 * This is what catches a source that quietly left something out. The hard
 * part is that the account may keep transacting while we look, and Horizon's
 * history feeds do not say how far they have ingested.
 *
 * So each comparison is pinned to a ledger. A balance line says which ledger
 * it last changed in, and the balance has been exactly that ever since, so
 * the recorded movements up to and including that ledger must add up to it,
 * however much has happened after. The snapshot is read first and the
 * sources are caught up after it, so every movement through that ledger has
 * had the chance to be recorded. A source that answered from a server still
 * behind that ledger makes the sums disagree for a moment, and catching up
 * again shortly after settles it; a real gap stays. Either way a missing
 * movement cannot look like a match. ADR 0008 has the reasoning.
 */
import type { MovementSource } from '../ingest/index.js'
import { sync } from '../ingest/index.js'
import type { Movement } from '../model/index.js'
import { signedAmount } from '../model/index.js'
import type { AssetId } from '../money/index.js'
import { Money, issuerOf } from '../money/index.js'
import type { Store } from '../store/index.js'

export interface BalanceLine {
  readonly amount: Money
  /** The ledger this balance last changed in. */
  readonly lastModifiedLedger: number
}

export interface BalanceSnapshot {
  readonly account: string
  /** The ledger the snapshot is as of, when the source says. */
  readonly ledger: number | null
  /** At most one line per asset. An account that does not exist has none. */
  readonly balances: readonly BalanceLine[]
}

/** Where on-chain balances come from. */
export interface BalanceSource {
  /** The network label the movement sources use, e.g. `testnet`. */
  readonly network: string
  snapshot(account: string): Promise<BalanceSnapshot>
}

export interface BalanceCheck {
  readonly account: string
  readonly asset: AssetId
  /** What the chain reports; zero for an asset it shows no balance in. */
  readonly chain: Money
  /** The account's recorded movements in the asset, signed, through `ledger`. */
  readonly recorded: Money
  /**
   * The ledger the comparison is pinned at: when the chain balance last
   * changed or, for an asset the chain shows no balance in, the snapshot's
   * ledger. `null` when there is neither, and every movement counts.
   */
  readonly ledger: number | null
  /**
   * `issuer`: the account issues the asset, so the chain shows no balance
   * to compare with, and nothing is attested.
   */
  readonly status: 'match' | 'mismatch' | 'issuer'
}

/**
 * Compare a snapshot with recorded movements. Movements of other accounts
 * are skipped; the caller passes only movements from the snapshot's network.
 */
export function compareBalances(snapshot: BalanceSnapshot, movements: readonly Movement[]): BalanceCheck[] {
  const { account } = snapshot
  const pins = new Map(snapshot.balances.map((b) => [b.amount.asset, b.lastModifiedLedger]))
  const recorded = new Map<AssetId, Money>()
  for (const m of movements) {
    if (m.account !== account) continue
    const pin = pins.get(m.amount.asset) ?? snapshot.ledger
    if (pin !== null && m.ledger > pin) continue
    const sum = recorded.get(m.amount.asset)
    recorded.set(m.amount.asset, sum === undefined ? signedAmount(m) : sum.add(signedAmount(m)))
  }

  const checks: BalanceCheck[] = []
  for (const line of snapshot.balances) {
    const asset = line.amount.asset
    const sum = recorded.get(asset) ?? Money.zero(asset, line.amount.decimals)
    recorded.delete(asset)
    const status = sum.equals(line.amount) ? 'match' : 'mismatch'
    checks.push({ account, asset, chain: line.amount, recorded: sum, ledger: line.lastModifiedLedger, status })
  }
  for (const [asset, sum] of recorded) {
    const status = issuerOf(asset) === account ? 'issuer' : sum.isZero() ? 'match' : 'mismatch'
    checks.push({ account, asset, chain: Money.zero(asset, sum.decimals), recorded: sum, ledger: snapshot.ledger, status })
  }
  return checks
}

export interface AttestOptions {
  readonly store: Store
  readonly tenantId: string
  readonly balances: BalanceSource
  /**
   * Every source that records these accounts' movements on the balance
   * source's network. For Horizon that is both the effects and the fees
   * source; leave one out and the balance is short by everything it records.
   */
  readonly sources: readonly MovementSource[]
  readonly accounts: readonly string[]
  /** Comparisons made before a mismatch is reported. Default 3. */
  readonly attempts?: number
  /** Wait between comparisons. Default 6 seconds, about one ledger. */
  readonly retryDelayMs?: number
  /** Injected for tests. */
  readonly sleep?: (ms: number) => Promise<void>
}

/**
 * For each account: read the chain balances, catch every source up, and
 * compare. Writes only what `sync()` writes. Throws if a source fails.
 */
export async function attestBalances(options: AttestOptions): Promise<BalanceCheck[]> {
  const { store, tenantId, balances, sources } = options
  const attempts = options.attempts ?? 3
  const retryDelayMs = options.retryDelayMs ?? 6_000
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  for (const source of sources) {
    if (source.network !== balances.network) {
      throw new Error(`Source ${source.name} is on ${source.network}, but the balances are from ${balances.network}`)
    }
  }

  const checks: BalanceCheck[] = []
  for (const account of options.accounts) {
    const snapshot = await balances.snapshot(account)
    for (let attempt = 1; ; attempt++) {
      for (const source of sources) await catchUp(store, source, tenantId, account)
      const found = compareBalances(snapshot, await recorded(store, tenantId, balances.network, account))
      if (attempt >= attempts || found.every((c) => c.status !== 'mismatch')) {
        checks.push(...found)
        break
      }
      await sleep(retryDelayMs)
    }
  }
  return checks
}

async function catchUp(store: Store, source: MovementSource, tenantId: string, account: string): Promise<void> {
  for (;;) {
    const [report] = (await sync({ store, source, tenantId, accounts: [account] })).accounts
    if (report!.error !== null) throw report!.error
    if (report!.caughtUp) return
  }
}

async function recorded(store: Store, tenantId: string, network: string, account: string): Promise<Movement[]> {
  const out: Movement[] = []
  const limit = 1000
  for (let afterSeq: number | undefined; ; ) {
    const page = await store.listMovements({ tenantId, account, limit, ...(afterSeq === undefined ? {} : { afterSeq }) })
    for (const m of page) if (m.network === network) out.push(m)
    if (page.length < limit) return out
    afterSeq = page[page.length - 1]!.seq
  }
}
