# Ingesting account history while reconciling new payments

Proposed for maintainer review. These four changes share one constraint. A cursor can advance only when the store commits the movements and evidence it covers.

## Included in this PR

- **Archive.** `archiveBatchRange(bytes)` reads the inclusive range and checks the record count in an uncompressed SEP-54 batch header. The fixture `fixtures/archive/pubnet/FFFF0687--63864.xdr.zst` is 266 bytes with SHA-256 `640f89f9bfecaee6f2b424a0055b7a62bd22eeae5549f8a46490d4a01513e096`. Its decompressed header identifies a single ledger at 63864. [Original archive object](https://aws-public-blockchain.s3.us-east-2.amazonaws.com/v1.1/stellar/ledgers/pubnet/FFFFFFFF--0-63999/FFFF0687--63864.xdr.zst)
- **Ledger coverage.** The RPC client and token source expose the optional `latestLedger` reported by the server that answered `getEvents`. It describes the server tip. Certifying an account still requires proof that every page through that ledger has committed.
- **Source records.** A direct Horizon source pull accepts `includeSourceRecords: true` to return the raw normaliser inputs for the consumed page. The effects result includes joined operations. The fees result includes transactions. Persistence and movement-level links are proposed below.
- **Live positions.** Both Horizon sources expose `latestCursor(account)`. A caller can capture the current position, then pass it to a later pull to resume after that record. The existing `latest` start mode uses the same method.

## Archive history and the Horizon boundary (#34)

I propose an optional archive source package that reads Galexie batches, decodes them with Stellar SDK XDR types, and keeps the dependencies out of core. Galexie documents S3 and GCS. SEP-54 specifies the partition and batch keys and the Zstandard-compressed XDR. Stellar's example names an AWS Open Data pubnet bucket. I verified anonymous access to ledger 63864 in that bucket (HTTP 200, 266 bytes compressed). That is a small decoder fixture. I'd also select real ledgers containing a payment and fee for the balance tests. [Galexie storage](https://developers.stellar.org/docs/data/indexers/build-your-own/galexie/admin_guide/prerequisites) · [SEP-54](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0054.md) · [Public bucket configuration](https://developers.stellar.org/docs/build/apps/ingest-sdk/ingestion-pipeline-code)

I'd derive per-operation account and trustline balance changes from ledger entries so pre-CAP-67 history is covered. Fee processing gets its own movement for the actual payer, including failed and fee-bump transactions and refunds. The adapter must preserve separate operations, use integer stroops, and stop with the cursor still at the last complete ledger if a metadata version lacks the information needed to reconstruct a movement.

I'd persist the first Horizon-owned ledger per tenant, network and account before either reader starts. The archive owns every earlier ledger. Both Horizon feeds enforce that same lower bound on replay and restart. A missing archive object or Horizon retention moving past the seam leaves an explicit gap. I'd cover the boundary, restart, fees and offline fixture replay, then document an older account's attestation result once verified.

Does this ownership boundary and choice of ledger-entry changes work for you?

## Ledger coverage per stream (#35)

I'd add an optional inclusive `completeThroughLedger` to `PullResult` and store it with the stream cursor in the same transaction as the movements. An empty page can advance the watermark even when the cursor stays put. The account read returns the minimum across all required streams and reports unknown if any lacks contiguous coverage. A retention gap or unfinished backfill prevents certification across the gap. The CLI would show this in text and JSON. Period close and doctor could consume the same read later.

For Horizon, an ordered account record at ledger L proves we crossed earlier available history through L−1. It costs no extra request and avoids certifying a partially consumed ledger. The hard case is a quiet account. I'd support a pinned Horizon history backend with a documented monotonic database view: sample its root before a catch-up pull and publish that sample only once that same backend exhausts the relevant feed. A retry or failover that loses that guarantee discards the sample. For a public load balancer with no such guarantee, I'd keep the last provable watermark. Two independent requests can otherwise produce the same answers when a payment is missing and when the account is genuinely quiet. For RPC I'd use the response's ledger only through the fully scanned range after accounting for pagination.

I'd test mismatched root/feed replicas with a hidden payment, a quiet pinned backend, partial pages, empty pages and atomic writes across all three stores. Is the pinned-backend requirement acceptable for advancing a quiet Horizon stream, or do you require that guarantee on public load-balanced Horizon as well?

## Raw records behind a movement (#36)

I propose opt-in capture on the sync request. Sources can return raw records with their type, source-native ID, payload, and references from movement external IDs. For Horizon I'd retain effects, operations and transactions, removing only `_links` and preserving the joined transaction relationship for replay. Capture off keeps the existing ingest path.

Within the cursor transaction, store immutable record versions keyed by tenant, network, provider, record type, native ID and a digest of canonical JSON. Link each version to every movement it supported, including on duplicate delivery. That lets effects and fees share a transaction, and preserves both payloads when the same upstream ID changes. The library and CLI read by movement ID within the tenant. Conflict evidence can reference the original and incoming versions.

I measured compact JSON for 31 value effects in the checked-in fixtures. The median effect plus joined operation was 3,255 bytes. At 53,740 movements that gives about 167 MiB of payload before deduplication, indexes, or database overhead. The transaction mix and repeated operations will affect the actual size. I'd defer application-level compression initially and measure a captured account before adding a codec.

I'd add migrations and conformance cases for all three stores, including rollback, shared records, differing deliveries and tenant isolation. A test-only replay helper would reconstruct the original normaliser inputs from one capture and diff movement facts. Does this capture and versioning contract work for you?

## Live reconciliation during backfill (#37)

I propose an opt-in per-account start mode. I'd persist an immutable pin for each account feed, with separate live and backfill cursor positions under the existing source identity. The backfill owns records up to and including its pin. Live owns records after it. For effects the boundary must cover a whole operation. An empty feed starts at zero. Initialization and each lane's updates use transactional concurrency checks so competing workers and restarts keep the same pin. Existing cursors continue under their original start mode.

Each round reserves work for live ingestion and reconciliation first, then gives backfill a bounded page budget. Historical movements enter the balance and audit history immediately. For movements that might match an expectation, I'd record a reviewable historical exception in the insert transaction so they never enter automatic matching, including against expectations created after the pin. Existing live allocations remain final. This deliberately makes automatic matching of pre-pin invoices a manual review decision. Existing fee and other explicit non-matching dispositions can retain their usual treatment.

Doctor would report which feeds still have incomplete history and withhold the account's attestation until both backfills reach their pins and any retention gaps are accounted for. The per-account start configuration supplies the lower bound, including any opening-balance cutoff, independently of the live pin. I'd test immediate live settlement during backfill, crash/restart, random pin and page boundaries, and a historical payment sharing the live payment's invoice reference.

Does the explicit review policy for historical payments match what you want for onboarding?
