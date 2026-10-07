import { normalizeReference } from '../reference.js'
import type { MatchStrategy } from '../types.js'

/**
 * Score 0.85. The movement's text memo, normalised, equals the expectation's
 * reference or the text memo it asked for, normalised the same way.
 *
 * Lower than an id because people type it and normalisation is lossy by
 * design: `INV-00123` and `inv 00123` are the same reference here, which is
 * what makes it useful and also how two references can collide.
 */
export const memoTextStrategy: MatchStrategy = {
  name: 'memo_text',
  family: 'identifier',
  evaluate(movement, { expectation }) {
    if (movement.memo?.type !== 'text') return null
    const sent = normalizeReference(movement.memo.value)
    if (sent === '') return null
    const asked = expectation.memo?.type === 'text' ? normalizeReference(expectation.memo.value) : null
    if (sent !== normalizeReference(expectation.reference) && sent !== asked) return null
    return {
      strategy: 'memo_text',
      family: 'identifier',
      score: 0.85,
      reason: `memo ${JSON.stringify(movement.memo.value)} matches reference ${expectation.reference}`,
    }
  },
}
