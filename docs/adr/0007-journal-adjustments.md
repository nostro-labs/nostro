# ADR 0007 — The journal posts cash once, then adjusts

**Status:** accepted · 2026-10-12 · amends [ADR 0003](./0003-allocation-model.md)

## Context

ADR 0003 said a reversal is "a reversing journal entry". Building the journal raised the general
question: when how a movement is accounted for changes (an exception resolved by hand, an ignored
movement reclassified, a source correction), what gets posted?

Reverse-and-repost (cancel the old entry in full, post a new one) re-posts the cash leg every time.
Each change then puts two more lines on the wallet's cash account, which no longer reads like the
chain, and every bank-feed style exporter has to filter them back out.

## Decision

Every journal line carries a closed **role** (`cash`, `issued`, `receivable`, `payable`,
`customer_credit`, `unapplied`, `unexplained`, `network_fees`, `uncategorized_income`,
`uncategorized_expense`), and a chart of accounts maps roles to account codes.

For each decided movement nostro computes how it *should* be accounted for, compares that with what is
already posted per (role, asset, expectation), and posts only the difference:

- **initial** — the first entry, including the cash leg, dated when the money moved;
- **reclass** — moves amounts between counter-accounts; cash untouched; dated when it is posted;
- **correction** — changes the cash leg itself; dated like the original entry.

Entries are append-only (PostgreSQL and SQLite refuse UPDATE and DELETE). Each balances per asset
(I3). Posting numbers per movement are a compare-and-set. A movement's cash leg can only ever net to
zero or exactly its amount, which keeps the journal's cash tied to the chain (I2).

## Consequences

- Cash is posted once per movement; the cash account reads like the chain.
- A reversal in ADR 0003's sense is an adjustment entry, not a mirror image of the original.
- Diffs work on roles, not account codes, so changing the chart affects only lines posted from then on,
  and a balance is always cleared from the account it was posted to.
- Back-dating a reclass is impossible by construction, which accounting periods with soft close will
  rely on.
