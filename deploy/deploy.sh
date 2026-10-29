#!/bin/sh
# Updates the server to the latest main and restarts what changed. Run on the server:
#   sh deploy/deploy.sh
# Builds the Nakama module and the page inside a Node container, so the server needs only Docker.
set -eu
cd "$(dirname "$0")/.."
git pull --ff-only

set -a
. ./.env
set +a

docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -e NAKAMA_SERVER_KEY \
  -v "$PWD":/app -w /app node:24.22.1-bookworm \
  sh -c 'npm ci --no-audit --no-fund && npm run build:nakama && npm run build:web'

compose="docker compose -f docker-compose.yml -f deploy/compose.prod.yml"
$compose up -d --remove-orphans
# Nakama loads its module and the bots load their code only at start.
$compose restart nakama bots
$compose ps

# Nightly backup at 03:15 UTC, once BACKUP_URL is in .env (see deploy/backup.sh).
if grep -q '^BACKUP_URL=.' .env; then
  line="15 3 * * * sh $PWD/deploy/backup.sh >> $HOME/thulla-backup.log 2>&1"
  (crontab -l 2>/dev/null | grep -v 'deploy/backup.sh'; echo "$line") | crontab -
  echo "Nightly backup scheduled."
else
  echo "No BACKUP_URL in .env yet, so no nightly backup."
fi
