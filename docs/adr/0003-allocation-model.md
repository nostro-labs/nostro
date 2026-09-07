# ADR 0003 — Matches are allocations, not foreign keys

**Status:** accepted · 2026-09-07

## Context

The tempting model is `movement.expectation_id` (or the reverse). It cannot express a payment that
covers part of an invoice, a payment covering six invoices, or an overpayment whose residual needs
its own disposition — each becomes a special case.

## Decision

Matches are rows in `allocations(movement_id, expectation_id, amount)`, with
`UNIQUE(movement_id, expectation_id)` and `CHECK(amount > 0)`.

An expectation is settled when its allocations sum to its amount; a movement is fully disposed when
its allocations sum to its amount, or the residual carries an exception.

## Consequences

- Partial payment, overpayment, split settlement and consolidated payment are one mechanism.
- Reversals are negative-effect allocations plus a reversing journal entry; original rows are never
  mutated, which accounting requires.
- Allocation must be computed under a row lock on the expectation to prevent over-allocation.
