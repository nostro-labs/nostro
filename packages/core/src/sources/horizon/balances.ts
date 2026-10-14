/**
 * Horizon as a `BalanceSource`: an account's balances, and when each last
 * changed, for attesting them against recorded movements (I2).
 */
import type { BalanceLine, BalanceSnapshot, BalanceSource } from '../../invariants/index.js'
import { Money, NATIVE, asset } from '../../money/index.js'
import type { HorizonClient } from './client.js'
import { HorizonError } from './client.js'
import type { HorizonAccount } from './records.js'

export interface HorizonBalanceSourceOptions {
  readonly client: HorizonClient
  /** The same label the movement sources use, e.g. `public` or `testnet`. */
  readonly network: string
}

export class HorizonBalanceSource implements BalanceSource {
  readonly network: string
  private readonly client: HorizonClient

  constructor(options: HorizonBalanceSourceOptions) {
    this.client = options.client
    this.network = options.network
  }

  async snapshot(account: string): Promise<BalanceSnapshot> {
    let response
    try {
      response = await this.client.resource<HorizonAccount>(`/accounts/${account}`)
    } catch (err) {
      // Never funded, or merged away: it holds nothing.
      if (err instanceof HorizonError && err.status === 404) return { account, ledger: null, balances: [] }
      throw err
    }
    const { body, latestLedger } = response
    const balances: BalanceLine[] = []
    for (const b of body.balances) {
      // Pool shares are not movements nostro records.
      if (b.asset_type === 'liquidity_pool_shares') continue
      const id = b.asset_type === 'native' ? NATIVE : asset(b.asset_code ?? '', b.asset_issuer ?? '')
      balances.push({
        amount: Money.parse(b.balance, id),
        lastModifiedLedger: b.last_modified_ledger ?? body.last_modified_ledger,
      })
    }
    return { account, ledger: latestLedger, balances }
  }
}
