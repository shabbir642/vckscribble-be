#!/usr/bin/env bash
#
# One-time setup for a fresh Ubuntu 24.04 VPS that will run Drawdle.
# Safe to re-run: every step checks before it changes anything.
#
#   scp deploy/setup-server.sh root@<server-ip>:  &&  ssh root@<server-ip> bash setup-server.sh
#
# What it does: installs Docker + Compose, opens only SSH/HTTP/HTTPS in the
# firewall, adds swap (image builds need it on small servers), turns on
# automatic security updates, and creates read-only GitHub deploy keys for the
# two private repos. It prints the keys and the next commands at the end.
set -euo pipefail

APP_DIR=/opt/vmock-skribble

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this as root:  sudo bash setup-server.sh" >&2
  exit 1
fi

step() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }

step "Updating packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get upgrade -y
apt-get install -y docker.io docker-compose-v2 git ufw unattended-upgrades cron

step "Starting Docker"
systemctl enable --now docker
docker --version
docker compose version

step "Firewall: SSH, HTTP, HTTPS and the direct game port only"
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp   # HTTP/3
ufw allow 8443:8458/tcp  # direct game connections: one port per game process (up to 16 cores)
ufw --force enable
ufw status

step "Swap (2 GB) so image builds don't run out of memory"
if swapon --show | grep -q .; then
  echo "swap already on"
else
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

step "Automatic security updates"
dpkg-reconfigure -f noninteractive unattended-upgrades

step "Read-only GitHub deploy keys (one per repo — GitHub allows a key on one repo only)"
mkdir -p /root/.ssh
chmod 700 /root/.ssh
for repo in be fe; do
  key=/root/.ssh/vmock_$repo
  [ -f "$key" ] || ssh-keygen -q -t ed25519 -N '' -C "vmock-skribble-$repo@$(hostname)" -f "$key"
done
if ! grep -q 'Host github-vmock-be' /root/.ssh/config 2>/dev/null; then
  cat >> /root/.ssh/config <<'EOF'

Host github-vmock-be
  HostName github.com
  User git
  IdentityFile /root/.ssh/vmock_be
  IdentitiesOnly yes

Host github-vmock-fe
  HostName github.com
  User git
  IdentityFile /root/.ssh/vmock_fe
  IdentitiesOnly yes
EOF
fi
chmod 600 /root/.ssh/config
ssh-keyscan -t ed25519 github.com 2>/dev/null >> /root/.ssh/known_hosts
sort -u /root/.ssh/known_hosts -o /root/.ssh/known_hosts

mkdir -p "$APP_DIR"

cat <<EOF

$(printf '\033[1;32m')Server is ready.$(printf '\033[0m')

1. Add these as deploy keys (read-only, "Allow write access" OFF).
   GitHub -> repo -> Settings -> Deploy keys -> Add deploy key.

   vckscribble-be:
$(sed 's/^/     /' /root/.ssh/vmock_be.pub)

   vckscribble-fe:
$(sed 's/^/     /' /root/.ssh/vmock_fe.pub)

2. Then clone both repos side by side:

   git clone git@github-vmock-be:shabbir642/vckscribble-be.git $APP_DIR/vckscribble-be
   git clone git@github-vmock-fe:shabbir642/vckscribble-fe.git $APP_DIR/vckscribble-fe

3. Configure and start (see deploy/README.md):

   cd $APP_DIR/vckscribble-be/deploy
   cp .env.example .env && nano .env
   docker compose up -d --build
EOF
