#!/bin/sh
set -eu

image="$1"
name="ssb-pub-test-$$"

cleanup() {
  if [ "$?" -ne 0 ]; then docker logs "$name" >&2 || true; fi
  docker stop -t 15 "$name" >/dev/null 2>&1 || true
  docker rm "$name" >/dev/null 2>&1 || true
  docker volume rm "$name" >/dev/null 2>&1 || true
  docker volume rm "$name-backup" >/dev/null 2>&1 || true
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

backup_container() {
  docker run --rm --platform linux/amd64 --read-only --tmpfs /tmp --tmpfs /run \
    --volume "$name:/app/data" --volume "$name-backup:/cloudron-backup" "$image" "$@"
}

start
status=$(docker exec "$name" /app/code/pubctl status)
printf '%s\n' "$status" | grep -q '^wss://pub\.example\.com~shs:'
docker exec "$name" /app/code/pubctl invite | grep -q '^https://pub\.example\.com/invite?token='
docker exec "$name" sh -c 'test -s /app/data/ssb-pub/admin.sqlite && test -s /app/code/web/dm-sans.woff2'
docker exec "$name" node -e 'fetch("http://127.0.0.1:3000/admin", {redirect:"manual"}).then(r => process.exit(r.status === 303 && r.headers.get("location") === "/login?ssb-http-auth=1" ? 0 : 1), () => process.exit(1))'
docker exec "$name" sh -c '! grep -qsE ":1F48 .* 0A " /proc/net/tcp /proc/net/tcp6'
invite=$(docker exec "$name" /app/code/pubctl invite)
admin_id=$(docker exec "$name" node -p "require('ssb-keys').generate().id")
docker exec "$name" /app/code/pubctl admin "$admin_id"
for db in invites admin; do
  backup_container sqlite3 -cmd '.timeout 120000' "/app/data/ssb-pub/$db.sqlite" \
    "VACUUM INTO '/cloudron-backup/$db.db'"
  backup_container chown 1000:1000 "/cloudron-backup/$db.db"
  test "$(backup_container sqlite3 "/cloudron-backup/$db.db" 'PRAGMA integrity_check;')" = ok
done
test "$(backup_container sqlite3 /cloudron-backup/admin.db 'SELECT feed FROM admin;')" = "$admin_id"
stop

for db in invites admin; do
  # An app restored onto a new volume gets a root-owned SQLite file from cp.
  backup_container mv "/app/data/ssb-pub/$db.sqlite" "/app/data/ssb-pub/$db.original"
  backup_container cp "/cloudron-backup/$db.db" "/app/data/ssb-pub/$db.sqlite"
done

docker run -d --platform linux/amd64 --name "$name" --read-only \
  --tmpfs /tmp --tmpfs /run --volume "$name:/app/data" "$image" >/dev/null
tries=20
until docker exec "$name" /app/code/pubctl status | grep -q '^ws://127\.0\.0\.1:3000~shs:'; do
  tries=$((tries - 1))
  test "$tries" -gt 0
  sleep 1
done
docker exec "$name" /app/code/pubctl invite | grep -q '^http://127\.0\.0\.1:3000/invite?token='
docker exec "$name" node -e 'const params = new URL(process.argv[1]).searchParams; params.set("encoding", "json"); fetch("http://127.0.0.1:3000/invite?" + params).then(r => r.json()).then(r => process.exit(r.status === "successful" ? 0 : 1), () => process.exit(1))' "$invite"
docker exec "$name" sh -c 'test "$(stat -c "%u:%a" /app/data/ssb-pub/admin.sqlite)" = "1000:600"'
stop

start -e SSB_PORT=18008
tcp_status=$(docker exec "$name" /app/code/pubctl status)
printf '%s\n' "$tcp_status" | grep -q '^net:pub\.example\.com:18008~shs:'
test "$(printf '%s\n' "$tcp_status" | head -n 1)" = "$(printf '%s\n' "$status" | head -n 1)"
docker exec "$name" node -e 'const s = require("net").connect(8008, "127.0.0.1", () => s.end()); s.on("error", () => process.exit(1))'
stop
