import type { MatchStrategy } from '../types.js'

/**
 * Score 0.95. The movement's `MEMO_ID` equals the memo id the expectation
 * asked for, or its muxed id (wallets that cannot send to an `M...` address
 * are often told to put the id in the memo instead).
 *
 * Below a muxed id because the payer types it: a valid-but-wrong id from a
 * typo or a copy-paste of last month's invoice still scores here, which is
 * why duplicate and settled checks run after matching.
 */
export const memoIdStrategy: MatchStrategy = {
  name: 'memo_id',
  family: 'identifier',
  evaluate(movement, { expectation }) {
    if (movement.memo?.type !== 'id') return null
    const id = movement.memo.value
    const asked = expectation.memo?.type === 'id' && expectation.memo.value === id
    const muxed = expectation.muxedId === id
    if (!asked && !muxed) return null
    return {
      strategy: 'memo_id',
      family: 'identifier',
      score: 0.95,
      reason: `memo id ${id} matches the ${asked ? 'memo id' : 'muxed id'} of ${expectation.reference}`,
    }
  },
}
