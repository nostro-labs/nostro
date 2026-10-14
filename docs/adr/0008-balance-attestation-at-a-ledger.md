# ADR 0008 — Balances are attested at the ledger they last changed in

**Status:** accepted · 2026-10-14

## Context

Invariant I2 says a watched account's recorded movements add up to the balance the chain reports. It
is the check that catches a source quietly leaving something out, so it has to be exact, and it must
not report a match when a movement is missing.

Comparing "the balance now" with "everything recorded so far" fails on any account that is still
transacting: whatever lands between reading the feeds and reading the balance shows up as a
difference. That happened during the journal milestone: the check was out by 12,224 stroops, which
turned out to be two 6,112-stroop fees paid by a bot account during the run. The first fix
re-synced and re-read the balance until nothing new arrived. That converges only if the account
goes quiet, which a busy account may never do.

What Horizon offers (checked against live testnet and pubnet responses, 2026-10-14):

- Each trustline in the `balances` of `GET /accounts/{id}` carries `last_modified_ledger`, the
  ledger it last changed in. The native line does not: native lives on the account entry, whose own
  `last_modified_ledger` covers it.
- State responses such as `/accounts/{id}` carry a `Latest-Ledger` header. History feeds
  (`/effects`, `/transactions`) do not, so a feed cannot say how far it had ingested when it
  answered.
- A Horizon deployment can run several servers behind a load balancer, and they need not have
  ingested the same ledger at the same moment.

## Decision

Pin each comparison to the ledger the balance last changed in. A balance has been exactly its value
since `last_modified_ledger`, so the recorded movements in that asset up to and including that
ledger must add up to it, however much happens afterwards.

`attestBalances()` does, per account:

1. Read the snapshot: balances and their ledgers, and the `Latest-Ledger` of the response.
2. Catch every movement source up (`sync()` until caught up). The snapshot comes first, so every
   movement through its ledgers has had the chance to be recorded.
3. Compare per asset. An asset with recorded movements but no balance line must sum to zero as of
   the snapshot's ledger. An asset the account issues has no balance line to compare with and is
   reported as `issuer`, not attested. Liquidity pool shares are skipped; nostro does not record
   them as movements.
4. On a mismatch, wait about a ledger and repeat steps 2–3 against the same snapshot, a bounded
   number of times. Only a mismatch that survives is reported.

## Consequences

- A busy account converges: the pin never moves, so there is nothing to chase.
- A source answering from a server still behind the pinned ledger causes a temporary mismatch that
  the retry absorbs. A real gap stays a mismatch. Neither can turn a missing movement into a match,
  because the pin only ever excludes movements after the ledger the balance last changed in.
- Attesting ingests: whoever asks for it gets the same writes `sync()` makes. `doctor()` writes
  nothing unless asked to attest.
- Issuer accounts are not covered. Attesting them needs the asset's supply, not a balance line.
- Like everything about ingest from the start of history, this only holds for an account whose whole
  history Horizon still retains (ADR 0006).
