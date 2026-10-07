import type { Movement } from '../../model/index.js'
import type { Candidate, MatchStrategy } from '../types.js'

/** How long before an expectation is recorded a payment for it may arrive. */
const EARLY_PAYMENT_MS = 7 * 24 * 60 * 60 * 1000

function fits(movement: Movement, { expectation, remaining }: Candidate): boolean {
  if (remaining.asset !== movement.amount.asset || remaining.decimals !== movement.amount.decimals) return false
  if (!remaining.equals(movement.amount)) return false
  const at = movement.occurredAt.getTime()
  if (expectation.expiresAt !== null && at > expectation.expiresAt.getTime()) return false
  return at >= expectation.createdAt.getTime() - EARLY_PAYMENT_MS
}

/**
 * Score 0.60 when exactly one candidate is owed exactly this amount in this
 * asset, inside its time window; 0.20 when several are.
 *
 * The classic fallback for payers who send no memo. Never enough on its own:
 * 0.60 is below the engine's 0.70 threshold, so an amount match alone is
 * offered to a person as a suggestion, and only settles automatically when
 * another family of evidence corroborates it.
 */
export const exactAmountStrategy: MatchStrategy = {
  name: 'exact_amount',
  family: 'amount',
  evaluate(movement, candidate, all) {
    if (!fits(movement, candidate)) return null
    const rivals = all.filter((c) => fits(movement, c)).length
    return {
      strategy: 'exact_amount',
      family: 'amount',
      score: rivals === 1 ? 0.6 : 0.2,
      reason:
        rivals === 1
          ? `the only candidate owed exactly ${movement.amount.toString()}`
          : `one of ${rivals} candidates owed exactly ${movement.amount.toString()}`,
    }
  },
}
