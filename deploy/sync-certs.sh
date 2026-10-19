#!/usr/bin/env bash
#
# Copies Caddy's certificates for GAME_HOST and EXTRA_GAME_HOSTS to where the
# game server can read them. Players' browsers connect to the game server
# directly on DIRECT_PORT (wss://GAME_HOST:8443, or the extra name their page
# is on), so it needs the certificates Caddy obtains and renews for the
# website — but Caddy keeps its files readable by root alone.
# Copies only when the certificate changed; the game server notices a renewal
# and restarts itself to load it at a quiet moment. Runs every minute from cron:
#
#   (crontab -l 2>/dev/null; echo "* * * * * /opt/vmock-skribble/vckscribble-be/deploy/sync-certs.sh >> /var/log/vmock-certs.log 2>&1") | crontab -
set -euo pipefail
cd "$(dirname "$0")"

hosts=$({ grep -E '^(GAME_HOST|EXTRA_GAME_HOSTS)=' .env || true; } | cut -d= -f2- | tr -d ' "' | tr ',' ' ')
[ -n "$hosts" ] || exit 0 # direct connections not configured
dest=${CERT_DIR:-/opt/vmock-skribble/certs}
uid=1000 # the `node` user in the backend image

data=$(docker volume inspect -f '{{.Mountpoint}}' vckscribble_caddy-data 2>/dev/null) || exit 0
mkdir -p "$dest"
chown "$uid:$uid" "$dest"
chmod 700 "$dest"

for host in $hosts; do
  src=$(find "$data/caddy/certificates" -type d -name "$host" 2>/dev/null | head -1)
  [ -n "$src" ] && [ -f "$src/$host.crt" ] && [ -f "$src/$host.key" ] || continue # not issued yet
  cmp -s "$src/$host.crt" "$dest/$host.crt" && cmp -s "$src/$host.key" "$dest/$host.key" && continue

  # Key first, certificate last: the game server keys off the certificate.
  for f in key crt; do
    install -o "$uid" -g "$uid" -m 600 "$src/$host.$f" "$dest/.$host.$f.tmp"
    mv -f "$dest/.$host.$f.tmp" "$dest/$host.$f"
  done
  echo "$(date -u '+%F %T') copied certificate for $host (expires $(openssl x509 -enddate -noout -in "$dest/$host.crt" | cut -d= -f2))"
done
