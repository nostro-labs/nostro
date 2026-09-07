# ADR 0002 — Horizon is the primary source; Stellar RPC is secondary

**Status:** accepted · 2026-09-07

## Context

| | Horizon (SDF) | Stellar RPC |
|---|---|---|
| History retained | ~1 year | ~7 days for events; 24h default for transactions |
| Pagination | HAL `paging_token` cursor | opaque cursor; `pagingToken` removed from `getEvents` in Protocol 23 |
| Streaming | SSE | poll only |

Reconciliation is precisely the workload that runs late — a month-end close, an auditor's question,
a backfill after an outage.

## Decision

Horizon is the primary ingestion source. Stellar RPC is a secondary source used only for non-SAC
SEP-41 contract tokens, which do not surface as classic effects (v0.3).

A seven-day window is disqualifying for a primary source. For history beyond Horizon's window, an
archive source (Galexie data lake / Token Transfer Processor output) is planned in v0.3.

## Consequences

- Users pointed at a Horizon with a shorter window are warned at startup rather than silently
  receiving empty pages.
- Contract-token coverage is explicitly incomplete until v0.3, and the README says so.
