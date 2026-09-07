# nostro

**Payment reconciliation and ledger-to-accounting infrastructure for Stellar.**

> **Pre-alpha (`0.0.1`).** The `Money` / `Asset` core is implemented and tested. Ingestion, matching
> and the journal are in progress. This release exists to reserve the name and publish the
> foundation — it is not yet usable for reconciliation.

Every payments, payroll, escrow and invoicing product on Stellar has to answer: *did this expected
payment actually arrive, in full, from whom, and how do I record it?* Almost everyone answers it with
a Horizon `payments` stream and an amount comparison — which never sees SAC transfers or claimable
balances, ignores the asset issuer, drops events on reconnect, and re-applies effects after a
restart. nostro is the layer that gets this right once.

## What works today

```ts
import { Money, asset, NATIVE, isSameCodeDifferentIssuer } from 'nostro'

// Amounts are exact integer stroops — never floats.
Money.parse('0.1', NATIVE).add(Money.parse('0.2', NATIVE)).toString() // '0.3000000'

// Values beyond IEEE-754 integer range survive intact.
Money.parse('1000000000000', NATIVE).raw // 10000000000000000000n

// A value we cannot represent exactly is an error, not a silent rounding.
Money.parse('0.00000001', NATIVE) // throws PrecisionError

// Assets carry their issuer. A lookalike never settles the real thing.
const real = asset('USDC', 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN')
const fake = asset('USDC', 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW')
isSameCodeDifferentIssuer(real, fake) // true
Money.parse('1', real).add(Money.parse('1', fake)) // throws AssetMismatchError
```

## Non-goals

**nostro never holds, requests, or signs with a secret key.** It observes and records; it cannot move
funds. That is permanent, not a v1 limitation.

## Documentation

Architecture, the reconciliation invariants, and the design records live in the repository:
**https://github.com/nostro-labs/nostro**

## License

Apache-2.0
