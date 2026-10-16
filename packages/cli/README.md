# nostro-cli

The command line for [nostro](https://github.com/nostro-labs/nostro): ingest a Stellar account's
history from Horizon and reconcile it, from a shell or a cron job, against a SQLite file or
PostgreSQL.

```sh
nostro migrate                                       # create ./nostro.db
nostro sync --account G...                           # ingest every effect and fee Horizon keeps
nostro expect INV-1042 --account G... --amount 25    # record what you are owed
nostro reconcile                                     # decide every pending movement, and post it
nostro exceptions                                    # what needs a person, and why
```

| Command | What it does |
|---|---|
| `migrate` | Creates the database, or applies the migrations it is missing. The only command that changes the schema; every other one refuses a database that is not exactly at the version it expects. |
| `sync` | Ingests effects and fees for each `--account`, until caught up (or one round with `--once`). |
| `expect` | Records an expectation: a reference, an account, an amount, and optionally a muxed id, a memo, payers, due and expiry dates. Never rounds an amount. |
| `expectations` | Lists expectations with what has been allocated to each. |
| `reconcile` | Matches pending movements against expectations and posts each decision to the journal. |
| `exceptions` | Lists what reconcile would not decide alone, with the reason (and, in `--json`, the evidence). |

Resolving exceptions from the command line is not there yet: resolving one by hand can leave its
movement's disposition unsupported (see `docs/invariants.md`), so it needs a workflow that
allocates or ignores the movement in the same step.

Every command takes `--db` (a SQLite file, `sqlite:<path>`, or a `postgres://` URL; default
`./nostro.db`), `--tenant` (default `default`) and `--json`. `nostro <command> --help` lists the
rest. Options can also come from the environment:

| Variable | Option |
|---|---|
| `NOSTRO_DB` | `--db` |
| `NOSTRO_TENANT` | `--tenant` |
| `NOSTRO_ACCOUNTS` | `--account`, comma or space separated |
| `NOSTRO_NETWORK` | `--network` (`testnet`, the default, or `public`) |
| `NOSTRO_HORIZON_URL` | `--horizon` |
| `NOSTRO_PG_SCHEMA` | the PostgreSQL schema to use (default `nostro`) |

Exit status is 0 on success, 1 when the command failed or found a problem, and 2 when the command
line was wrong. A password in a `postgres://` URL is never printed. Text that came from a payment,
such as a memo, is printed with control characters escaped, so it cannot rewrite your terminal.

nostro never signs a transaction and never needs a secret key.

**Status:** pre-alpha, not yet published.
