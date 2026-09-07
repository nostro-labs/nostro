## Summary

<!-- What changes, and why? -->

## Linked issue

Closes #

## Invariants

<!-- Does this affect I1 (total disposition), I2 (balance attestation) or I3 (journal balance)? -->

- [ ] No invariant behaviour changes
- [ ] Invariant behaviour changes, described above and covered by tests

## Checklist

- [ ] `pnpm typecheck && pnpm build && pnpm test` pass locally
- [ ] No floats for money; assets compared on `CODE:ISSUER`
- [ ] Fixtures added for behaviour changes
- [ ] Docs updated where relevant
- [ ] Signed off (`git commit -s`)
