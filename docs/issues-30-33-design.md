# Proposed Horizon ingestion changes

These four proposals are ready for design review. Implementation and acceptance tests are pending.

## #30 · Failover and stale Horizon servers

Use the first healthy URL in configuration order. Give each URL a rate limiter and a cached root snapshot shared by effects, fees and balance reads. Check the configured network passphrase before accepting data. As initial defaults, refresh health every 30 seconds and consider a ledger close more than 120 seconds old stale. Report the selected endpoint, its latest ledger, and a reason for each skipped endpoint. When none qualifies, leave the cursor unchanged and return a failing sync status, including for a single configured URL.

Pin every request in a pull to one endpoint. On failure discard the uncommitted page and retry the entire pull from the stored token. Preserve the complete effect token, including its order within the operation. Require the fallback's history window to cover the resume point and its tip to reach the last observed ledger before declaring catch-up. Verify identical pagination across endpoints, including a page boundary inside an operation, before shipping repeatable `--horizon` options.

## #31 · Missing operation enrichment

Only a failed operation lookup should trigger an extra root check. Compare the operation's ledger to the retained window. If it precedes the window on every usable endpoint, record the movement with missing enrichment. Otherwise, commit only complete operations before the missing ID and retry that ID on a later poll. A blocked first operation yields no cursor advance and should end the current polling round.

Proposed bound: three failed polls per stream and operation. Persist the attempt count across process restarts. On exhaustion, emit a gap with the operation ID, ledger, endpoint and attempt count, and store the movement with missing enrichment. Clear the counter on success or final disposition. The fee source reads complete transactions directly and needs no operation lookup. Cover recovery with a memo-matched invoice, permanent loss, and an ordinary pull's request count.

## #32 · Unknown effect, operation and memo types

Maintain one classification table pinned to the Horizon source revision, including the numeric effect discriminants. For effects, distinguish value movement from known administrative changes. For operations and memos, record which types provide enrichment. A signer change stays silent. For an unknown effect, operation or memo, retain the original record and report a typed gap using the existing ingest exception path. Commit the evidence with the cursor so a restart cannot advance past a warning that was lost.

For a known credit with unknown operation or memo metadata, retain its amount and asset, mark enrichment incomplete, and hold automatic matching. For an unknown effect, avoid inventing a monetary amount. Deduplicate warnings by record identity. Fixtures should cover all three unknown-type cases and a known non-value effect. [Horizon effect definitions](https://github.com/stellar/stellar-horizon/blob/4e13b1bea4c87e770447814a242384e0eb00c015/internal/db2/history/effect.go) · [Effect adapter](https://github.com/stellar/stellar-horizon/blob/4e13b1bea4c87e770447814a242384e0eb00c015/internal/resourceadapter/effects.go)

## #33 · Liquidity pool shares

Use `pool:<64 lowercase hex digits>` as a distinct asset ID, with seven decimal places, no issuer and no classic-asset lookalike matching. Deposit credits `shares_received`, withdrawal debits `shares_redeemed`, and revocation debits `shares_revoked`. Horizon also supplies `reserves_revoked` and the pool details. Reconcile any resulting claimable balances separately from spendable account reserves. Add a share-specific external ID on each effect and preserve all existing reserve movement IDs. [Horizon revocation processor](https://github.com/stellar/stellar-horizon/blob/4e13b1bea4c87e770447814a242384e0eb00c015/internal/ingest/processors/effects_processor.go#L1418-L1424)

Give share movements an explicit liquidity-operation disposition so they bypass invoice matching. Post the share asset to a pool-share holdings account with a liquidity clearing counterpart. Attest the share trustline at its own `last_modified_ledger`, including opening balances. Exercise the captured deposit and withdrawal fixtures, a missing share movement, and a re-read of existing reserve movements before updating the invariant claims.
