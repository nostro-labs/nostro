/**
 * Horizon records → movements. Pure functions, no I/O.
 *
 * The rules here encode what Horizon actually emits, checked against its
 * effects processor and against live records (`fixtures/horizon/`):
 *
 * - `account_credited` / `account_debited` cover payments, path payments,
 *   merges, claimable balances, clawbacks, inflation and SAC transfers to or
 *   from a `G` account.
 * - `account_created` is the only trace of a new account's starting balance;
 *   there is no matching `account_credited`. Since CAP-73 an XLM SAC transfer
 *   that creates its destination emits both, so `account_created` is skipped
 *   when the same operation already credited the account.
 * - A crossed offer produces only `trade` effects, so trades must be read. A
 *   path payment *also* emits `trade` effects for its source's intermediate
 *   hops, already covered by that source's `account_debited`; counting them
 *   would double-count. Rule: skip trade effects for an account that was
 *   debited in the same operation. (A source cannot cross its own offers.)
 * - `trade` amounts are from the perspective of the effect's account, but
 *   `liquidity_pool_trade` amounts are from the perspective of the *pool*:
 *   `sold` is what the account received. Verified on live records.
 * - `contract_credited` / `contract_debited` are filed under the operation's
 *   source account, not the contract, so they never move the account's own
 *   balance and are skipped.
 * - Fees are never effects; see `normalizeFee`.
 * - Zero-amount effects exist (a sponsored `create_account` with a zero
 *   starting balance) and carry no value, so they produce no movement.
 */
import type { Memo, MovementKind, NewMovement } from '../../model/index.js'
import { Money, NATIVE, asset, issuerOf, parseAsset } from '../../money/index.js'
import type { AssetId } from '../../money/index.js'
import type { HorizonEffect, HorizonOperation, HorizonTransaction } from './records.js'
import { ledgerOfToid, operationIdOf } from './records.js'

export interface NormalizeContext {
  readonly tenantId: string
  readonly network: string
  readonly source: string
  /** The watched account. Effects for any other account are ignored. */
  readonly account: string
}

const ADDRESS_RE = /^(G[A-Z2-7]{55}|M[A-Z2-7]{68}|C[A-Z2-7]{55})$/

function assetOf(type: string | undefined, code: string | undefined, issuer: string | undefined): AssetId {
  if (type === 'native') return NATIVE
  if (code === undefined || issuer === undefined) {
    throw new Error(`Horizon record has asset_type ${String(type)} but no code or issuer`)
  }
  return asset(code, issuer)
}

function memoOf(tx: HorizonTransaction | undefined): Memo | null {
  if (tx === undefined) return null
  switch (tx.memo_type) {
    case 'text':
      return { type: 'text', value: tx.memo ?? '' }
    case 'id':
      return { type: 'id', value: BigInt(tx.memo ?? '0') }
    case 'hash':
    case 'return':
      return { type: tx.memo_type, value: base64ToHex(tx.memo ?? '') }
    default:
      return null
  }
}

