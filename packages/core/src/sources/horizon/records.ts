/**
 * The subset of Horizon's JSON that nostro reads.
 *
 * Field names follow `protocols/horizon` in stellar/go-stellar-sdk and were
 * checked against live responses (see `fixtures/horizon/`). Everything is
 * optional beyond what every record carries, because which fields appear
 * depends on the effect or operation type.
 */

export interface HorizonAssetAmount {
  /** Canonical form: `native` or `CODE:ISSUER`. */
  readonly asset: string
  readonly amount: string
}

export interface HorizonEffect {
  readonly id: string
  /** `<operation id>-<order>`, e.g. `278309109072396289-1`. */
  readonly paging_token: string
  readonly account: string
  readonly account_muxed?: string
  /** uint64 as a decimal string, present when the affected address was an `M...`. */
  readonly account_muxed_id?: string
  readonly type: string
  readonly created_at: string
  // account_credited / account_debited
  readonly asset_type?: string
  readonly asset_code?: string
  readonly asset_issuer?: string
  readonly amount?: string
  // account_created
  readonly starting_balance?: string
  // trade (from the perspective of `account`)
  readonly seller?: string
  readonly sold_amount?: string
  readonly sold_asset_type?: string
  readonly sold_asset_code?: string
  readonly sold_asset_issuer?: string
  readonly bought_amount?: string
  readonly bought_asset_type?: string
  readonly bought_asset_code?: string
  readonly bought_asset_issuer?: string
  // liquidity_pool_trade (from the perspective of the *pool*)
  readonly sold?: HorizonAssetAmount
  readonly bought?: HorizonAssetAmount
  // liquidity_pool_deposited / liquidity_pool_withdrew
  readonly reserves_deposited?: readonly HorizonAssetAmount[]
  readonly reserves_received?: readonly HorizonAssetAmount[]
}

export interface HorizonTransaction {
  readonly hash: string
  readonly paging_token: string
  readonly ledger: number
  readonly created_at: string
  readonly successful: boolean
  readonly source_account: string
  /** Who paid the fee: the outer source for a fee-bump, else the source account. */
  readonly fee_account: string
  readonly fee_account_muxed_id?: string
  /** Stroops, as a decimal string. */
  readonly fee_charged: string | number
  readonly memo_type: 'none' | 'text' | 'id' | 'hash' | 'return'
  /** Text as decoded; id as a decimal string; hash and return as base64. */
  readonly memo?: string
}

export interface HorizonBalanceChange {
  readonly asset_type: string
  readonly asset_code?: string
  readonly asset_issuer?: string
  readonly type: 'transfer' | 'mint' | 'burn' | 'clawback'
  readonly from?: string
  readonly to?: string
  readonly amount: string
  readonly destination_muxed_id?: string
}

export interface HorizonOperation {
  readonly id: string
  readonly paging_token: string
  readonly type: string
  readonly source_account: string
  readonly transaction_hash: string
  /** Present with `join=transactions`. */
  readonly transaction?: HorizonTransaction
  // payment, path payments, clawback
  readonly from?: string
  readonly to?: string
  // create_account
  readonly funder?: string
  // create_account, account_merge
  readonly account?: string
  readonly into?: string
  // invoke_host_function
  readonly asset_balance_changes?: readonly HorizonBalanceChange[] | null
}

/** The operation id (a TOID) an effect belongs to. */
export function operationIdOf(effect: Pick<HorizonEffect, 'paging_token'>): string {
  const dash = effect.paging_token.indexOf('-')
  return dash === -1 ? effect.paging_token : effect.paging_token.slice(0, dash)
}

/** The ledger a TOID falls in: the top 32 of its 64 bits. */
export function ledgerOfToid(toid: string): number {
  return Number(BigInt(toid) >> 32n)
}
