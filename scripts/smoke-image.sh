#!/usr/bin/env bash
# Smoke-test a nostro container image: migrate, serve, 401 without a key,
# turns healthy, stops cleanly.  Usage: scripts/smoke-image.sh <image>
set -euo pipefail

IMAGE="${1:?usage: smoke-image.sh <image>}"
NAME="nostro-smoke-$$"
DATA="$(mktemp -d)"
PORT="${PORT:-3000}"                       # ADAPT: the port the server listens on
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true; rm -rf "$DATA"' EXIT

echo "arch: $(docker image inspect "$IMAGE" --format '{{.Architecture}}')"

# 1. migrate (this also proves better-sqlite3 loads on this architecture)
docker run --rm -v "$DATA:/data" "$IMAGE" migrate --db /data/nostro.db      # ADAPT: flags from ci.yml

# 2. serve
docker run -d --name "$NAME" -v "$DATA:/data" -p "$PORT:$PORT" \
  -e NOSTRO_API_KEY=smoke-key \
  "$IMAGE" serve --db /data/nostro.db --port "$PORT"                         # ADAPT: flags/env from ci.yml

# 3. wait for the HTTP server
for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/v1/openapi.json" || true)  # ADAPT: an endpoint from ci.yml
  [ "$code" != "000" ] && break
  sleep 1
done

# 4. 401 without a key
code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/v1/movements")               # ADAPT: a protected route
[ "$code" = "401" ] || { echo "expected 401, got $code"; docker logs "$NAME"; exit 1; }

# 5. HEALTHCHECK turns healthy
for i in $(seq 1 60); do
  status=$(docker inspect --format '{{.State.Health.Status}}' "$NAME")
  [ "$status" = "healthy" ] && break
  [ "$status" = "unhealthy" ] && { echo "unhealthy"; docker logs "$NAME"; exit 1; }
  sleep 2
done
[ "$status" = "healthy" ] || { echo "never became healthy (last: $status)"; docker logs "$NAME"; exit 1; }

# 6. clean stop
docker stop -t 20 "$NAME" >/dev/null
exit_code=$(docker inspect --format '{{.State.ExitCode}}' "$NAME")
[ "$exit_code" = "0" ] || { echo "unclean stop, exit code $exit_code"; docker logs "$NAME"; exit 1; }

echo "smoke OK"