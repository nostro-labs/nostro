/**
 * The matching engine: `(movement, candidates, options) → Decision`.
 *
 * Pure and deterministic. No I/O, no clock, no randomness, so the same inputs
 * always give the same decision, every decision can be replayed from a
 * fixture, and the reasons behind it are recorded as evidence.
 *
 * 1. Fees are never matched: they are posted to expense.
 * 2. Every strategy scores every candidate. Within a signal family only the
 *    strongest signal counts; across families scores combine as
 *    `1 − Π(1 − sᵢ)`, so independent evidence corroborates.
 * 3. A match needs the best score ≥ `threshold` (0.70) and a lead of at least
 *    `margin` (0.15) over the runner-up. Anything less goes to a person as
 *    AMBIGUOUS_MATCH, with every candidate's signals as evidence.
 * 4. A confident match can still be refused: wrong asset (including a
 *    lookalike issuer), paid after the expectation expired, or nothing left
 *    owing on it (a duplicate).
 * 5. Otherwise allocate `min(amount, remaining)`; any residual is an
 *    overpayment, which needs a person.
 */
import type { ExceptionCode, Json, Movement } from '../model/index.js'
import type { Money } from '../money/index.js'
import { isSameCodeDifferentIssuer } from '../money/index.js'
import { DEFAULT_STRATEGIES } from './strategies/index.js'
import type { Candidate, MatchStrategy, Signal, SignalFamily } from './types.js'

export interface DecideOptions {
  readonly strategies?: readonly MatchStrategy[]
  /** Minimum combined score to match. Default 0.70. */
  readonly threshold?: number
  /** Minimum lead over the runner-up. Default 0.15. */
  readonly margin?: number
}

export type Decision =
  | {
      readonly outcome: 'allocate'
      readonly expectationId: string
      readonly amount: Money
      /** What the movement paid beyond what was owed; `null` if nothing. */
      readonly residual: Money | null
      readonly strategy: string
      readonly score: number
      readonly evidence: Json
    }
  | {
      readonly outcome: 'exception'
      readonly code: ExceptionCode
      readonly expectationId: string | null
      readonly amount: Money | null
      readonly detail: string
      readonly evidence: Json
    }
  | { readonly outcome: 'ignore'; readonly reason: string }

interface Scored {
  readonly candidate: Candidate
  readonly signals: readonly Signal[]
  readonly score: number
}

/** Strongest signal per family, combined across families. */
export function combine(signals: readonly Signal[]): number {
  const best = new Map<SignalFamily, number>()
  for (const s of signals) best.set(s.family, Math.max(best.get(s.family) ?? 0, s.score))
  return 1 - [...best.values()].reduce((miss, s) => miss * (1 - s), 1)
}

const round = (n: number) => Math.round(n * 10_000) / 10_000

function describe(s: Scored): Json {
  return {
    expectationId: s.candidate.expectation.id,
    reference: s.candidate.expectation.reference,
    score: round(s.score),
    remaining: s.candidate.remaining.toString(),
    asset: s.candidate.remaining.asset,
    signals: s.signals.map((x) => ({ strategy: x.strategy, score: x.score, reason: x.reason })),
  }
}

/** Order by score, then oldest expectation first, then id: fully deterministic. */
function rank(a: Scored, b: Scored): number {
  if (b.score !== a.score) return b.score - a.score
  const at = a.candidate.expectation.createdAt.getTime() - b.candidate.expectation.createdAt.getTime()
  if (at !== 0) return at
  return a.candidate.expectation.id < b.candidate.expectation.id ? -1 : 1
}

function unmatchedCode(movement: Movement, candidates: readonly Candidate[]): ExceptionCode {
  if (movement.direction === 'debit') return 'UNEXPECTED_DEBIT'
  if (movement.enrichment === 'missing') return 'ENRICHMENT_MISSING'
  if (movement.memo === null && movement.muxedId === null) {
    return candidates.length > 0 ? 'MEMO_MISSING' : 'UNEXPECTED_CREDIT'
  }
  return 'UNMATCHED_NO_CANDIDATE'
}

export function decide(
  movement: Movement,
  candidates: readonly Candidate[],
  options: DecideOptions = {},
): Decision {
  const strategies = options.strategies ?? DEFAULT_STRATEGIES
  const threshold = options.threshold ?? 0.7
  const margin = options.margin ?? 0.15

  if (movement.kind === 'fee') {
    return { outcome: 'ignore', reason: 'network fee: posted to expense, never matched' }
  }

  const scored = candidates
    .map((candidate): Scored => {
      const signals = strategies.flatMap((s) => s.evaluate(movement, candidate, candidates) ?? [])
      return { candidate, signals, score: combine(signals) }
    })
    .filter((s) => s.score > 0)
    .sort(rank)
  const evidence: Json = { candidates: scored.slice(0, 10).map(describe) }

  const [top, second] = scored
  if (top === undefined) {
    const code = unmatchedCode(movement, candidates)
    return {
      outcome: 'exception',
      code,
      expectationId: null,
      amount: movement.amount,
      detail: `No expectation matches this ${movement.direction} of ${movement.amount.toString()}.`,
      evidence: { candidates: [], considered: candidates.length },
    }
  }

  const lead = second === undefined ? top.score : top.score - second.score
  if (top.score < threshold || lead < margin) {
    const why =
      top.score < threshold
        ? `the best candidate scored ${round(top.score)}, below the ${threshold} threshold`
        : `${top.candidate.expectation.reference} and ${second!.candidate.expectation.reference} ` +
          `scored within ${margin} of each other`
    return {
      outcome: 'exception',
      code: 'AMBIGUOUS_MATCH',
      expectationId: null,
      amount: movement.amount,
      detail: `Not confident enough to match: ${why}.`,
      evidence,
    }
  }

  const { expectation, remaining } = top.candidate
  const refuse = (code: ExceptionCode, detail: string): Decision => ({
    outcome: 'exception',
    code,
    expectationId: expectation.id,
    amount: movement.amount,
    detail,
    evidence,
  })

  if (expectation.amount.asset !== movement.amount.asset || expectation.amount.decimals !== movement.amount.decimals) {
    const lookalike = isSameCodeDifferentIssuer(movement.amount.asset, expectation.amount.asset)
    return refuse(
      'WRONG_ASSET',
      `Paid in ${movement.amount.asset}, but ${expectation.reference} is owed in ${expectation.amount.asset}.` +
        (lookalike ? ' Same code, different issuer: a lookalike asset, not the one owed.' : ''),
    )
  }
  if (expectation.expiresAt !== null && movement.occurredAt.getTime() > expectation.expiresAt.getTime()) {
    return refuse(
      'LATE_BEYOND_WINDOW',
      `Paid ${movement.occurredAt.toISOString()}, after ${expectation.reference} expired ` +
        `${expectation.expiresAt.toISOString()}.`,
    )
  }
  if (remaining.isZero()) {
    return refuse('DUPLICATE_PAYMENT', `${expectation.reference} is already settled; this looks like a second payment.`)
  }

  const amount = movement.amount.compare(remaining) > 0 ? remaining : movement.amount
  const residual = movement.amount.subtract(amount)
  const strongest = [...top.signals].sort((a, b) => b.score - a.score)[0]!
  return {
    outcome: 'allocate',
    expectationId: expectation.id,
    amount,
    residual: residual.isZero() ? null : residual,
    strategy: strongest.strategy,
    score: round(top.score),
    evidence,
  }
}
