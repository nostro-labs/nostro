# Security Policy

## Reporting

Please report vulnerabilities privately via GitHub's **Report a vulnerability** (Security tab).
Do not open a public issue.

## Threat model

nostro reads ledger data and reconciles it against expectations. It is worth being explicit about
what it does and does not defend against.

**nostro never holds, requests, or signs with a secret key.** It cannot move funds. A compromise of
nostro cannot directly cause a payment.

Attacks it is designed to resist:

- **Lookalike asset issuers.** Assets compare on `CODE:ISSUER`. A `USDC` from an arbitrary issuer
  never settles an expectation denominated in Circle's USDC; it raises `WRONG_ASSET`.
- **Memo spoofing.** A sender-supplied memo is an *unauthenticated* claim about which invoice is
  being paid. Memo strategies score below muxed-account attribution, and a memo matching an already
  settled expectation raises `DUPLICATE_PAYMENT` rather than re-settling it.
- **Replay.** Movement identity is `(network, source, external_id)` with the ledger write and the
  cursor advance in one transaction, so redelivery cannot double-apply a business effect.
- **Source omission.** Invariant I2 cross-checks accumulated movements against the on-chain balance,
  so a source that silently drops events is detected rather than trusted.

Out of scope: the security of the Horizon/RPC endpoint you point nostro at, and the correctness of
expectations your own system creates.
