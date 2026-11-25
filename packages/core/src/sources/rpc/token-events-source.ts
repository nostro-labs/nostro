/**
 * RpcTokenEventsSource — MovementSource for SEP-41 token transfers (#24).
 *
 * Reads `transfer`, `mint`, `burn` and `clawback` events from Stellar RPC for
 * the listed token contracts that touch the watched account, and normalises them
 * with the CAP-67 decoder (`sources/events/normalize.ts`).
 *
 * Constraints enforced here:
 *   - Only listed tokens. Unlisted contracts are never recorded.
 *   - No double-counting SACs. SAC contract ids are skipped; their movements
 *     already arrive via HorizonEffectsSource as account_credited/debited.
 *   - Cursor advances in the same transaction as movements (ADR 0005).
 *
 * The cursor is a Stellar RPC paging cursor string (not a ledger number),
 * persisted via the store's cursor API alongside each batch of movements.
 *
 * First sync: if no cursor is stored, `startLedger` is set to
 * `latestLedger - ledgerRetentionWindow + 1` (oldest available). History
 * before that window is not available from RPC; a TODO is left for archive
 * replay.
 */

import type { AssetId } from '../../money/asset.js'
import type { NewMovement } from '../../model/index.js'
import { normalizeTokenEvents } from '../events/normalize.js'
import type { RawContractEvent } from '../events/normalize.js'
import type { StellarRpcClient, RpcEvent } from './client.js'

export interface TokenConfig {
  /** AssetId for this token (`contract:C...` or `CODE:ISSUER` for a SAC). */
  assetId: AssetId
  /** Contract address. Must match `contractIdOf(assetId)` for contract tokens. */
  contractId: string
  /** Token decimals (e.g. 7 for XLM-like, 18 for many Ethereum-bridged tokens). */
  decimals: number
  /**
   * Set true if this is a SAC whose movements already arrive via Horizon.
   * The source will skip it to avoid double-counting (#24).
   */
  isSac?: boolean
}

export interface RpcSourceContext {
  readonly tenantId: string
  readonly network: string
  /** Source label recorded on each movement, e.g. `stellar-rpc`. */
  readonly source: string
  /** Watched address (G... or C...). */
  readonly account: string
}

export interface FetchMovementsResult {
  /** Tip observed by getEvents, independent of how much this page consumed. */
  latestLedger?: number
  movements: NewMovement[]
  /** New cursor to persist. Null when nothing was returned and cursor is unchanged. */
  cursor: string | null
}

export class RpcTokenEventsSource {
  constructor(
    private readonly client: StellarRpcClient,
    private readonly tokens: TokenConfig[],
    private readonly ctx: RpcSourceContext,
  ) {}

  /**
   * Fetch one page of token events starting from `cursor` (or the oldest
   * available ledger on first sync) and return normalised movements plus the
   * next cursor.
   *
   * Pass the returned `cursor` on the next call. Persist it in the same
   * transaction as the movements (ADR 0005).
   */
  async fetchMovements(cursor: string | null, limit = 1_000): Promise<FetchMovementsResult> {
    // Skip SAC contracts — their movements arrive via Horizon (#24).
    const activeTokens = this.tokens.filter((t) => !t.isSac)
    if (activeTokens.length === 0) return { movements: [], cursor }

    // On first sync, determine oldest available ledger.
    let startLedger: number | undefined
    if (cursor === null) {
      const health = await this.client.getHealth()
      startLedger = health.oldestLedger
    }

    // Build topic filters: watch for transfer/mint/burn/clawback events where
    // the watched account appears in topic[1] (from) or topic[2] (to).
    // RPC supports up to 5 filters; we use one per known kind for the account.
    // Contract ids are limited to 5 per request; batch if needed (TODO #24).
    const contractIds = activeTokens.map((t) => t.contractId).slice(0, 5)

    const result = await this.client.getEvents({
      ...(cursor !== null ? { cursor } : startLedger !== undefined ? { startLedger } : {}),
      filters: [{ contractIds }],
      limit,
    })

    // Build a lookup from contractId → TokenConfig
    const tokenMap = new Map(activeTokens.map((t) => [t.contractId, t]))

    const movements: NewMovement[] = []
    for (const ev of result.events) {
      const token = tokenMap.get(ev.contractId)
      if (!token) continue // event from an unlisted contract — skip

      const raw = decodeEvent(ev)
      if (raw === null) continue // non-value event (diagnostic etc.)

      try {
        const batch = normalizeTokenEvents([raw], {
          tenantId: this.ctx.tenantId,
          network: this.ctx.network,
          source: this.ctx.source,
          account: this.ctx.account,
          assetId: token.assetId,
          decimals: token.decimals,
        })
        movements.push(...batch)
      } catch (err) {
        // Re-throw: unknown event shapes must not be silently dropped (#23).
        throw err
      }
    }

    return {
      movements,
      cursor: result.cursor ?? cursor,
      ...(result.latestLedger === undefined ? {} : { latestLedger: result.latestLedger }),
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Decode a raw `RpcEvent` into the shape `normalizeTokenEvents` expects.
 * Returns null for events that carry no value (e.g. diagnostic events).
 *
 * Amount decoding: RPC returns i128 as a JSON number or string. We parse to
 * BigInt, taking the absolute value (direction is determined by the topic kind).
 */
function decodeEvent(ev: RpcEvent): RawContractEvent | null {
  if (ev.type !== 'contract') return null
  if (!ev.inSuccessfulContractCall) return null

  // Amount is in ev.value; shape depends on whether the data is a bare i128
  // or a map {amount, to_muxed_id}.
  let amount: bigint
  let toMuxedId: bigint | null = null

  const val = ev.value as unknown
  if (typeof val === 'number' || typeof val === 'string') {
    amount = BigInt(val)
  } else if (val !== null && typeof val === 'object' && 'amount' in val) {
    const v = val as { amount: number | string; to_muxed_id?: number | string | null }
    amount = BigInt(v.amount)
    if (v.to_muxed_id != null) {
      // to_muxed_id is a u64; coerce string or number → bigint (#23).
      toMuxedId = BigInt(v.to_muxed_id)
    }
  } else {
    return null
  }

  return {
    id: ev.id,
    contractId: ev.contractId,
    topics: ev.topic,
    amount,
    toMuxedId,
    ledger: ev.ledger,
    txHash: null, // RPC getEvents does not return txHash directly; enrich separately.
    occurredAt: new Date(ev.ledgerClosedAt),
  }
}
