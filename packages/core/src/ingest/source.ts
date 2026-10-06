/**
 * Where movements come from.
 *
 * A source turns some external feed into `NewMovement`s and tells the ingest
 * loop where to resume. It does no storage and holds no state between pulls;
 * the cursor it returns is persisted by the ingest loop in the same
 * transaction as the movements it covers (ADR 0005).
 */
import type { NewMovement } from '../model/index.js'

export interface PullRequest {
  readonly tenantId: string
  readonly account: string
  /** Where the previous pull left off, or `null` if this account has never been read. */
  readonly cursor: string | null
  /** Upper bound on records read from the feed in this pull. */
  readonly limit: number
}

export interface PullResult {
  readonly movements: readonly NewMovement[]
  /**
   * Where the next pull should resume. Equal to the request's cursor when
   * nothing new was read. A source may return a cursor with no movements, for
   * example after skipping records that carry no value movement.
   */
  readonly cursor: string | null
  /** True when the feed had nothing beyond this batch at the time of the pull. */
  readonly caughtUp: boolean
}

export interface MovementSource {
  /** Stored on each movement and in the cursor key, e.g. `horizon`. */
  readonly name: string
  /** e.g. `testnet` or `public`. */
  readonly network: string
  pull(request: PullRequest): Promise<PullResult>
}
