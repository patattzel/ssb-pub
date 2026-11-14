#!/bin/sh
set -eu

data=/app/data/ssb-pub
runtime=/run/ssb-pub
umask 077
export PUB_DATA_DIR="$data" PUB_ADMIN_SOCKET="$runtime/admin.sock"
export PUB_HTTP_HOST=0.0.0.0 PUB_HTTP_PORT=3000 PUB_TCP_LISTEN_PORT=8008

for dir in "$data" "$runtime"; do
  test ! -L "$dir"
  mkdir -p "$dir"
  chown node:node "$dir"
  chmod 0700 "$dir"
done

for database in invites.sqlite admin.sqlite; do
  for suffix in '' -journal -wal -shm; do
    file="$data/$database$suffix"
    test ! -L "$file"
    if [ -e "$file" ]; then
      test -f "$file"
      chown node:node "$file"
      chmod 0600 "$file"
    fi
  done
done

exec setpriv --reuid=node --regid=node --init-groups node /app/code/server.js
