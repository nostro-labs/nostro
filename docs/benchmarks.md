# Benchmarks

How fast nostro is, per store, and how to reproduce the numbers.

## Reproduce

```bash
pnpm install
export NOSTRO_BENCH_PG_URL=postgres://...      # optional; PostgreSQL is skipped if unset
pnpm bench -- --sizes 10000,100000
```

Results are written to `bench-results/*.json`. Data is generated from seed 121; each file
includes a SHA-256 of the generated data, so identical hashes mean identical movements.

## Machine
<fill in: CPU, cores, RAM, OS, Node version, PostgreSQL version, date, git SHA>

## Results (10,000 movements, shape: payments)
| store | sync | reconcile | postJournal | doctor | journalCsv |
|---|---|---|---|---|---|
| memory | ... | ... | ... | ... | ... |
| sqlite | ... | ... | ... | ... | ... |
| postgres | ... | ... | ... | ... | ... |

## Query counts (10,000 movements)
<table of queries per operation; shows where cost grows per movement, e.g. doctor()>

## Results (100,000 movements)
<same tables>

## Noise
Same commit, 10 runs: worst coefficient of variation X% locally, Y% on CI.
CI fails a PR when query count rises >10% (deterministic). Wall time is reported and warns above Z×.

## Findings
<anything unexpectedly slow, with a link to the issue you filed>