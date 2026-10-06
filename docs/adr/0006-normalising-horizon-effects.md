# ADR 0006 — Normalising Horizon effects, and where ADR 0001 was wrong

**Status:** accepted · 2026-10-06 · amends [ADR 0001](./0001-effects-as-authoritative-feed.md)

## Context

ADR 0001 chose `/accounts/{id}/effects` as the authoritative feed. Building the normaliser meant
checking what Horizon actually emits, against its effects processor (`stellar/stellar-horizon`,
`internal/ingest/processors/effects_processor.go`, v29) and against live records. Two claims in
ADR 0001 did not survive:

1. **Trades are not credits and debits.** A crossed offer produces only `trade` effects for the
   taker and each maker — no `account_credited` / `account_debited`. A reader of credits and debits
   alone misses every DEX fill.
2. **Fees are not effects at all.** There is no fee path in the effects processor; a fee-bump payer
   has zero effects for the transaction it paid for.

The feed choice stands. The normalisation rules below are what make it correct.

## Decision

Effects are normalised per operation (pages are cut on operation boundaries so every rule can see
all of an account's effects in the operation):

| Effect | Movement |
|---|---|
| `account_credited` / `account_debited` | one credit / debit; value leaving its issuer is `mint`, reaching it is `burn` |
| `account_created` | credit of `starting_balance` — *unless* the account was also credited in the same operation (CAP-73 SAC transfers that create the destination emit both) |
| `trade` | debit `sold_*`, credit `bought_*` (account's perspective) — *unless* the account was debited in the same operation: those are a path payment's intermediate hops, already covered by its debit |
| `liquidity_pool_trade` | same skip rule; amounts are from the **pool's** perspective, so the account paid `bought` and received `sold` |
| `liquidity_pool_deposited` / `_withdrew` | debit / credit each reserve |
| `contract_credited` / `_debited` | ignored — filed under the invoking account, not the contract, and never move the invoker's own balance |
| zero amounts | ignored — they exist (sponsored `create_account` with a zero balance) and carry no value |
| everything else | not a value movement |

Fees come from a second feed, `/accounts/{id}/transactions?include_failed=true`, as one `fee`
movement per transaction whose `fee_account` is the watched account. Failed transactions are
included because they still pay fees; for a fee-bump, `fee_account` is the outer payer.

The pool-perspective rule was confirmed on 23 of 23 live `liquidity_pool_trade` effects from path
payments, where the hop direction is known. The skip rule relies on a path payment's source being
unable to cross its own offers.

## Consequences

- Balance invariant I2 can hold for accounts that trade or provide liquidity, not only for accounts
  that receive payments.
- Effects and fees have separate cursors (`horizon` and `horizon-fees`), since they page different
  feeds.
- **Known gap:** an ascending cursor older than Horizon's retention window is silently moved to the
  oldest retained record instead of failing. Until history-window detection lands, I2 is the check
  that notices.
- Real records backing each rule live in `fixtures/horizon/`.
