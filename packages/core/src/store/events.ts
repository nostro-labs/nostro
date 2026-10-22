/**
 * The event log (the outbox): one event per decision, written by the store
 * in the same transaction as the decision itself.
 *
 * That is the whole guarantee. An event exists if and only if its decision
 * committed, so a webhook can never announce a payment that rolled back, and
 * a crash between deciding and notifying cannot lose the notification:
 * whatever delivers events reads this log from a saved position and tries
 * again until it gets through. Delivery is at least once; consumers dedupe
 * on the event id.
 *
 * Every store emits through the builders below, so the payloads are the
 * same whichever store wrote them.
 */
import type { Allocation, Disposition, ExceptionRecord, Expectation, Json, Movement } from '../model/index.js'
import { allocationJson, exceptionJson, expectationJson, movementJson } from '../model/index.js'

export type EventType =
  | 'movement.decided'
  | 'expectation.partially_paid'
  | 'expectation.settled'
  | 'expectation.cancelled'
  | 'exception.opened'
  | 'exception.resolved'
  | 'exception.dismissed'

export const EVENT_TYPES: readonly EventType[] = [
  'movement.decided',
  'expectation.partially_paid',
  'expectation.settled',
  'expectation.cancelled',
  'exception.opened',
  'exception.resolved',
  'exception.dismissed',
]

export interface OutboxEvent {
  readonly id: string
  readonly tenantId: string
  /** Store-assigned order; consumers keep their position as the last `seq` they handled. */
  readonly seq: number
  readonly type: EventType
  /** The movement, expectation or exception the event is about. */
  readonly subjectId: string
  /** The record as it was when the event was written, in the JSON wire format. */
  readonly payload: Json
  readonly createdAt: Date
}

export interface NewOutboxEvent {
  readonly tenantId: string
  readonly type: EventType
  readonly subjectId: string
  readonly payload: Json
}

export interface EventQuery {
  readonly tenantId: string
  /** Events with `seq` greater than this. */
  readonly afterSeq?: number
  readonly limit?: number
}

/**
 * Where a consumer of the log keeps its position: an ordinary cursor, in a
 * namespace no ingest source uses.
 */
export const eventCursorKey = (tenantId: string, consumer: string) => ({
  tenantId,
  network: 'nostro',
  source: 'outbox',
  account: consumer,
})

const json = (value: unknown): Json => value as Json

/** A movement's disposition changed: `previous` to `movement.disposition`. */
export function movementDecided(movement: Movement, previous: Disposition, allocations: readonly Allocation[]): NewOutboxEvent {
  return {
    tenantId: movement.tenantId,
    type: 'movement.decided',
    subjectId: movement.id,
    payload: json({ movement: movementJson(movement), previous, allocations: allocations.map(allocationJson) }),
  }
}

/** An expectation's status changed; `null` when the status is not one events are written for. */
export function expectationChanged(expectation: Expectation, allocation: Allocation | null): NewOutboxEvent | null {
  const type =
    expectation.status === 'settled'
      ? 'expectation.settled'
      : expectation.status === 'partially_paid'
        ? 'expectation.partially_paid'
        : expectation.status === 'cancelled'
          ? 'expectation.cancelled'
          : null
  if (type === null) return null
  return {
    tenantId: expectation.tenantId,
    type,
    subjectId: expectation.id,
    payload: json({ expectation: expectationJson(expectation), allocation: allocation === null ? null : allocationJson(allocation) }),
  }
}

/** An exception was opened, resolved or dismissed. */
export function exceptionChanged(exception: ExceptionRecord): NewOutboxEvent {
  return {
    tenantId: exception.tenantId,
    type: exception.status === 'open' ? 'exception.opened' : exception.status === 'resolved' ? 'exception.resolved' : 'exception.dismissed',
    subjectId: exception.id,
    payload: json({ exception: exceptionJson(exception) }),
  }
}

export interface OutboxEventJson {
  readonly id: string
  readonly seq: number
  readonly type: EventType
  readonly subjectId: string
  readonly createdAt: string
  readonly data: Json
}

export function outboxEventJson(e: OutboxEvent): OutboxEventJson {
  return { id: e.id, seq: e.seq, type: e.type, subjectId: e.subjectId, createdAt: e.createdAt.toISOString(), data: e.payload }
}
