#!/bin/sh
set -eu

image="$1"
name="ssb-pub-test-$$"

cleanup() {
  if [ "$?" -ne 0 ]; then docker logs "$name" >&2 || true; fi
  docker stop -t 15 "$name" >/dev/null 2>&1 || true
  docker rm "$name" >/dev/null 2>&1 || true
  docker volume rm "$name" >/dev/null 2>&1 || true
}
trap cleanup EXIT

start() {
  docker run -d --platform linux/amd64 --name "$name" --read-only \
    --tmpfs /tmp --tmpfs /run --volume "$name:/app/data" \
    -e CLOUDRON=1 -e CLOUDRON_APP_DOMAIN=pub.example.com "$@" "$image" >/dev/null
  tries=20
  until docker exec "$name" node -e 'fetch("http://127.0.0.1:3000/healthz").then(r => process.exit(r.status === 204 ? 0 : 1), () => process.exit(1))'; do
    tries=$((tries - 1))
    test "$tries" -gt 0
    sleep 1
  done
  docker exec "$name" sh -c 'test -s /app/data/ssb-pub/secret && stat -c %a /run/ssb-pub/admin.sock | grep -x 600'
}

stop() {
  docker stop -t 16 "$name" >/dev/null
  test "$(docker inspect --format '{{.State.ExitCode}}' "$name")" = 0
  docker rm "$name" >/dev/null
}

start
status=$(docker exec "$name" /app/code/pubctl status)
printf '%s\n' "$status" | grep -q '^wss://pub\.example\.com~shs:'
docker exec "$name" /app/code/pubctl invite | grep -q '^https://pub\.example\.com/invite?token='
docker exec "$name" sh -c '! grep -qsE ":1F48 .* 0A " /proc/net/tcp /proc/net/tcp6'
stop

docker run -d --platform linux/amd64 --name "$name" --read-only \
  --tmpfs /tmp --tmpfs /run --volume "$name:/app/data" "$image" >/dev/null
tries=20
until docker exec "$name" /app/code/pubctl status | grep -q '^ws://127\.0\.0\.1:3000~shs:'; do
  tries=$((tries - 1))
  test "$tries" -gt 0
  sleep 1
done
docker exec "$name" /app/code/pubctl invite | grep -q '^http://127\.0\.0\.1:3000/invite?token='
stop

start -e SSB_PORT=18008
tcp_status=$(docker exec "$name" /app/code/pubctl status)
printf '%s\n' "$tcp_status" | grep -q '^net:pub\.example\.com:18008~shs:'
test "$(printf '%s\n' "$tcp_status" | head -n 1)" = "$(printf '%s\n' "$status" | head -n 1)"
docker exec "$name" node -e 'const s = require("net").connect(8008, "127.0.0.1", () => s.end()); s.on("error", () => process.exit(1))'
stop
