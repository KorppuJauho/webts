#!/bin/sh
# Starts a WebTS image the way docker-compose.yml runs it (read-only, no capabilities, no new privileges) and checks
# that it becomes healthy and serves the page. Used by the checks and the release workflow.
# Usage: scripts/smoke-test.sh <image>
set -eu
image="$1"
name="webts-smoke-$$"

cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run -d --name "$name" \
    --read-only --tmpfs /tmp \
    --mount type=tmpfs,destination=/app/data,tmpfs-mode=1777 \
    --cap-drop ALL --security-opt no-new-privileges:true \
    -e ACCESS_MODE=public -e I_UNDERSTAND_THIS_IS_PUBLIC=true -e TS_HOST=127.0.0.1 \
    -p 127.0.0.1:3002:3002 \
    "$image" >/dev/null

fail() {
    echo "Smoke test failed: $1"
    echo "--- container log ---"
    docker logs "$name" 2>&1 | tail -50
    exit 1
}

# Docker's own health check (the image's HEALTHCHECK) must report healthy within a minute.
status=starting
for _ in $(seq 1 60); do
    status=$(docker inspect -f '{{.State.Health.Status}}' "$name" 2>/dev/null || echo gone)
    [ "$status" = healthy ] && break
    [ "$status" = unhealthy ] || [ "$status" = gone ] && fail "the container is $status"
    sleep 1
done
[ "$status" = healthy ] || fail "not healthy after 60 s (status: $status)"

[ "$(curl -fsS http://127.0.0.1:3002/healthz)" = ok ] || fail "/healthz didn't answer ok"
page=$(curl -fsS http://127.0.0.1:3002/) || fail "the page didn't load"
echo "$page" | grep -q '<title>WebTS</title>' || fail "the page wasn't WebTS's"
[ "$(docker exec "$name" id -u)" = 1000 ] || fail "the container doesn't run as the node user"

echo "Smoke test passed: healthy, /healthz ok, page served, running as uid 1000"
