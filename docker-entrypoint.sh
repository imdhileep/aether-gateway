#!/bin/sh
# Volumes (Fly.io, Docker named volumes) often mount root-owned. Fix ownership
# of the SQLite directory, then drop to the unprivileged `node` user.
set -e
if [ "$(id -u)" = "0" ]; then
  mkdir -p /app/data && chown -R node:node /app/data
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi
exec "$@"
