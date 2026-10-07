# nostro

[![CI](https://github.com/nostro-labs/nostro/actions/workflows/ci.yml/badge.svg)](https://github.com/nostro-labs/nostro/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)

**Payment reconciliation and ledger-to-accounting infrastructure for Stellar.**

> **Status: pre-alpha (`0.0.1`, not yet on npm).** Implemented and tested: the `Money`/`Asset`
> core, the record model (movements, expectations, allocations, exceptions), the transactional
> `Store` contract with in-memory, SQLite (`nostro-store-sqlite`) and PostgreSQL
> (`nostro-store-postgres`) stores that pass one shared conformance suite, and Horizon ingestion
> (effects and fees) through a bounded `sync()` loop, and matching through `reconcile()`. The journal,
> balance invariants and CLI are in progress — see [Roadmap](#roadmap). Nothing here is production-ready yet, and this README marks what exists
> versus what doesn't.

## The problem

Every payments, payroll, escrow, subscription and invoicing product on Stellar has to answer one
question: *did this expected payment actually arrive, in full, from whom, and how do I record it?*

Almost everyone answers it like this:

```ts
server.payments().forAccount(ACCOUNT).stream({
  onmessage: (op) => {
    if (op.type === 'payment' && op.amount === invoice.amount) markInvoicePaid(invoice.id)
  },
})
```

That code is wrong in at least six ways, and every one of them is a real incident:

- `/payments` **never sees** a payment that arrived through a Soroban contract (SAC `transfer`),
  a claimable balance, or a trade. Those only appear on `/effects`.
- A dropped SSE reconnect silently loses events; nothing detects the gap.
- `op.amount` matching ignores the **issuer**, so a lookalike `USDC` from any issuer settles a real invoice.
- Partial payments, overpayments and duplicate deliveries all fall through.
- `amount` parsed as a `number` loses stroops above ~900M XLM and can't hold most 7-decimal values.
- A restart re-reads from an unknown cursor and re-applies effects that already committed.

nostro is the layer that gets this right once, so each product doesn't re-derive it badly.

## Ingesting an account (works today)

```ts
import { HorizonClient, HorizonEffectsSource, HorizonFeesSource, MemoryStore, sync } from 'nostro'

const client = new HorizonClient({ url: 'https://horizon-testnet.stellar.org' })
const store = new MemoryStore()
for (const source of [
  new HorizonEffectsSource({ client, network: 'testnet' }), // every credit, debit, trade, pool move
  new HorizonFeesSource({ client, network: 'testnet' }), //    fees are not effects; read them too
]) {
  const report = await sync({ store, source, tenantId: 'acme', accounts: ['G...'] })
  console.log(source.name, report.inserted, 'new movements', report.errors)
}
```

`sync()` is bounded and resumable: call it again to continue. The cursor advances in the same
transaction as the movements it covers, so a crash can never skip or double-apply a batch.

**Checked against the network.** `scripts/check-balances.mjs` ingests an account's whole history
and compares the per-asset sum of its movements with the balances Horizon reports. On 2026-10-06,
three testnet accounts matched to the stroop, including a DEX-trading account (6,674 movements
across four assets) and a Soroban bot account (50,875 movements). The rules that make that hold,
and two places where the obvious reading of Horizon is wrong, are in
[ADR 0006](./docs/adr/0006-normalising-horizon-effects.md).

## Reconciling against what you are owed (works today)

```ts
import { Money, NATIVE, reconcile } from 'nostro'

// Record what you are owed. A muxed id gives this invoice its own M... address.
await store.transaction((tx) =>
  tx.insertExpectation({
    tenantId: 'acme',
    reference: 'INV-1042',
    account: 'G...',
    amount: Money.parse('25', NATIVE),
    muxedId: 1042n,
  }),
)

// After sync(): decide every pending movement.
const report = await reconcile({ store, tenantId: 'acme' })
console.log(report.allocated, 'settled', report.exceptions) // e.g. 1 settled { AMBIGUOUS_MATCH: 2 }
```

Payments are matched by muxed id, memo id or text memo (normalised, so `inv #1042` finds `INV-1042`);
an amount alone is only ever a suggestion. Overpayments, duplicates, lookalike assets and late
payments are refused into an exceptions queue with the evidence for each decision. How decisions are
made, and what is not handled yet: [docs/matching.md](./docs/matching.md).

## What it does

```
SOURCE ──▶ INGEST ──▶ MATCH ──┬──▶ JOURNAL ──▶ EXPORT / EMIT
                              └──▶ EXCEPTIONS ──(resolve)──┘
```

Movements are normalised ledger facts; expectations are what you were owed; **allocations** link them
`(movement, expectation, amount)`, which is why partial payments, overpayments, split settlements and
one-wire-covers-six-invoices are all the same mechanism rather than six special cases.

## The invariant

The headline guarantee, checked in CI against every fixture and by `nostro doctor` at runtime:

> **I1 — total disposition.** Every movement is either fully allocated, partially allocated with an
> open exception covering the residual, carries at least one exception, or is explicitly ignored with
> a reason. **Nothing is ever silently dropped.**

Two more back it: **I2** cross-checks accumulated movements against the account's real on-chain
balance (this is what catches a source that quietly omitted events), and **I3** enforces
`Σdebits = Σcredits` per currency as a database constraint.

## Non-goals

- **nostro never signs a transaction and never needs a secret key.** It observes and records. This is
  permanent, not a v1 limitation.
- Not a wallet, not a payment initiator, not an indexer-as-a-service.
- No floats. Ever. Amounts are integer raw units plus decimals; `Money` rejects `number` at runtime.

## Roadmap

| Version | Scope | State |
|---|---|---|
| 0.1 | Horizon ingestion, matching (muxed/memo/amount), exceptions, double-entry journal + CSV, invariants, CLI, server | in progress |
| 0.2 | Chart of accounts, accounting periods, QuickBooks / Xero / Beancount export | planned |
| 0.3 | Stellar RPC source for SEP-41 contract tokens, archive fallback, contract-address watching | planned |
| 0.4 | Exceptions UI, match hints, OpenTelemetry, anchor (SEP-24/31) awareness | planned |
| 0.5 | Hash-chained reconciliation attestations | planned |

## Prior art

[`stellar-payment-watcher`](https://www.npmjs.com/package/stellar-payment-watcher) wraps the payments
SSE stream (unmaintained, no matching or persistence). Stellar's
[Token Transfer Processor](https://developers.stellar.org/docs/data/indexers/build-your-own/processors/token-transfer-processor)
is the canonical event normaliser, but it is Go-only — nostro's `Movement` model deliberately mirrors
its vocabulary so the two stay interoperable.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Good first issues are labelled `good first issue`; the
matching engine is pure and fixture-tested, so you can add a strategy and prove it works offline in
under a minute.

## License

[Apache-2.0](./LICENSE)
