# nostro

**Payment reconciliation and ledger-to-accounting infrastructure for Stellar.**

> **Status: pre-alpha (`0.0.1`).** The `Money`/`Asset` core is implemented and tested.
> Ingestion, matching, and the journal are in progress — see [Roadmap](#roadmap).
> Nothing here is production-ready yet, and this README marks what exists versus what doesn't.

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
