# ADR 0004 — Money is bigint raw units, never a float

**Status:** accepted · 2026-09-07

## Context

Horizon returns amounts as decimal strings (`"12.5000000"`). Classic assets use 7 decimals, so
1 XLM = 10,000,000 stroops. `Number` cannot hold every stroop value above 2^53 (~900M XLM), and
cannot represent most 7-decimal fractions exactly — `0.1 + 0.2 !== 0.3`. SEP-41 contract tokens may
declare any number of decimals.

Financial software that rounds silently is worse than financial software that crashes.

## Decision

`Money = { raw: bigint, asset: AssetId, decimals: number }`. Constructors reject `number` **at
runtime**, not merely in the type signature. `Money.parse` refuses a fractional part longer than the
asset's decimals rather than rounding. Arithmetic requires matching asset *and* decimals.

Database columns are `NUMERIC(40,0)` raw units plus a separate `decimals SMALLINT`.

## Consequences

- Every amount crossing a boundary is a string or a bigint; JSON carries `raw` as a string.
- A lint rule bans `Number()` on amount fields.
- Assets are compared as `CODE:ISSUER`, so a lookalike issuer can never settle the wrong expectation.
