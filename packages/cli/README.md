# nostro-cli

The command line for [nostro](https://github.com/nostro-labs/nostro): ingest a Stellar account's
history from Horizon and reconcile it, from a shell or a cron job, against a SQLite file or
PostgreSQL.

```sh
nostro migrate                       # create ./nostro.db
nostro sync --account G...           # ingest every effect and fee Horizon keeps, until caught up
nostro reconcile                     # decide every pending movement, posting each to the journal
```

| Command | What it does |
|---|---|
| `migrate` | Creates the database, or applies the migrations it is missing. The only command that changes the schema; every other one refuses a database that is not exactly at the version it expects. |
| `sync` | Ingests effects and fees for each `--account`, until caught up (or one round with `--once`). |
| `reconcile` | Matches pending movements against expectations and posts each decision to the journal. |

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
