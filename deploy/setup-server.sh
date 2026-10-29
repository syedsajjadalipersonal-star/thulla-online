#!/bin/sh
# One-time setup of a fresh Ubuntu 24.04 server for Thulla. Run as the ubuntu user:
#   sh deploy/setup-server.sh thulla.duckdns.org
# Opens ports 80 and 443 in the host firewall (Oracle's Ubuntu images reject everything but SSH),
# installs Docker from Ubuntu's own packages, and writes .env with fresh random secrets.
# Safe to run again: it keeps an existing .env.
set -eu
domain="${1:?usage: sh deploy/setup-server.sh your-name.duckdns.org}"
cd "$(dirname "$0")/.."

sudo apt-get update -q
sudo DEBIAN_FRONTEND=noninteractive apt-get install -yq iptables-persistent git

# Oracle's images end the INPUT chain with a REJECT rule; let web traffic in ahead of it.
# Saved before Docker is installed, so Docker's own rules are not frozen into the saved set.
reject=$(sudo iptables -L INPUT --line-numbers -n | awk '$2 == "REJECT" { print $1; exit }')
for rule in "-p tcp --dport 80" "-p tcp --dport 443" "-p udp --dport 443"; do
  # shellcheck disable=SC2086
  sudo iptables -C INPUT $rule -j ACCEPT 2>/dev/null || sudo iptables -I INPUT "${reject:-1}" $rule -j ACCEPT
done
sudo netfilter-persistent save

sudo DEBIAN_FRONTEND=noninteractive apt-get install -yq docker.io docker-compose-v2
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"

if [ ! -f .env ]; then
  secret() { head -c 24 /dev/urandom | base64 | tr '+/' '-_' | tr -d '='; }
  umask 077
  cat > .env <<EOF
DOMAIN=$domain
POSTGRES_PASSWORD=$(secret)
NAKAMA_CONSOLE_USERNAME=owner
NAKAMA_CONSOLE_PASSWORD=$(secret)
BOT_SECRET=$(secret)
NAKAMA_SERVER_KEY=$(secret)
SESSION_ENCRYPTION_KEY=$(secret)
SESSION_REFRESH_ENCRYPTION_KEY=$(secret)
CONSOLE_SIGNING_KEY=$(secret)
RUNTIME_HTTP_KEY=$(secret)
EOF
  echo "Wrote .env with new secrets."
fi
echo "Setup done. Log out and back in (for the docker group), then run: sh deploy/deploy.sh"
