#!/usr/bin/env bash
# Runs a Kore ID image the way an operator does and checks that it answers. The image workflow runs it on the
# image it just published; run it by hand to try any image:
#
#   scripts/smoke.sh                                   # ghcr.io/qarasky/kore-id:edge (pulled)
#   KORE_ID_IMAGE=kore-id:local SMOKE_PULL=0 scripts/smoke.sh
set -euo pipefail

IMAGE="${KORE_ID_IMAGE:-ghcr.io/qarasky/kore-id:${KORE_ID_VERSION:-edge}}"
PORT="${SMOKE_PORT:-18640}"
NAME="kore-id-smoke-$$"
WORK="$(mktemp -d)"
chmod 777 "$WORK" # the container runs as node (1000)

cleanup() {
  status=$?
  [ "$status" = 0 ] || docker logs "$NAME" 2>&1 | tail -40 || true
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  rm -rf "$WORK"
  exit "$status"
}
trap cleanup EXIT
fail() { echo "smoke: $*" >&2; exit 1; }
status_of() { curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$@"; }

[ "${SMOKE_PULL:-1}" = 1 ] && docker pull --quiet "$IMAGE" >/dev/null

# A clients file like `npm run init-clients` writes.
docker run --rm -v "$WORK:/data" "$IMAGE" node scripts/init-clients.ts >/dev/null
docker run -d --name "$NAME" -p "127.0.0.1:$PORT:4000" -v "$WORK:/data" -e "ISSUER=http://127.0.0.1:$PORT" "$IMAGE" >/dev/null

for _ in $(seq 1 30); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$NAME")" = healthy ] && break
  sleep 1
done
[ "$(docker inspect -f '{{.State.Health.Status}}' "$NAME")" = healthy ] || fail "container never became healthy"

base="http://127.0.0.1:$PORT"
[ "$(status_of "$base/healthz")" = 200 ] || fail "GET /healthz did not answer 200"
docker logs "$NAME" 2>&1 | grep -q "$base/setup/" || fail "no admin setup link in the logs"
curl -sf "$base/login" | grep -q 'id="root"' || fail "GET /login did not serve the web UI"
[ "$(status_of "$base/api/me")" = 401 ] || fail "GET /api/me without a session did not answer 401"
curl -sf "$base/.well-known/openid-configuration" | grep -q "\"issuer\":\"$base\"" || fail "discovery has the wrong issuer"
[ "$(docker exec "$NAME" id -u)" != 0 ] || fail "the container runs as root"
echo "smoke: ok ($IMAGE)"
