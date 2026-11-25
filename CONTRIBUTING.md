# Contributing to nostro

## Setup

```bash
pnpm install
pnpm build
pnpm test
```

Node ≥ 22 (Node 20 reached end-of-life on 2026-04-30), pnpm 10.16.

## Layering rule

`packages/server` imports nostro only through its public entry point (`'@nostro-labs/nostro'`), never a path
inside `packages/core`, and holds no reconciliation logic of its own. The service is a thin
composition of the library; this rule is what stops the two execution modes from drifting apart, and
a test in `packages/server` fails if it is broken.

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

## Adding a store

A backend implements the contract in [`docs/stores.md`](./docs/stores.md): tenant scoping,
transaction-only writes, locking reads, events written with the decision, stable constraint names and
idempotent migrations. Run the shared suites from `@nostro-labs/store-conformance` in the store's own
test suite with the current `STORE_CONTRACT_VERSION`, and add the package to `PACKAGES` in
`scripts/check-packages.mjs` when it is published. The suites are the definition of conformance; do
not weaken them to accommodate a backend.

## Recording fixtures

Fixtures are real Horizon responses; see [`fixtures/horizon/README.md`](./fixtures/horizon/README.md)
for what each file holds. Record one with:

```bash
pnpm build
node scripts/record-fixture.mjs <operation-id> --scenario <name> [--testnet]
```

This fetches `/operations/{id}?join=transactions` and every page of that operation's effects, strips
`_links` and nothing else, and writes `fixtures/horizon/pubnet/<name>.json` (or `testnet/<name>.json`
with `--testnet`). It refuses to overwrite an existing fixture. Every bug fix should arrive with the
fixture that reproduces it.

In tests, `FixtureSource` (from `nostro-testkit`) replays a captured fixture through the normaliser
as a `MovementSource`, so a real record can be ingested in a few lines:

```ts
const source = new FixtureSource({ fixture: new URL('payment-text-memo.json', dir) })
const { movements } = await source.pull({ tenantId, account, cursor: null, limit: 100 })
```

## Claiming an issue

Comment on it. If there's no activity for 7 days it goes back in the pool. Please don't open a PR
against an issue someone else has claimed.

## Commits and PRs

Conventional Commits (`fix(matching): ...`). PRs state which invariants they touch, include fixtures
for behaviour changes, and update docs. Sign off with DCO (`git commit -s`).

## Releasing

All seven published packages (`core`, `store-conformance`, `store-sqlite`, `store-postgres`,
`store-mysql`, `server` and `cli`) share one version. To release:

1. Set the version in each published `packages/*/package.json` (`nostro-testkit` is never published)
   and run `pnpm install` so the lockfile agrees.
2. Give the release a date in `CHANGELOG.md`: `## 0.1.0 (2026-10-25)`.
3. Run `pnpm build && node scripts/check-packages.mjs` locally. The build emits
   `packages/store-conformance/dist`; the check packs all seven tarballs, installs them into an empty
   project and uses them, including running the published conformance suites, as a user would.
4. Merge to `main`, then run **Actions → Release** with the version. It refuses unless the version
   matches every package and the changelog entry is dated. It runs the whole test suite and the
   package check, publishes to npm with provenance, then tags `v<version>` and creates the GitHub
   release from the changelog.

Publishing needs an npm automation token in the `NPM_TOKEN` repository secret. Packages are published
with provenance, which only works from CI, so a local `npm publish` is refused unless you pass
`--no-provenance`. Don't do that for a real release.


### Container image

After the npm publish succeeds, `release.yml` calls `.github/workflows/image.yml`, which builds
`ghcr.io/nostro-labs/nostro` for `linux/amd64` and `linux/arm64`, smoke-tests each architecture
(`scripts/smoke-image.sh`), and pushes the tags `X.Y.Z`, `X.Y` and (stable releases only) `latest`.
There is no bare `X` tag while the major version is 0. Pre-releases get only their exact tag.

Re-running a release is safe: if `ghcr.io/nostro-labs/nostro:X.Y.Z` already exists the image step does nothing.

To dry-run on a fork: Actions → image → Run workflow, version `0.0.0-dryrun.1`. It pushes to
`ghcr.io/<your-user>/nostro`.

Inspect the attestations:

    docker buildx imagetools inspect ghcr.io/nostro-labs/nostro:X.Y.Z
    docker buildx imagetools inspect ghcr.io/nostro-labs/nostro:X.Y.Z --format '{{ json .SBOM }}'
    docker buildx imagetools inspect ghcr.io/nostro-labs/nostro:X.Y.Z --format '{{ json .Provenance }}'

After the first push, a maintainer must make the package public and link it to the repository
(Package settings on GitHub).