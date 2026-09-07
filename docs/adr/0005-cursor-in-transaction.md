# ADR 0005 — The cursor advances in the same transaction as the movement write

**Status:** accepted · 2026-09-07

## Context

Horizon delivers at-least-once. The common failure is:

```ts
await store.saveMovements(batch)   // commits
await store.saveCursor(next)       // crashes here
```

On restart the batch is re-read and re-applied. Every "we double-charged a customer" incident in this
class has this shape. Streaming makes it worse: an SSE reconnect can silently skip events entirely.

## Decision

Movement identity is `(network, source, external_id)` with a UNIQUE index; ingest is
`INSERT … ON CONFLICT DO NOTHING`. **The cursor advance happens inside the same database transaction
as the movement writes.** At-least-once delivery + a dedupe key + a transactional cursor is
effectively-once processing.

The idempotency gate **fails closed**: if the driver cannot tell us whether the row was inserted, we
re-read and decide, never assume "inserted".

A durable polling loop owns the cursor. SSE, when enabled, only nudges that loop awake — it is an
accelerator and never the correctness path.

## Consequences

- No in-memory queue between stages; a row's `disposition` column is the queue, so a crash mid-match
  loses nothing.
- Stellar has no reorgs (SCP finality), but sources do issue corrections. `movement.revision` plus an
  idempotent `reingest` command diffs a range and raises `SOURCE_GAP_DETECTED` rather than silently
  overwriting.