export function base64ToHex(b64: string): string {
  return Array.from(atob(b64), (c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('')
}

function address(value: string | undefined | null): string | null {
  return value !== undefined && value !== null && ADDRESS_RE.test(value) ? value : null
}

/**
 * Classify a movement the way the Token Transfer Processor does: value
 * leaving its issuer is minted, value reaching its issuer is burned.
 */
function issuerAdjusted(
  kind: MovementKind,
  account: string,
  counterparty: string | null,
  direction: 'credit' | 'debit',
  assetId: AssetId,
): MovementKind {
  if (kind !== 'transfer') return kind
  const issuer = issuerOf(assetId)
  if (issuer === null) return kind
  if (account === issuer) return direction === 'credit' ? 'burn' : 'mint'
  if (counterparty === issuer) return direction === 'credit' ? 'mint' : 'burn'
  return kind
}

interface Described {
  readonly kind: MovementKind
  readonly counterparty: string | null
}

/** Work out the kind and the other side of a credit or debit from its operation. */
function describe(
  op: HorizonOperation | undefined,
  account: string,
  direction: 'credit' | 'debit',
  assetId: AssetId,
  amount: string,
  usedChanges: Set<number>,
): Described {
  const credit = direction === 'credit'
  let kind: MovementKind = 'transfer'
  let counterparty: string | null = null
  switch (op?.type) {
    case 'payment':
    case 'path_payment_strict_send':
    case 'path_payment_strict_receive':
      counterparty = address(credit ? op.from : op.to)
      break
    case 'create_account':
      counterparty = address(credit ? op.funder : op.account)
      break
    case 'account_merge':
      counterparty = address(credit ? op.account : op.into)
      break
    case 'clawback':
      kind = 'clawback'
      counterparty = address(credit ? op.from : op.source_account)
      break
    case 'clawback_claimable_balance':
      kind = 'clawback'
      break
    case 'invoke_host_function': {
      const changes = op.asset_balance_changes ?? []
      const index = changes.findIndex(
        (c, i) =>
          !usedChanges.has(i) &&
          assetOf(c.asset_type, c.asset_code, c.asset_issuer) === assetId &&
          c.amount === amount &&
          (credit ? c.to === account : c.from === account),
      )
      if (index !== -1) {
        usedChanges.add(index)
        const change = changes[index]!
        kind = change.type
        counterparty = address(credit ? change.from : change.to)
      }
      break
    }
  }
  return { kind: issuerAdjusted(kind, account, counterparty, direction, assetId), counterparty }
}

/**
 * Normalise a run of effects for one account. Effects for other accounts are
 * ignored. `operations` maps operation id to the joined operation record; an
 * effect whose operation is absent still yields a movement, flagged
 * `enrichment: 'missing'` (ADR 0001).
 *
 * Pass whole operations: the trade and account-created rules look at every
 * effect the account has in the same operation.
 */
export function normalizeEffects(
  effects: readonly HorizonEffect[],
  operations: ReadonlyMap<string, HorizonOperation>,
  ctx: NormalizeContext,
): NewMovement[] {
  const mine = effects.filter((e) => e.account === ctx.account)
  const debitedIn = new Set(mine.filter((e) => e.type === 'account_debited').map(operationIdOf))
  const creditedIn = new Set(mine.filter((e) => e.type === 'account_credited').map(operationIdOf))
  const usedChanges = new Map<string, Set<number>>()
  const out: NewMovement[] = []

  for (const effect of mine) {
    const opId = operationIdOf(effect)
    const op = operations.get(opId)
    const tx = op?.transaction
    const base = {
      tenantId: ctx.tenantId,
      network: ctx.network,
      source: ctx.source,
      account: ctx.account,
      muxedId: effect.account_muxed_id === undefined ? null : BigInt(effect.account_muxed_id),
      memo: memoOf(tx),
      ledger: tx?.ledger ?? ledgerOfToid(opId),
      txHash: op?.transaction_hash ?? null,
      operationId: opId,
      occurredAt: new Date(effect.created_at),
      enrichment: op === undefined ? ('missing' as const) : ('complete' as const),
    }
    const push = (
      externalId: string,
      direction: 'credit' | 'debit',
      amount: Money,
      described: Described,
    ): void => {
      if (amount.isZero()) return
      out.push({ ...base, externalId, direction, amount, ...described })
    }
    const used = usedChanges.get(opId) ?? new Set<number>()
    usedChanges.set(opId, used)

    switch (effect.type) {
      case 'account_credited':
      case 'account_debited': {
        const direction = effect.type === 'account_credited' ? 'credit' : 'debit'
        const assetId = assetOf(effect.asset_type, effect.asset_code, effect.asset_issuer)
        const amount = effect.amount ?? '0'
        push(
          effect.id,
          direction,
          Money.parse(amount, assetId),
          describe(op, ctx.account, direction, assetId, amount, used),
        )
        break
      }
      case 'account_created': {
        if (creditedIn.has(opId)) break
        const amount = Money.parse(effect.starting_balance ?? '0', NATIVE)
        push(effect.id, 'credit', amount, { kind: 'transfer', counterparty: address(op?.funder) })
        break
      }
      case 'trade': {
        if (debitedIn.has(opId)) break
        const seller = address(effect.seller)
        const sold = assetOf(effect.sold_asset_type, effect.sold_asset_code, effect.sold_asset_issuer)
        const bought = assetOf(effect.bought_asset_type, effect.bought_asset_code, effect.bought_asset_issuer)
        push(`${effect.id}:sold`, 'debit', Money.parse(effect.sold_amount ?? '0', sold), {
          kind: 'transfer',
          counterparty: seller,
        })
        push(`${effect.id}:bought`, 'credit', Money.parse(effect.bought_amount ?? '0', bought), {
          kind: 'transfer',
          counterparty: seller,
        })
        break
      }
      case 'liquidity_pool_trade': {
        if (debitedIn.has(opId) || effect.sold === undefined || effect.bought === undefined) break
        // Pool perspective: the pool's `bought` is what the account paid.
        push(`${effect.id}:paid`, 'debit', Money.parse(effect.bought.amount, parseAsset(effect.bought.asset)), {
          kind: 'transfer',
          counterparty: null,
        })
        push(`${effect.id}:received`, 'credit', Money.parse(effect.sold.amount, parseAsset(effect.sold.asset)), {
          kind: 'transfer',
          counterparty: null,
        })
        break
      }
      case 'liquidity_pool_deposited':
      case 'liquidity_pool_withdrew': {
        const deposit = effect.type === 'liquidity_pool_deposited'
        const reserves = (deposit ? effect.reserves_deposited : effect.reserves_received) ?? []
        reserves.forEach((r, i) =>
          push(`${effect.id}:${i}`, deposit ? 'debit' : 'credit', Money.parse(r.amount, parseAsset(r.asset)), {
            kind: 'transfer',
            counterparty: null,
          }),
        )
        break
      }
      default:
        // contract_credited/debited and all non-value effects (signers,
        // trustlines, sponsorship, claimable balance bookkeeping, ...).
        break
    }
  }
  return out
}

/**
 * The fee a transaction charged the watched account, as a movement, or `null`
 * if someone else paid it. Failed transactions still pay fees, so read the
 * transactions feed with `include_failed=true`.
 */
export function normalizeFee(tx: HorizonTransaction, ctx: NormalizeContext): NewMovement | null {
  if (tx.fee_account !== ctx.account) return null
  const raw = BigInt(tx.fee_charged)
  if (raw <= 0n) return null
  return {
    tenantId: ctx.tenantId,
    network: ctx.network,
    source: ctx.source,
    externalId: `${tx.hash}:fee`,
    account: ctx.account,
    direction: 'debit',
    kind: 'fee',
    amount: Money.fromRaw(raw, NATIVE),
    counterparty: null,
    muxedId: tx.fee_account_muxed_id === undefined ? null : BigInt(tx.fee_account_muxed_id),
    memo: memoOf(tx),
    ledger: tx.ledger,
    txHash: tx.hash,
    operationId: null,
    occurredAt: new Date(tx.created_at),
    enrichment: 'complete',
  }
}
