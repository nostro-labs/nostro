# nostro with Docker Compose

PostgreSQL, `nostro migrate` (once), `nostro serve`, and a webhook receiver that verifies every
request's signature with `verifyWebhook()` from nostro.

```sh
cp .env.example .env    # then fill it in: openssl rand -hex 32 for each secret
docker compose up -d --build
docker compose logs -f receiver
```

With `NOSTRO_ACCOUNTS` set to a testnet account, `serve` syncs and reconciles it every 30 seconds,
and each decision arrives at the receiver as a signed event:

```
receiver-1  | verified movement.decided 2f6c…
receiver-1  | verified exception.opened 9a1d…
```

The API listens on 127.0.0.1:8080:

```sh
curl -H "Authorization: Bearer <key>" localhost:8080/v1/exceptions
curl localhost:8080/v1/openapi.json
```

`migrate` runs before `serve` starts and is the only thing that changes the schema; run
`docker compose run --rm migrate` after upgrading the image. `docker compose down` stops
everything cleanly; add `-v` to delete the database too.
