# ADR 0001 — `/effects` is the authoritative movement feed

**Status:** accepted · 2026-09-07

## Context

The obvious ingestion source is `/accounts/{id}/payments`. It returns only `create_account`,
`payment`, `path_payment_strict_send`, `path_payment_strict_receive` and `account_merge`.

It therefore misses money that genuinely moved: SAC (`invoke_host_function`) transfers crediting a
classic `G` account, claimable-balance claims, and trades executed through one's own offers.
A reconciler built on `/payments` under-reports balances and cannot explain the difference.

## Decision

`/accounts/{id}/effects` is the authoritative feed. It emits `account_credited` / `account_debited`
(and `contract_credited` / `contract_debited`) for all of the above.

`/payments?join=transactions` and `/operations?join=transactions` are **enrichment** feeds, supplying
memo, muxed ids, operation type, and path-payment source asset/amount. They are stitched onto effects
by `(ledger, transaction_hash, operation_id)`.

An effect with no matching enrichment record still produces a `Movement`, flagged
`ENRICHMENT_MISSING`. It is never dropped.

## Consequences

- Correctness is stated over one feed, which is what makes invariant I1 expressible.
- Two feeds must be reconciled, and the stitch key must be exact.
- Fee and reserve movements become first-class, which invariant I2 requires.
