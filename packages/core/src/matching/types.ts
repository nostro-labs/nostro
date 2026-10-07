/**
 * The matching engine's vocabulary.
 *
 * A strategy looks at one movement and one candidate expectation and either
 * says nothing or emits a `Signal`: a score in [0, 1] and a reason a person
 * can read. Strategies are pure, so they are testable with no store and no
 * network, and adding one cannot change how the others behave.
 */
import type { Expectation, Movement } from '../model/index.js'
import type { Money } from '../money/index.js'

/**
 * Signals in the same family are not independent evidence. A muxed id and a
 * memo both derive from the same expectation identity, so finding both is
 * not twice as convincing; the engine takes the strongest signal per family
 * and only combines across families.
 */
export type SignalFamily = 'identifier' | 'amount' | 'payer'

export interface Signal {
  readonly strategy: string
  readonly family: SignalFamily
  readonly score: number
  readonly reason: string
}

/** An expectation the movement might settle, with what is still owed on it. */
export interface Candidate {
  readonly expectation: Expectation
  readonly remaining: Money
}

export interface MatchStrategy {
  readonly name: string
  readonly family: SignalFamily
  /**
   * Evidence that `movement` settles `candidate`, or `null` for none. `all`
   * is every candidate under consideration, for strategies whose confidence
   * depends on uniqueness.
   */
  evaluate(movement: Movement, candidate: Candidate, all: readonly Candidate[]): Signal | null
}
