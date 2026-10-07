import type { MatchStrategy } from '../types.js'

/**
 * Score 1.00. The movement arrived at the muxed (`M...`) address issued for
 * this expectation.
 *
 * A muxed id is part of the destination address, so the payer cannot mistype
 * it and two expectations cannot share one if ids are issued uniquely. This
 * is the only strategy that is certain on its own. False-positive risk: an
 * id reused across expectations, which is the issuer's bug, not the payer's.
 */
export const muxedIdStrategy: MatchStrategy = {
  name: 'muxed_id',
  family: 'identifier',
  evaluate(movement, { expectation }) {
    if (movement.muxedId === null || expectation.muxedId !== movement.muxedId) return null
    return {
      strategy: 'muxed_id',
      family: 'identifier',
      score: 1,
      reason: `paid to muxed id ${movement.muxedId}, issued for ${expectation.reference}`,
    }
  },
}
