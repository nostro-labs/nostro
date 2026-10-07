# Contributing to nostro

## Setup

```bash
pnpm install
pnpm build
pnpm test
```

Node ≥ 22 (Node 20 reached end-of-life on 2026-04-30), pnpm 10.16.

## Layering rule

`packages/server` may **not** import `packages/core/src/matching/**` internals — only the public
`Reconciler` facade. The service is a thin composition of the library; this rule is what stops the
two execution modes from drifting apart, and CI enforces it.

## Non-negotiables

- **No floats for money.** Amounts are `Money` (bigint raw units + decimals). `Number()` on an amount
  field fails lint. If you need proportional splitting, use exact integer allocation with
  largest-remainder distribution — never floating-point division.
- **Assets compare on `CODE:ISSUER`.** Never on code alone. A lookalike issuer is a different asset,
  and treating it otherwise is a security bug.
- **The idempotency gate fails closed.** If we cannot prove an event is new, we treat it as a
  duplicate and re-read — never assume "probably new" and apply the effect.
- **Nothing is silently dropped.** Every movement ends in an explicit disposition (invariant I1).

## Adding a matching strategy

1. Create `packages/core/src/matching/strategies/<name>.ts` implementing `MatchStrategy`.
2. Register it in the strategy index with a documented base score.
3. Add fixtures under `fixtures/<scenario>/`.
4. State the false-positive risk in the docstring. A strategy that can match on its own must justify
   why; corroborating-only strategies must score below the confidence threshold.

The engine is a pure function — `(movement, candidates, config, clock) → Decision` — so strategies
are testable with no network and no database.

## Recording fixtures

Fixtures are real Horizon responses; see [`fixtures/horizon/README.md`](./fixtures/horizon/README.md)
for how they were captured and what each file holds. A recorder that captures them automatically is
planned. Every bug fix should arrive with the fixture that reproduces it.

## Claiming an issue

Comment on it. If there's no activity for 7 days it goes back in the pool. Please don't open a PR
against an issue someone else has claimed.

## Commits and PRs

Conventional Commits (`fix(matching): ...`). PRs state which invariants they touch, include fixtures
for behaviour changes, and update docs. Sign off with DCO (`git commit -s`).
