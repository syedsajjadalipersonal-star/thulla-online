#!/bin/sh
# Nightly backup: dumps the Nakama database and uploads it to Oracle Object Storage through a
# pre-authenticated request (BACKUP_URL in .env, ending in /o/). The link can only add objects, so the
# server cannot read or delete old backups. Files are named by day of the month, so the bucket keeps
# a rolling month of backups without any cleanup.
#   sh deploy/backup.sh            (deploy/deploy.sh installs it in cron for 03:15 each night)
#
# Restore on a rebuilt server (after setup-server.sh and deploy.sh), with the file downloaded from the bucket:
#   gunzip -c thulla-DD.sql.gz | docker compose exec -T postgres psql -U postgres -d nakama
set -eu
cd "$(dirname "$0")/.."
BACKUP_URL=$(grep '^BACKUP_URL=' .env | cut -d= -f2-)
if [ -z "$BACKUP_URL" ]; then
  echo "BACKUP_URL is not set in .env; skipping backup." >&2
  exit 1
fi

file="thulla-$(date -u +%d).sql.gz"
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
docker compose exec -T postgres pg_dump -U postgres -d nakama --clean --if-exists | gzip -9 > "$tmp"
curl -fsS --retry 3 -X PUT --upload-file "$tmp" "${BACKUP_URL%/}/$file"
echo "$(date -u +%FT%TZ) uploaded $file ($(wc -c < "$tmp") bytes)"
